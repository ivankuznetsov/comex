import {expect,test} from 'bun:test';
import {mkdtemp,rm,writeFile,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {loadManifest} from '../evals/fixtures';
import {summarize, type TrialRecord} from '../evals/report';
import {runTrial,runOffline} from '../evals/runner';
import {createAIService} from '../src/lib/ai/service';

test('the distributed synthetic candidates validate offline and remain unreviewed', async () => {
  const originalFetch=globalThis.fetch; let calls=0;
  globalThis.fetch=(async()=>{calls++;throw new Error('Offline evaluation must not fetch');}) as unknown as typeof fetch;
  try {
    const manifest=await loadManifest('evals/fixtures/synthetic/manifest.json','.');
    expect(manifest.cases.every(item=>!item.reviewed)).toBe(true);
    expect(new Set(manifest.cases.filter(c=>c.kind==='routing').flatMap(c=>c.checks.map(x=>x.label)))).toEqual(new Set(['restore','story','cosmetic','clarify']));
    expect(new Set(manifest.cases.filter(c=>c.kind==='visual').flatMap(c=>c.checks.map(x=>x.label)))).toEqual(new Set(['match','mismatch','cannot_determine']));
    expect(new Set(manifest.cases.map(c=>c.split))).toEqual(new Set(['calibration','holdout']));
    const report=await runOffline('evals/fixtures/synthetic/manifest.json','.');
    expect(report.cases).toBe(manifest.cases.length);expect(report.unreviewed).toBe(manifest.cases.length);
    expect(calls).toBe(0);
  } finally {globalThis.fetch=originalFetch;}
});

test('Responses observation retains only sanitized metadata and cannot change the result', async () => {
  let observed:unknown;
  const service=createAIService({apiKey:'test',observeResponse:value=>{observed=value;throw new Error('observer failure');},fetch:async()=>Response.json({model:'test-model',usage:{input_tokens:10,output_tokens:2,secret:'private',input_tokens_details:{cached_tokens:3,private:'data'}},status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify({intent:'restore',reason:'as intended',question:null})}]}]})});
  const result=await service.classifyEditContextual({instruction:'Turn it off',panel:{},bible:{},characters:[],references:[{id:'p1',role:'target panel',mimeType:'image/png',bytes:new Uint8Array([1])}]});
  expect(result.intent).toBe('restore');
  expect((observed as {usage:unknown}).usage).toEqual({input_tokens:10,output_tokens:2,input_tokens_details:{cached_tokens:3}});
});

test('fixture validation checks hashes and holds out whole scene families', async () => {
  const dir=await mkdtemp(join(tmpdir(),'comex-eval-'));
  try {
    const bytes=Buffer.from('fixture image'); await writeFile(join(dir,'panel.png'),bytes);
    const hash=createHash('sha256').update(bytes).digest('hex');
    const item={id:'route-1',kind:'routing',split:'calibration',family:'tower',reviewed:false,rationale:'Image differs from the intended scene.',images:[{file:'panel.png',sha256:hash,role:'target panel',id:'p1'}],evidence:{instruction:'Turn it off',panel:{action:'Dark'},bible:{},characters:[],styleRules:'ink'},checks:[{name:'route',question:'Classify the request.',dimension:'story',label:'restore'}]};
    const path=join(dir,'manifest.json');await writeFile(path,JSON.stringify({version:1,cases:[item]}));
    expect((await loadManifest(path,dir)).cases).toHaveLength(1);
    await writeFile(path,JSON.stringify({version:1,cases:[item,{...item,id:'route-2',split:'holdout'}]}));
    await expect(loadManifest(path,dir)).rejects.toThrow('family');
    await writeFile(path,JSON.stringify({version:1,cases:[item,{...item,id:'route-2',family:'other',split:'holdout'}]}));
    await expect(loadManifest(path,dir)).rejects.toThrow('Target image');
    await writeFile(path,JSON.stringify({version:1,cases:[{...item,images:[{...item.images[0],sha256:'0'.repeat(64)}]}]}));
    await expect(loadManifest(path,dir)).rejects.toThrow('hash');
    await writeFile(path,JSON.stringify({version:1,cases:[{...item,evidence:{...item.evidence,panel:{label:'restore'}}}]}));
    await expect(loadManifest(path,dir)).rejects.toThrow('label');
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('live evaluation refuses unreviewed cases and uses the dedicated budget for both arms', async () => {
  const dir=await mkdtemp(join(tmpdir(),'comex-eval-run-'));const previous=process.env.COMEX_MAX_PROVIDER_CALLS,priorDb=process.env.COMEX_DB_PATH;
  try {
    const bytes=Buffer.from('local image');await writeFile(join(dir,'panel.png'),bytes);const hash=createHash('sha256').update(bytes).digest('hex');
    const fixture={id:'one',kind:'routing',split:'calibration',family:'tower',reviewed:false,rationale:'private label rationale',images:[{file:'panel.png',sha256:hash,role:'target panel',id:'p1'}],evidence:{instruction:'Turn it off',panel:{action:'Dark'},bible:{},characters:[],styleRules:'ink'},checks:[{name:'route',question:'Classify the request.',dimension:'story',label:'restore'}]};
    const path=join(dir,'manifest.json');await writeFile(path,JSON.stringify({version:1,cases:[fixture]}));const manifest=await loadManifest(path,dir);
    let calls=0;const bodies:string[]=[];
    const fetcher=async(url:string|URL|Request,init?:RequestInit)=>{calls++;bodies.push(String(init?.body));
      if(String(url).endsWith('/decisions')) return Response.json({model:'gpt-6-luna',usage:{input_tokens:10,output_tokens:0},answers:[{type:'choice',name:'route',choice:'restore',confidence:0.9,probabilities:[{value:'cosmetic',probability:0.02},{value:'restore',probability:0.9},{value:'story',probability:0.05},{value:'clarify',probability:0.03}]}]});
      return Response.json({model:'responses-test',usage:{input_tokens:8,output_tokens:2},status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({intent:'restore',reason:'As planned',question:null})}]}]});
    };
    await expect(runTrial(manifest,dir,{apiKey:'test',budgetDb:join(dir,'trial.sqlite'),fetch:fetcher})).rejects.toThrow('reviewed');expect(calls).toBe(0);
    manifest.cases[0].reviewed=true;
    delete process.env.COMEX_MAX_PROVIDER_CALLS;
    await expect(runTrial(manifest,dir,{apiKey:'test',budgetDb:join(dir,'trial.sqlite'),fetch:fetcher})).rejects.toThrow('finite');
    process.env.COMEX_MAX_PROVIDER_CALLS='unlimited';
    await expect(runTrial(manifest,dir,{apiKey:'test',budgetDb:join(dir,'trial.sqlite'),fetch:fetcher})).rejects.toThrow('finite');expect(calls).toBe(0);
    process.env.COMEX_MAX_PROVIDER_CALLS='2';
    const appDb=join(dir,'app.sqlite'),alias=join(dir,'alias.sqlite');await writeFile(appDb,'existing app data');await symlink(appDb,alias);process.env.COMEX_DB_PATH=appDb;
    await expect(runTrial(manifest,dir,{apiKey:'test',budgetDb:alias,fetch:fetcher})).rejects.toThrow('separate');expect(calls).toBe(0);
    process.env.COMEX_DB_PATH=`file:${appDb}`;await expect(runTrial(manifest,dir,{apiKey:'test',budgetDb:appDb,fetch:fetcher})).rejects.toThrow('URIs');expect(calls).toBe(0);process.env.COMEX_DB_PATH=appDb;
    const result=await runTrial(manifest,dir,{apiKey:'test',budgetDb:join(dir,'trial.sqlite'),fetch:fetcher});
    expect(result.complete).toBe(true);expect(calls).toBe(2);expect(result.records.map(r=>r.prediction)).toEqual(['restore','restore']);
    expect(bodies.every(body=>!body.includes('private label rationale') && !body.includes('"label"'))).toBe(true);
    expect(result.records[0].usage).toEqual({input_tokens:8,output_tokens:2});
    await writeFile(join(dir,'panel.png'),'changed');
    await expect(runTrial(manifest,dir,{apiKey:'test',budgetDb:join(dir,'second.sqlite'),fetch:fetcher})).rejects.toThrow('hash');expect(calls).toBe(2);
  } finally {if(previous===undefined) delete process.env.COMEX_MAX_PROVIDER_CALLS;else process.env.COMEX_MAX_PROVIDER_CALLS=previous;if(priorDb===undefined)delete process.env.COMEX_DB_PATH;else process.env.COMEX_DB_PATH=priorDb;await rm(dir,{recursive:true,force:true});}
});

test('focused visual comparison uses equivalent evidence and retains usage on refusals', async () => {
  const dir=await mkdtemp(join(tmpdir(),'comex-eval-visual-'));const previous=process.env.COMEX_MAX_PROVIDER_CALLS;
  try {
    const bytes=Buffer.from('panel');await writeFile(join(dir,'panel.png'),bytes);const hash=createHash('sha256').update(bytes).digest('hex');
    const item={id:'visual',kind:'visual',split:'holdout',family:'tower',reviewed:true,rationale:'Inspected',images:[{file:'panel.png',sha256:hash,role:'generated panel',id:'p1'}],evidence:{panel:{action:'key in latch'},bible:{rules:['use the latch']},characters:[{id:'pip',name:'Pip',role:'bird',appearance:'brass',outfit:'scarf'}],styleRules:'ink'},checks:[{name:'key',question:'Is the key in the latch?',dimension:'story',label:'mismatch'}]};
    const path=join(dir,'manifest.json');await writeFile(path,JSON.stringify({version:1,cases:[item]}));const manifest=await loadManifest(path,dir);process.env.COMEX_MAX_PROVIDER_CALLS='4';
    let refusal=true;let baseline:any,candidate:any;
    const fetcher=async(url:string|URL|Request,init?:RequestInit)=>{
      const body=JSON.parse(String(init?.body));
      if(String(url).endsWith('/decisions')) {candidate=JSON.parse(body.input[0].content[0].text);return Response.json({model:'gpt-6-luna',usage:{input_tokens:12,output_tokens:0},answers:[{type:'choice',name:'key',choice:'mismatch',confidence:0.9,probabilities:[{value:'match',probability:0.05},{value:'mismatch',probability:0.9},{value:'cannot_determine',probability:0.05}]}]});}
      baseline=JSON.parse(body.input[1].content[0].text);
      if(refusal)return Response.json({model:'responses-test',usage:{input_tokens:7,output_tokens:1},status:'completed',output:[{type:'message',content:[{type:'refusal'}]}]});
      return Response.json({model:'responses-test',usage:{input_tokens:7,output_tokens:1},status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({outcome:'findings',findings:[{severity:'blocker',dimension:'story',panel_id:'p1',character_id:null,reference_id:null,expected:'key in latch',observed:'key elsewhere',repair:'fix'}]})}]}]});
    };
    const failed=await runTrial(manifest,dir,{apiKey:'test',budgetDb:join(dir,'one.sqlite'),fetch:fetcher});
    expect(failed.complete).toBe(false);expect(failed.records[0].status).toBe('refusal');expect(failed.records[0].usage).toEqual({input_tokens:7,output_tokens:1});expect(failed.records[0].model).toBe('responses-test');
    refusal=false;const compared=await runTrial(manifest,dir,{apiKey:'test',budgetDb:join(dir,'two.sqlite'),fetch:fetcher});
    expect(compared.complete).toBe(true);expect(compared.records.map(r=>r.prediction)).toEqual(['mismatch','mismatch']);
    expect(candidate.panel).toEqual(baseline.beats);expect(candidate.bible).toEqual(baseline.bible);expect(candidate.characters).toEqual(baseline.characters);expect(candidate.styleRules).toEqual(baseline.styleRules);expect(candidate.reference_manifest).toEqual(baseline.reference_manifest);
    expect(baseline.focus.question).toBe(item.checks[0].question);
  } finally {if(previous===undefined)delete process.env.COMEX_MAX_PROVIDER_CALLS;else process.env.COMEX_MAX_PROVIDER_CALLS=previous;await rm(dir,{recursive:true,force:true});}
});

test('report separates unsafe routing, visual misses, abstentions, failures and unknown cost', () => {
  const record=(patch:Partial<TrialRecord>):TrialRecord=>({caseId:'a',check:'route',kind:'routing',split:'holdout',evaluator:'decisions',expected:'story',prediction:'cosmetic',status:'ok',latencyMs:10,usage:null,model:'gpt-6-luna',...patch});
  const report=summarize([
    record({}),record({caseId:'b',kind:'visual',expected:'mismatch',prediction:'match'}),
    record({caseId:'c',kind:'visual',expected:'cannot_determine',prediction:'cannot_determine'}),
    record({caseId:'e',kind:'visual',expected:'cannot_determine',prediction:'match'}),
    record({caseId:'d',status:'error',prediction:null}),
  ],{});
  const result=report.evaluators.decisions;
  expect(result.unsafeStoryToImage).toBe(1);expect(result.visualFalseNegatives).toBe(1);
  expect(result.abstentions).toBe(1);expect(result.failures).toBe(1);expect(result.estimatedCost).toBeNull();
  expect(result.visualConfidentOnIndeterminate).toBe(1);expect(result.visualConfusion.cannot_determine.match).toBe(1);
  expect(result.routingConfusion.story.cosmetic).toBe(1);
});

test('cost is not counted twice for batched answers', () => {
  const base:TrialRecord={caseId:'x',check:'one',kind:'visual',split:'holdout',evaluator:'decisions',expected:'match',prediction:'match',status:'ok',latencyMs:10,usage:{input_tokens:100,output_tokens:0,input_tokens_details:{cached_tokens:20,cache_write_tokens:10}},model:'gpt-6-luna',requestId:'one-request'};
  const result=summarize([base,{...base,check:'two'}],{'gpt-6-luna':{input:1,cached:0.1,cacheWrite:1.2,output:0}}).evaluators.decisions;
  expect(result.estimatedCost).toBeCloseTo(0.000084,10);
});
