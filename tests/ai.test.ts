import { describe, expect, test } from 'bun:test';
import { createAIService, AIError } from '../src/lib/ai/service';

describe('OpenAI adapter', () => {
  test('requires a key before issuing a request', async () => {
    let calls = 0;
    const ai = createAIService({apiKey:'', fetch: async () => { calls++; throw new Error('unexpected'); }});
    expect(ai.questions({plot:'A bird',style:'ink',answers:{},limit:3})).rejects.toThrow('OPENAI_API_KEY');
    expect(calls).toBe(0);
  });
  test('uses structured output and validates tailored questions', async () => {
    let request: any;
    const ai = createAIService({apiKey:'test', textModel:'gpt-6.1-terra', fetch: async (_url, init) => {
      request = JSON.parse(String(init?.body));
      return Response.json({status:'completed', output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({questions:[{id:'q1',question:'Where?',suggested_answer:'London'}]})}]}]});
    }});
    const result = await ai.questions({plot:'A bird',style:'ink',answers:{},limit:3});
    expect(result).toEqual([{id:'q1',question:'Where?',suggestedAnswer:'London'}]);
    expect(request.model).toBe('gpt-6.1-terra');
    expect(request.reasoning).toEqual({effort:'medium'});
    expect(request.text.format.type).toBe('json_schema');
    expect(request.text.format.strict).toBe(true);
    expect(request.input[1].content).toContain('A bird');
  });
  test('refusals and invalid structured output are inconclusive errors', async () => {
    const refusal = createAIService({apiKey:'test',fetch:async () => Response.json({status:'completed',output:[{type:'message',content:[{type:'refusal',refusal:'No'}]}]})});
    expect(refusal.questions({plot:'x',style:'ink',answers:{},limit:1})).rejects.toThrow('refused');
    const invalid = createAIService({apiKey:'test',fetch:async () => Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'{"questions":"oops"}'}]}]})});
    expect(invalid.questions({plot:'x',style:'ink',answers:{},limit:1})).rejects.toThrow('invalid');
  });
  test('reference-guided panel attaches ordered images and disables retries', async () => {
    let calls=0; let body: FormData | undefined;
    const ai = createAIService({apiKey:'test',fetch:async (_url,init) => { calls++; body=init?.body as FormData; return Response.json({data:[{b64_json:Buffer.from('image').toString('base64')}]}); }});
    const bytes=await ai.panel({styleRules:'ink',panelSpec:'Mina runs',sceneBefore:'station',characters:[{id:'mina',name:'Mina',role:'courier',appearance:'red hair',outfit:'coat'}],references:[{role:'approved character',id:'mina',bytes:new Uint8Array([1,2]),mimeType:'image/png'}]});
    expect(bytes.toString()).toBe('image'); expect(calls).toBe(1);
    expect(body?.getAll('image[]')).toHaveLength(1); expect(String(body?.get('prompt'))).toContain('mina');
    expect(ai.panel({styleRules:'ink',panelSpec:'x',sceneBefore:'x',characters:[],references:[]})).rejects.toThrow('reference');
  });
  test('a provider timeout is surfaced as unknown outcome with no retry', async () => {
    let calls=0;
    const ai=createAIService({apiKey:'test',fetch:async()=>{calls++;throw new Error('network');}});
    try { await ai.characterReference({character:{id:'x',name:'X',role:'hero',appearance:'hair',outfit:'coat'},styleRules:'ink'}); throw new Error('expected failure'); }
    catch(error) { expect(error).toBeInstanceOf(AIError); expect((error as AIError).code).toBe('unknown_outcome'); }
    expect(calls).toBe(1);
  });
  test('storyboard output keeps supplied characters and expected panel order', async () => {
    const state={location:'station',time:'day',props:[],outfits:[],injuries:[],knowledge:[]};
    const panel={id:'p1',index:1,character_ids:['mina'],action:'Mina arrives',framing:'wide',dialogue:[],state_before:state,state_after:state};
    const payload={bible:{premise:'delivery',setting:'station',rules:[],character_ids:['mina']},pages:[{index:1,panels:[panel]}]};
    const ai=createAIService({apiKey:'test',fetch:async()=>Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(payload)}]}]})});
    const input={plot:'delivery',answers:{},styleRules:'ink',characters:[{id:'mina',name:'Mina',role:'courier',appearance:'red hair',outfit:'coat'}],pageCount:1,panelsPerPage:1};
    expect((await ai.storyboard(input)).pages[0].panels[0].id).toBe('p1');
    panel.character_ids=['intruder'];
    expect(ai.storyboard(input)).rejects.toThrow('IDs or ordering');
  });
  test('editing requires target image first', async () => {
    const ai=createAIService({apiKey:'test'});
    expect(ai.editPanel({change:'light',preserve:'pose',references:[{role:'approved character',id:'mina',bytes:new Uint8Array([1]),mimeType:'image/png'}]})).rejects.toThrow('first');
  });

  test('narrative judge reports localized findings as evidence', async () => {
    const result={outcome:'findings',findings:[{severity:'blocker',dimension:'story',panel_id:'p2',character_id:null,reference_id:null,expected:'Mina has the key',observed:'Pip has it',repair:'Revise the transfer'}]};
    const ai=createAIService({apiKey:'test',fetch:async()=>Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(result)}]}]})});
    expect((await ai.narrativeJudge({creatorGoal:'Deliver the key',answers:{},bible:{},beats:[]})).findings[0].panel_id).toBe('p2');
  });
  test('visual judge sends separately identified images as data', async () => {
    let request: any;
    const ai=createAIService({apiKey:'test',fetch:async(_url,init)=>{request=JSON.parse(String(init?.body));return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'{"outcome":"inconclusive","findings":[]}'}]}]});}});
    const result=await ai.visualJudge({bible:{},styleRules:'ink',beats:[],references:[{role:'panel',id:'p1',bytes:new Uint8Array([1,2]),mimeType:'image/png'}]});
    expect(result.outcome).toBe('inconclusive');
    expect(request.input[1].content[0].text).toContain('p1');
    expect(request.input[1].content[1].type).toBe('input_image');
  });

  test('classifies artwork and fails closed on ambiguous model output', async () => {
    let value: unknown = {intent:'story',reason:'The key changes hands.'};
    const ai=createAIService({apiKey:'test',fetch:async()=>Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]})});
    expect((await ai.classifyEdit({instruction:'Give Pip the key',panelContext:'Mina holds the key'})).intent).toBe('story');
    value={intent:'safe',reason:'yes'};
    expect(ai.classifyEdit({instruction:'change it',panelContext:'scene'})).rejects.toThrow('invalid');
  });
  test('revisions preserve the prefix and reject altered suffix IDs', async () => {
    const state={location:'station',time:'day',props:[],outfits:[],injuries:[],knowledge:[]};
    const p1={id:'p1',index:1,character_ids:['mina'],action:'Mina arrives',framing:'wide',dialogue:[],state_before:state,state_after:state};
    const p2={...p1,id:'p2',index:2,action:'Mina leaves'};
    const bible={premise:'delivery',setting:'station',rules:[],character_ids:['mina']};
    const storyboard={bible,pages:[{index:1,panels:[p1,p2]}]};
    const result={earliest_affected_panel_id:'p2',explanation:'The later action changes.',revised_bible:bible,revised_suffix:[{...p2,action:'Mina stays'}]};
    let body: any;
    const ai=createAIService({apiKey:'test',fetch:async (_url,init)=>{ body=JSON.parse(String(init?.body)); return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(result)}]}]}); }});
    const input={storyboard,firstPanelId:'p2',instruction:'Mina stays',characters:[{id:'mina',name:'Mina',role:'courier',appearance:'red hair',outfit:'coat'}]};
    expect((await ai.revision(input)).revised_suffix[0].action).toBe('Mina stays');
    const payload=JSON.parse(body.input[1].content);
    expect(payload.frozen_prefix_panel_ids).toEqual(['p1']);
    expect(payload.frozen_prefix).toBeUndefined();
    expect(payload.current_beats_and_states[0].panels[0].action).toBe('Mina arrives');
    expect(storyboard.pages[0].panels[0].action).toBe('Mina arrives');
    result.revised_suffix[0].id='invented';
    expect(ai.revision(input)).rejects.toThrow('suffix');
  });
  test('revisions permit earlier affected panels but never a later starting point', async () => {
    const state={location:'station',time:'day',props:[],outfits:[],injuries:[],knowledge:[]};
    const panel=(id:string,index:number)=>({id,index,character_ids:['mina'],action:id,framing:'wide',dialogue:[],state_before:state,state_after:state});
    const bible={premise:'delivery',setting:'station',rules:[],character_ids:['mina']};
    const storyboard={bible,pages:[{index:1,panels:[panel('p1',1),panel('p2',2),panel('p3',3)]}]};
    const result={earliest_affected_panel_id:'p1',explanation:'Earlier setup changed',revised_bible:bible,revised_suffix:storyboard.pages[0].panels};
    const ai=createAIService({apiKey:'test',fetch:async()=>Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(result)}]}]})});
    const input={storyboard,firstPanelId:'p2',instruction:'change setup',characters:[{id:'mina',name:'Mina',role:'courier',appearance:'red hair',outfit:'coat'}]};
    expect((await ai.revision(input)).earliest_affected_panel_id).toBe('p1');
    result.earliest_affected_panel_id='p3'; result.revised_suffix=[panel('p3',3)];
    expect(ai.revision(input)).rejects.toThrow('start');
  });

});

test('a rejected pre-dispatch budget is not treated as an uncertain provider call', async () => {
  const {BudgetError} = await import('../src/lib/budget');
  const ai = createAIService({apiKey:'test', fetch:async () => { throw new BudgetError('budget_not_configured', 'Budget is not configured'); }});
  await expect(ai.questions({plot:'A bird',style:'ink',answers:{},limit:1})).rejects.toBeInstanceOf(BudgetError);
});

test('exposes a safe provider error code for rate limit diagnostics', async () => {
  const ai = createAIService({apiKey:'test', fetch:async () => Response.json({error:{code:'insufficient_quota',message:'private details'}},{status:429})});
  try { await ai.questions({plot:'A bird',style:'ink',answers:{},limit:1}); throw new Error('Expected provider failure'); }
  catch (error) { expect(error).toBeInstanceOf(AIError); expect((error as Error).message).toContain('insufficient_quota'); expect((error as Error).message).not.toContain('private details'); }
});

test('a lost or invalid image response body remains an unknown paid reservation', async () => {
  const {mkdtempSync,rmSync} = await import('node:fs');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const {createBudgetedFetch,ProviderBudget} = await import('../src/lib/budget');
  for (const body of ['lost', 'invalid-json', 'invalid-image']) {
    const dir=mkdtempSync(join(tmpdir(),'comex-body-')); const path=join(dir,'budget.sqlite'); let calls=0;
    const config={maxCalls:3,maxConcurrent:1};
    const fetch=createBudgetedFetch(path,async()=>{
      calls++;
      if (body === 'lost') return new Response(new ReadableStream({start(controller){controller.error(new Error('lost body'));}}),{status:200});
      return new Response(body === 'invalid-json' ? '{' : '{"data":[]}',{status:200});
    },config);
    const ai=createAIService({apiKey:'test',fetch});
    const input={character:{id:'x',name:'X',role:'hero',appearance:'hair',outfit:'coat'},styleRules:'ink'};
    await expect(ai.characterReference(input)).rejects.toMatchObject({code:'unknown_outcome'});
    const b=new ProviderBudget(path,config); expect(b.summary()).toEqual({used:1,active:1,unknown:1}); b.close();
    await expect(ai.characterReference(input)).rejects.toMatchObject({code:'concurrency_limit'});
    expect(calls).toBe(1); rmSync(dir,{recursive:true,force:true});
  }
});

test('structured response validation happens before releasing the paid reservation', async () => {
  const {mkdtempSync,rmSync} = await import('node:fs');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const {createBudgetedFetch,ProviderBudget} = await import('../src/lib/budget');
  const dir=mkdtempSync(join(tmpdir(),'comex-text-body-')); const path=join(dir,'budget.sqlite');
  const config={maxCalls:3,maxConcurrent:1}; let calls=0;
  const fetch=createBudgetedFetch(path,async()=>{calls++; return Response.json({status:'completed',output:[{content:[{type:'output_text',text:'not JSON'}]}]});},config);
  const ai=createAIService({apiKey:'test',fetch}); const input={plot:'bird',style:'ink',answers:{},limit:1};
  await expect(ai.questions(input)).rejects.toMatchObject({code:'unknown_outcome'});
  await expect(ai.questions(input)).rejects.toMatchObject({code:'concurrency_limit'});
  const b=new ProviderBudget(path,config); expect(b.summary()).toEqual({used:1,active:1,unknown:1}); b.close();
  expect(calls).toBe(1); rmSync(dir,{recursive:true,force:true});
});
