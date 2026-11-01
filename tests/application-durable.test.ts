import {describe,expect,test} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {LocalStore} from '../src/lib/local-store';
import {AIError} from '../src/lib/ai/service';
import {BudgetError} from '../src/lib/budget';
import {createComic} from '../src/lib/domain/comic';
import {createComicService} from '../src/lib/application/comics';
import {pageIntentMatches,type Draft} from '../src/lib/application/contracts';

class Crash extends Error {}
const owner='creator', creation={title:'The courier',plot:'A courier carries a key',style:'ink-manga'};
const png=Buffer.from('89504e470d0a1a0a000000','hex');
const state={location:'town',time:'day',props:[],outfits:[],injuries:[],knowledge:[]};
const spec=(id:string,index:number)=>({id,index,character_ids:['mina'],action:`Beat ${id}`,framing:'wide',dialogue:[],state_before:state,state_after:state});
const storyboard={bible:{premise:'Delivery',setting:'Town',rules:[],character_ids:['mina']},pages:[{index:1,panels:[spec('p1',1),spec('p2',2)]}]};
test('an interrupted regeneration with old images resumes before a new regeneration',()=>{
  const draft={storyRevision:1,pages:[{id:'page',panels:[{id:'p1',assetId:'old',storyRevision:1,status:'current'}]}],pageOperations:{page:{storyRevision:1,baseline:{p1:1}}}} as unknown as Draft;
  expect(pageIntentMatches(draft,'page','resume')).toBe(true);
  expect(pageIntentMatches(draft,'page','regenerate')).toBe(false);
  draft.pageOperations={};
  expect(pageIntentMatches(draft,'page','resume')).toBe(false);
  expect(pageIntentMatches(draft,'page','regenerate')).toBe(true);
});
function fixture(overrides:Record<string,unknown>={},useDurable=true,id:()=>string=randomUUID) {
  const local=new LocalStore(':memory:'), files=new Map<string,Buffer>(), paid=new Map<string,unknown>(), checkpoints=new Map<string,unknown>(), imageIds=new Map<string,string>();
  const calls:string[]=[],usedFetch:unknown[]=[],lockOwners=new Map<string,string>();let crash='',budgetFailure='',revoked='',operationToken=randomUUID();
  const fetchMarker=async()=>{throw new Error('unexpected fetch');};
  const assets={async read(id:string){const bytes=files.get(id);if(!bytes)throw new Error('missing image');return bytes;},async save(bytes:Buffer){const id=randomUUID();files.set(id,bytes);return id;},async discard(id:string){files.delete(id);}};
  const provider=({fetch}:{fetch:unknown})=>{usedFetch.push(fetch);return {
    async questions(){calls.push('questions');return [{id:'provider',question:'Who gets the key?',suggestedAnswer:'Her brother'}];},
    async characterSuggestions(){calls.push('suggestions');return [{name:'Mina',role:'courier',appearance:'hair',outfit:'coat'}];},
    async characterReference(){calls.push('reference');return png;},
    async panel(){calls.push('panel');return png;},
    async editPanel(){calls.push('edit');return png;},
    async visualJudge(){calls.push('visual');return {outcome:'pass',findings:[]};},
    ...overrides,
  } as any;};
  const transaction=new Proxy(local,{get(target,key){
    if(key==='reserveTextOperation')return (id:string,actor:string,revision:number)=>{const ok=target.reserveTextOperation(id,actor,revision);if(ok)lockOwners.set(id,operationToken);return ok;};
    if(key==='finishTextOperation')return (id:string,actor:string,unknown:boolean)=>{if(lockOwners.get(id)!==operationToken)return;target.finishTextOperation(id,actor,unknown);if(!unknown)lockOwners.delete(id);};
    if(key==='resumeTextOperation')return (id:string,actor:string)=>{if(lockOwners.get(id)!==operationToken)return false;const db=(target as any).db;return Number(db.prepare("UPDATE comic_text_operations SET state='running' WHERE comic_id=? AND owner=? AND state='unknown'").run(id,actor).changes)===1;};
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
  const durable={
    async load(key:string){return checkpoints.has(key)?structuredClone(checkpoints.get(key)):null;},
    async checkpoint(key:string,work:(repository:any)=>Promise<unknown>){if(checkpoints.has(key))return structuredClone(checkpoints.get(key));const value=await work(transaction);const json=JSON.parse(JSON.stringify(value));checkpoints.set(key,json);if(crash===`checkpoint:${key}`){crash='';throw new Crash(key);}return structuredClone(json);},
    async paid(step:{id:string;input:unknown;expectedRevision:number},invoke:(fetch:typeof fetchMarker)=>Promise<unknown>){if(paid.has(step.id)){const value=paid.get(step.id);if(value instanceof Error)throw value;return value;}if(budgetFailure===step.id)throw new BudgetError('budget_exhausted','Budget exhausted');if(revoked===step.id)throw new Error('The connection was revoked or expired.');const value=await invoke(fetchMarker);paid.set(step.id,value);if(Buffer.isBuffer(value))imageIds.set(step.id,await assets.save(value));if(crash===`paid:${step.id}`){crash='';throw new Crash(step.id);}return value;},
    async assetIdFor(id:string){return imageIds.get(id)??null;},
    async stepState(id:string){return paid.has(id) ? paid.get(id) instanceof Error ? 'failed' : 'completed' : 'unknown';},
  };
  const service=createComicService({repository:local,assets,provider,budgetFetch:async()=>{throw new Error('local budget fetch used');},id,...(useDurable?{durable}:{})} as any);
  return {local,service,durable,calls,files,checkpoints,paid,usedFetch,fetchMarker,crashAt:(value:string)=>{crash=value;},failBudgetAt:(value:string)=>{budgetFailure=value;},revokeAt:(value:string)=>{revoked=value;},reset:()=>{paid.clear();checkpoints.clear();imageIds.clear();crash='';budgetFailure='';revoked='';operationToken=randomUUID();},replaceTextLockOwner:(id:string)=>{lockOwners.set(id,randomUUID());},completeImage:async(step:string)=>{paid.set(step,png);imageIds.set(step,await assets.save(png));}};
}
async function planned(f:ReturnType<typeof fixture>) {
  const id=(await f.service.create(owner,creation)).comic.id,record=f.local.getOwned<any>(id,owner)!,draft=createComic({id,ownerId:owner,title:creation.title,creatorName:'',plot:creation.plot,styleId:creation.style,pages:[{id:'page1',panels:[{id:'p1',beat:'Beat p1'},{id:'p2',beat:'Beat p2'}]}]});
  const ref=randomUUID();f.files.set(ref,png);f.local.update(id,owner,record.revision,{...record.data,...draft,storyboard,storyReview:{outcome:'pass',findings:[]},characters:[{id:'mina',name:'Mina',role:'courier',appearance:'hair',outfit:'coat',approved:true,referenceAssetId:ref}]});
  const view=(await f.service.get(owner,id)).comic;await f.service.approveStory(owner,id,{revision:view.revision,storyRevision:view.storyRevision,fingerprint:view.storyApproval!.fingerprint});return id;
}

describe('durable comic phases',()=>{
  test('local and durable workflows persist identical questions, answers, refresh results and suggestions',async()=>{
    const ids=()=>{let n=0;return ()=>`00000000-0000-4000-8000-${String(++n).padStart(12,'0')}`;};
    const questions=()=>{let turn=0;return async()=>++turn===1?[{id:'provider-one',question:'Who gets the key?',suggestedAnswer:'Her brother'},{id:'provider-two',question:'Where is it?',suggestedAnswer:'At the dock'}]:[{id:'duplicate',question:'Who gets the key?',suggestedAnswer:'Ignored duplicate'},{id:'new',question:'Why now?',suggestedAnswer:'The tide is rising'}];};
    const suggestions=async()=>[{name:'Mina',role:'courier',appearance:'hair',outfit:'coat'},{name:'MINA',role:'duplicate',appearance:'hair',outfit:'coat'}];
    const local=fixture({questions:questions(),characterSuggestions:suggestions},false,ids()),durable=fixture({questions:questions(),characterSuggestions:suggestions},true,ids());
    async function run(f:ReturnType<typeof fixture>) {
      const id=(await f.service.create(owner,creation)).comic.id,first=(await f.service.initialQuestions(owner,id)).comic;
      await f.service.update(owner,id,{answers:{[first.questions[0].id]:'Her brother'}});
      const refreshed=(await f.service.refreshQuestions(owner,id)).comic,suggested=(await f.service.suggestCharacters(owner,id)).comic;
      return {questions:refreshed.questions,answers:refreshed.answers,initialQuestions:refreshed.initialQuestions,suggestions:suggested.characterSuggestions,initialSuggestions:suggested.initialSuggestions};
    }
    try {const browser=await run(local),worker=await run(durable);expect(worker).toEqual(browser);expect(worker.questions.map(q=>[q.question,q.suggestedAnswer])).toEqual([['Who gets the key?','Her brother'],['Why now?','The tide is rising']]);expect(worker.suggestions).toHaveLength(1);}finally{local.local.close();durable.local.close();}
  });
  test('local and durable paths preserve explicit story and panel blocker choices',async()=>{
    const finding={severity:'blocker',dimension:'continuity',panel_id:'p1',character_id:null,reference_id:null,expected:'key',observed:'missing',repair:'fix'};
    const judge=async()=>({outcome:'findings',findings:[finding]});
    const browser=fixture({visualJudge:judge},false),worker=fixture({visualJudge:judge},true);
    async function run(f:ReturnType<typeof fixture>,isDurable:boolean) {
      const id=await planned(f),record=f.local.getOwned<any>(id,owner)!;f.local.update(id,owner,record.revision,{...record.data,storyReview:{outcome:'findings',findings:[finding]}});
      await expect(f.service.generatePage(owner,id,'page1',isDurable?{intent:'generate'}:{})).rejects.toMatchObject({code:'conflict'});
      const review=(await f.service.get(owner,id)).comic.storyReview!;expect(review.accepted).toBe(false);
      const accepted=(await f.service.acceptStoryReview(owner,id,{fingerprint:review.fingerprint})).comic;expect(accepted.storyReview?.accepted).toBe(true);
      const page=await f.service.generatePage(owner,id,'page1',isDurable?{intent:'generate'}:{}),panel=page.comic.pages[0].panels[0];
      expect(panel.evaluation).toBe('blocker');expect(page.notice).toMatch(/paused/i);
      const after=(await f.service.acceptPanel(owner,id,'p1',panel.reviewVersion!)).comic;expect(after.pages[0].panels[0].accepted).toBe(true);
      return {evaluation:panel.evaluation,outcome:panel.reviewOutcome,accepted:after.pages[0].panels[0].accepted,choices:page.comic.nextActions};
    }
    try{expect(await run(worker,true)).toEqual(await run(browser,false));}finally{browser.local.close();worker.local.close();}
  });
  test('a crash after paid initial questions resumes the same output and original revision',async()=>{
    const f=fixture();try {
      const id=(await f.service.create(owner,creation)).comic.id,revision=f.local.getOwned(id,owner)!.revision;
      f.crashAt('paid:initial/questions');await expect(f.service.initialQuestions(owner,id,{},revision)).rejects.toBeInstanceOf(Crash);
      const result=await f.service.initialQuestions(owner,id,{},revision);
      expect(result.comic.initialQuestions).toBe('complete');expect(result.comic.questions[0]).toMatchObject({question:'Who gets the key?',suggestedAnswer:'Her brother'});
      expect(f.calls).toEqual(['questions']);expect(f.usedFetch).toEqual([f.fetchMarker]);
      expect(JSON.stringify([...f.checkpoints])).not.toContain('89504e47');
    }finally{f.local.close();}
  });
  test('a crash after saving questions replays the committed checkpoint',async()=>{
    const f=fixture();try {
      const id=(await f.service.create(owner,creation)).comic.id,revision=f.local.getOwned(id,owner)!.revision;
      f.crashAt('checkpoint:initial/completed');await expect(f.service.initialQuestions(owner,id,{},revision)).rejects.toBeInstanceOf(Crash);
      expect((await f.service.initialQuestions(owner,id,{},revision)).comic.initialQuestions).toBe('complete');expect(f.calls).toEqual(['questions']);
    }finally{f.local.close();}
  });
  test('a denied budget releases the question lock and leaves a retryable failure',async()=>{
    const f=fixture();try {
      const id=(await f.service.create(owner,creation)).comic.id,revision=f.local.getOwned(id,owner)!.revision;
      f.failBudgetAt('initial/questions');await expect(f.service.initialQuestions(owner,id,{},revision)).rejects.toMatchObject({code:'budget_exhausted'});
      const saved=f.local.getOwned<any>(id,owner)!;expect(saved.data.initialQuestions).toBe('failed');expect(f.local.reserveTextOperation(id,owner,saved.revision)).toBe(true);f.local.finishTextOperation(id,owner,false);
    }finally{f.local.close();}
  });
  test('a resolved unknown question resumes its own text lock without a second provider call',async()=>{
    let calls=0;const f=fixture({async questions(){calls++;throw new AIError('unknown_outcome','Unknown questions');}});try {
      const id=(await f.service.create(owner,creation)).comic.id,revision=f.local.getOwned(id,owner)!.revision;
      await expect(f.service.initialQuestions(owner,id,{},revision)).rejects.toMatchObject({code:'unknown_outcome'});expect(f.local.getOwned<any>(id,owner)!.data.initialQuestions).toBe('unknown');
      f.paid.set('initial/questions',[{id:'resolved',question:'Who gets the key?',suggestedAnswer:'Her brother'}]);
      const result=await f.service.initialQuestions(owner,id,{},revision);expect(result.comic.initialQuestions).toBe('complete');expect(result.comic.questions[0].suggestedAnswer).toBe('Her brother');expect(calls).toBe(1);
      const saved=f.local.getOwned(id,owner)!;expect(f.local.reserveTextOperation(id,owner,saved.revision)).toBe(true);f.local.finishTextOperation(id,owner,false);
    }finally{f.local.close();}
  });
  test('an older operation cannot resume another operation’s unknown text lock',async()=>{
    const f=fixture({async questions(){throw new AIError('unknown_outcome','Unknown questions');}});try {
      const id=(await f.service.create(owner,creation)).comic.id,revision=f.local.getOwned(id,owner)!.revision;await expect(f.service.initialQuestions(owner,id,{},revision)).rejects.toMatchObject({code:'unknown_outcome'});
      f.paid.set('initial/questions',[{id:'resolved',question:'Who?',suggestedAnswer:'Mina'}]);f.replaceTextLockOwner(id);
      await expect(f.service.initialQuestions(owner,id,{},revision)).rejects.toMatchObject({code:'conflict'});expect(f.local.getOwned<any>(id,owner)!.data.initialQuestions).toBe('unknown');
    }finally{f.local.close();}
  });
  test('an older operation cannot change another operation’s running text marker',async()=>{
    const f=fixture({async questions(){throw new AIError('unknown_outcome','Unknown questions');}});try {
      const id=(await f.service.create(owner,creation)).comic.id,revision=f.local.getOwned(id,owner)!.revision;await expect(f.service.initialQuestions(owner,id,{},revision)).rejects.toMatchObject({code:'unknown_outcome'});
      f.replaceTextLockOwner(id);const saved=f.local.getOwned<any>(id,owner)!;f.local.update(id,owner,saved.revision,{...saved.data,initialQuestions:'running'});
      await expect(f.service.initialQuestions(owner,id,{},revision)).rejects.toMatchObject({code:'conflict'});expect(f.local.getOwned<any>(id,owner)!.data.initialQuestions).toBe('running');
    }finally{f.local.close();}
  });
  test('connection revocation releases a pending text lock',async()=>{
    const f=fixture();try {const id=(await f.service.create(owner,creation)).comic.id,revision=f.local.getOwned(id,owner)!.revision;f.revokeAt('initial/questions');
      await expect(f.service.initialQuestions(owner,id,{},revision)).rejects.toThrow('connection was revoked');const saved=f.local.getOwned<any>(id,owner)!;
      expect(saved.data.initialQuestions).toBe('failed');expect(f.local.reserveTextOperation(id,owner,saved.revision)).toBe(true);f.local.finishTextOperation(id,owner,false);
    }finally{f.local.close();}
  });
  test('a changed story after paid questions cannot be overwritten during replay',async()=>{
    const f=fixture();try {
      const id=(await f.service.create(owner,creation)).comic.id,revision=f.local.getOwned(id,owner)!.revision;
      f.crashAt('paid:initial/questions');await expect(f.service.initialQuestions(owner,id,{},revision)).rejects.toBeInstanceOf(Crash);
      await f.service.update(owner,id,{plot:'Another plot'});
      await expect(f.service.initialQuestions(owner,id,{},revision)).rejects.toMatchObject({code:'conflict'});
      expect((await f.service.get(owner,id)).comic.plot).toBe('Another plot');expect(f.calls).toEqual(['questions']);
    }finally{f.local.close();}
  });
  test('refresh and suggestion replays preserve the answered question and suggested answer',async()=>{
    let questionCalls=0,suggestionCalls=0;
    const f=fixture({async questions(){questionCalls++;return questionCalls===1?[{id:'first',question:'Who gets the key?',suggestedAnswer:'Her brother'}]:[{id:'second',question:'Why now?',suggestedAnswer:'The tide is rising'}];},async characterSuggestions(){suggestionCalls++;return [{name:'Mina',role:'courier',appearance:'hair',outfit:'coat'}];}});try {
      const id=(await f.service.create(owner,creation)).comic.id,first=(await f.service.initialQuestions(owner,id)).comic;await f.service.update(owner,id,{answers:{[first.questions[0].id]:'Her brother'}});
      f.reset();let revision=f.local.getOwned(id,owner)!.revision;f.crashAt('paid:refresh/questions');await expect(f.service.refreshQuestions(owner,id,{},revision)).rejects.toBeInstanceOf(Crash);
      const refreshed=(await f.service.refreshQuestions(owner,id,{},revision)).comic;expect(refreshed.answers[first.questions[0].id]).toBe('Her brother');expect(refreshed.questions.map(q=>q.suggestedAnswer)).toEqual(['Her brother','The tide is rising']);
      f.reset();revision=f.local.getOwned(id,owner)!.revision;f.crashAt('paid:suggestions');await expect(f.service.suggestCharacters(owner,id,{},revision)).rejects.toBeInstanceOf(Crash);
      expect((await f.service.suggestCharacters(owner,id,{},revision)).comic.characterSuggestions[0].name).toBe('Mina');expect(questionCalls).toBe(2);expect(suggestionCalls).toBe(1);
    }finally{f.local.close();}
  });
  test('resolved unknown refresh cannot overwrite questions after the story changed',async()=>{
    let calls=0;const f=fixture({async questions(){calls++;if(calls===1)return [{id:'first',question:'Who gets the key?',suggestedAnswer:'Her brother'}];throw new AIError('unknown_outcome','Unknown refresh');}});try {
      const id=(await f.service.create(owner,creation)).comic.id,first=(await f.service.initialQuestions(owner,id)).comic;
      f.reset();const revision=f.local.getOwned(id,owner)!.revision;
      await expect(f.service.refreshQuestions(owner,id,{},revision)).rejects.toMatchObject({code:'unknown_outcome'});
      await f.service.update(owner,id,{plot:'A different story'});
      f.paid.set('refresh/questions',[{id:'resolved',question:'Old question?',suggestedAnswer:'Old answer'}]);
      await expect(f.service.refreshQuestions(owner,id,{},revision)).rejects.toMatchObject({code:'conflict'});
      const current=(await f.service.get(owner,id)).comic;expect(current.plot).toBe('A different story');expect(current.questions).toEqual(first.questions);expect(calls).toBe(2);
    }finally{f.local.close();}
  });
  test('story planning replays its saved storyboard and judge without extra calls',async()=>{
    const f=fixture({async storyboard(){f.calls.push('storyboard');return storyboard;},async narrativeJudge(){f.calls.push('narrative');return {outcome:'pass',findings:[]};}});try {
      const id=(await f.service.create(owner,creation)).comic.id,card=(await f.service.addCharacter(owner,id,{name:'Mina',role:'courier',appearance:'hair',outfit:'coat'})).comic.characters[0],record=f.local.getOwned<any>(id,owner)!,reference=randomUUID();
      f.files.set(reference,png);f.local.update(id,owner,record.revision,{...record.data,characters:[{...record.data.characters[0],approved:true,referenceAssetId:reference}]});
      const revision=f.local.getOwned(id,owner)!.revision;f.crashAt('paid:story/narrative');await expect(f.service.planStory(owner,id,{},revision)).rejects.toBeInstanceOf(Crash);
      const result=await f.service.planStory(owner,id,{},revision);expect(result.comic.storyboard?.pages[0].panels[0].id).toBe('p1');expect(f.calls).toEqual(['storyboard','narrative']);
      expect(card.name).toBe('Mina');
    }finally{f.local.close();}
  });
  test('a crashed image step reuses its privately persisted asset for reference association',async()=>{
    const f=fixture();try {
      const id=(await f.service.create(owner,creation)).comic.id,card=(await f.service.addCharacter(owner,id,{name:'Mina',role:'courier',appearance:'hair',outfit:'coat'})).comic.characters[0],revision=f.local.getOwned(id,owner)!.revision;
      const step=`character/${card.id}/reference`;f.crashAt(`paid:${step}`);await expect(f.service.generateReference(owner,id,card.id,{},revision)).rejects.toBeInstanceOf(Crash);
      const result=await f.service.generateReference(owner,id,card.id,{},revision),reference=result.comic.characters[0].referenceVersion;
      expect(reference).toBe(await f.durable.assetIdFor(step));expect(f.files.has(reference!)).toBe(true);expect(f.calls).toEqual(['reference']);
    }finally{f.local.close();}
  });
  test('a resolved unknown reference resumes only its own marker',async()=>{
    let calls=0;const f=fixture({async characterReference(){calls++;throw new AIError('unknown_outcome','Unknown image');}});try {
      const id=(await f.service.create(owner,creation)).comic.id,card=(await f.service.addCharacter(owner,id,{name:'Mina',role:'courier',appearance:'hair',outfit:'coat'})).comic.characters[0],revision=f.local.getOwned(id,owner)!.revision,step=`character/${card.id}/reference`;
      await expect(f.service.generateReference(owner,id,card.id,{},revision)).rejects.toMatchObject({code:'unknown_outcome'});expect(f.local.getOwned<any>(id,owner)!.data.operations[`character:${card.id}`]).toBe('unknown_outcome');
      await f.completeImage(step);const result=await f.service.generateReference(owner,id,card.id,{},revision);expect(result.comic.characters[0].referenceVersion).toBe(await f.durable.assetIdFor(step));expect(calls).toBe(1);
      expect(f.local.getOwned<any>(id,owner)!.data.operations[`character:${card.id}`]).toBeUndefined();
    }finally{f.local.close();}
  });
  test('a reference resolved as failed clears its own marker without another provider call',async()=>{
    let calls=0;const f=fixture({async characterReference(){calls++;throw new AIError('unknown_outcome','Unknown image');}});try {
      const id=(await f.service.create(owner,creation)).comic.id,card=(await f.service.addCharacter(owner,id,{name:'Mina',role:'courier',appearance:'hair',outfit:'coat'})).comic.characters[0],revision=f.local.getOwned(id,owner)!.revision,step=`character/${card.id}/reference`;
      await expect(f.service.generateReference(owner,id,card.id,{},revision)).rejects.toMatchObject({code:'unknown_outcome'});
      f.paid.set(step,new AIError('provider_error','Known failure'));
      await expect(f.service.generateReference(owner,id,card.id,{},revision)).rejects.toMatchObject({code:'provider_error'});
      expect(f.local.getOwned<any>(id,owner)!.data.operations[`character:${card.id}`]).toBeUndefined();expect(calls).toBe(1);
    }finally{f.local.close();}
  });
  test('an older reference operation cannot clear another operation’s unknown marker',async()=>{
    const f=fixture({async characterReference(){throw new AIError('unknown_outcome','Unknown image');}});try {
      const id=(await f.service.create(owner,creation)).comic.id,card=(await f.service.addCharacter(owner,id,{name:'Mina',role:'courier',appearance:'hair',outfit:'coat'})).comic.characters[0],revision=f.local.getOwned(id,owner)!.revision,step=`character/${card.id}/reference`,op=`character:${card.id}`;
      await expect(f.service.generateReference(owner,id,card.id,{},revision)).rejects.toMatchObject({code:'unknown_outcome'});await f.completeImage(step);
      const saved=f.local.getOwned<any>(id,owner)!,replacement=randomUUID();f.local.update(id,owner,saved.revision,{...saved.data,durableOperationMarkers:{...saved.data.durableOperationMarkers,[op]:replacement}});
      await expect(f.service.generateReference(owner,id,card.id,{},revision)).rejects.toMatchObject({code:'conflict'});expect(f.local.getOwned<any>(id,owner)!.data.durableOperationMarkers[op]).toBe(replacement);
    }finally{f.local.close();}
  });
  test('a resolved unknown panel image resumes without another image call',async()=>{
    let calls=0;const f=fixture({async panel(){calls++;throw new AIError('unknown_outcome','Unknown panel');}});try {
      const id=await planned(f),revision=f.local.getOwned(id,owner)!.revision;await expect(f.service.generatePage(owner,id,'page1',{intent:'generate'},revision)).rejects.toMatchObject({code:'unknown_outcome'});
      await f.completeImage('panel/p1/image');await f.completeImage('panel/p2/image');const result=await f.service.generatePage(owner,id,'page1',{intent:'generate'},revision);
      expect(result.comic.pages[0].panels.every(p=>!!p.imageUrl)).toBe(true);expect(calls).toBe(1);expect(f.local.getOwned<any>(id,owner)!.data.operations?.['panel:p1']).toBeUndefined();
    }finally{f.local.close();}
  });
  test('a panel image resolved as failed clears its own marker without another provider call',async()=>{
    let calls=0;const f=fixture({async panel(){calls++;throw new AIError('unknown_outcome','Unknown panel');}});try {
      const id=await planned(f),revision=f.local.getOwned(id,owner)!.revision;
      await expect(f.service.generatePage(owner,id,'page1',{intent:'generate'},revision)).rejects.toMatchObject({code:'unknown_outcome'});
      f.paid.set('panel/p1/image',new AIError('provider_error','Known failure'));
      await expect(f.service.generatePage(owner,id,'page1',{intent:'generate'},revision)).rejects.toMatchObject({code:'provider_error'});
      expect(f.local.getOwned<any>(id,owner)!.data.operations?.['panel:p1']).toBeUndefined();expect(calls).toBe(1);
    }finally{f.local.close();}
  });
  test('page replay resumes a completed image and review without regenerating earlier panels',async()=>{
    const f=fixture();try {
      const id=await planned(f),revision=f.local.getOwned(id,owner)!.revision;
      f.crashAt('paid:panel/p1/visual-review');await expect(f.service.generatePage(owner,id,'page1',{intent:'generate'},revision)).rejects.toBeInstanceOf(Crash);
      const result=await f.service.generatePage(owner,id,'page1',{intent:'generate'},revision);
      expect(result.comic.pages[0].panels.every(panel=>!!panel.imageUrl)).toBe(true);
      expect(f.calls).toEqual(['panel','visual','panel','visual']);
    }finally{f.local.close();}
  });
  test('an edit classification and explicit artwork choice survive crashes',async()=>{
    const f=fixture({async classifyEdit(){f.calls.push('classify');return {intent:'uncertain',reason:'The scene is ambiguous'};}});try {
      const id=await planned(f);await f.service.generatePage(owner,id,'page1',{intent:'generate'});f.reset();
      const panel=(await f.service.get(owner,id)).comic.pages[0].panels[0],revision=f.local.getOwned(id,owner)!.revision;
      const input={...panel.reviewVersion!,instruction:'Change the lighting'};f.crashAt('paid:panel/p1/classify');await expect(f.service.editPanel(owner,id,'p1',input,revision)).rejects.toBeInstanceOf(Crash);
      const decision=(await f.service.editPanel(owner,id,'p1',input,revision)).editDecision!;expect(decision.choices).toEqual(['preview_story','artwork_only']);expect(f.calls.filter(c=>c==='classify')).toHaveLength(1);
      f.reset();const nextRevision=f.local.getOwned(id,owner)!.revision;f.crashAt('checkpoint:edit/p1/decision-cleared');
      await expect(f.service.editPanel(owner,id,'p1',{proposalId:decision.proposalId!,decision:'artwork_only'},nextRevision)).rejects.toBeInstanceOf(Crash);
      const result=await f.service.editPanel(owner,id,'p1',{proposalId:decision.proposalId!,decision:'artwork_only'},nextRevision);expect(result.comic?.pages[0].panels[0].imageUrl).toBeTruthy();expect(f.calls.filter(c=>c==='edit')).toHaveLength(1);
    }finally{f.local.close();}
  });
  test('a replayed edit decision rejects a panel replaced after classification',async()=>{
    const f=fixture({async classifyEdit(){return {intent:'uncertain',reason:'Ambiguous'};}});try {
      const id=await planned(f);await f.service.generatePage(owner,id,'page1',{intent:'generate'});f.reset();
      const panel=(await f.service.get(owner,id)).comic.pages[0].panels[0],revision=f.local.getOwned(id,owner)!.revision,input={...panel.reviewVersion!,instruction:'Change lighting'};
      f.crashAt('checkpoint:edit/p1/classified');await expect(f.service.editPanel(owner,id,'p1',input,revision)).rejects.toBeInstanceOf(Crash);
      const record=f.local.getOwned<any>(id,owner)!,pages=record.data.pages.map((page:any)=>({...page,panels:page.panels.map((p:any)=>p.id==='p1'?{...p,assetId:randomUUID(),revision:p.revision+1}:p)}));f.local.update(id,owner,record.revision,{...record.data,pages});
      await expect(f.service.editPanel(owner,id,'p1',input,revision)).rejects.toMatchObject({code:'conflict'});
    }finally{f.local.close();}
  });
  test('a new resume operation continues after the creator accepts a blocker',async()=>{
    const blocker={severity:'blocker',dimension:'continuity',panel_id:'p1',character_id:null,reference_id:null,expected:'key',observed:'missing',repair:'fix'};let reviews=0;
    const f=fixture({async visualJudge(){f.calls.push('visual');reviews++;return reviews===1?{outcome:'findings',findings:[blocker]}:{outcome:'pass',findings:[]};}});try {
      const id=await planned(f),first=await f.service.generatePage(owner,id,'page1',{intent:'generate'}),panel=first.comic.pages[0].panels[0];
      expect(first.notice).toMatch(/paused/i);await f.service.acceptPanel(owner,id,'p1',panel.reviewVersion!);f.reset();
      const continued=await f.service.generatePage(owner,id,'page1',{intent:'resume'},f.local.getOwned(id,owner)!.revision);
      expect(continued.comic.pages[0].panels[0].accepted).toBe(true);expect(continued.comic.pages[0].panels[1].imageUrl).toBeTruthy();expect(f.calls.filter(c=>c==='panel')).toHaveLength(2);
    }finally{f.local.close();}
  });
  test('a changed rendered panel is never adopted by page replay',async()=>{
    const f=fixture();try {
      const id=await planned(f),revision=f.local.getOwned(id,owner)!.revision;f.crashAt('checkpoint:panel/p1/reviewed');
      await expect(f.service.generatePage(owner,id,'page1',{intent:'generate'},revision)).rejects.toBeInstanceOf(Crash);
      const record=f.local.getOwned<any>(id,owner)!,pages=record.data.pages.map((page:any)=>({...page,panels:page.panels.map((p:any)=>p.id==='p1'?{...p,assetId:randomUUID(),revision:p.revision+1}:p)}));
      f.local.update(id,owner,record.revision,{...record.data,pages});
      await expect(f.service.generatePage(owner,id,'page1',{intent:'generate'},revision)).rejects.toMatchObject({code:'conflict'});expect(f.calls.filter(c=>c==='panel')).toHaveLength(1);
    }finally{f.local.close();}
  });
  test('a replayed revision preview reports when another edit made it stale',async()=>{
    const f=fixture({async revision(){return {earliest_affected_panel_id:'p2',explanation:'Keep the key',revised_bible:storyboard.bible,revised_suffix:[{...spec('p2',2),action:'Keep the key'}]};}});try {
      const id=await planned(f),revision=f.local.getOwned(id,owner)!.revision,first=(await f.service.previewRevision(owner,id,{panelId:'p2',instruction:'Keep the key'},revision)).proposal;
      await f.service.update(owner,id,{title:'Changed title'});const repeated=(await f.service.previewRevision(owner,id,{panelId:'p2',instruction:'Keep the key'},revision)).proposal;
      expect(repeated.id).toBe(first.id);expect(repeated.current).toBe(false);
    }finally{f.local.close();}
  });
  test('revision application resumes after the proposal has been cleared',async()=>{
    const blocker={severity:'blocker',dimension:'story',panel_id:'p2',character_id:null,reference_id:null,expected:'key',observed:'missing',repair:'fix'};
    const f=fixture({async revision(){f.calls.push('revision');return {earliest_affected_panel_id:'p2',explanation:'Keep the key',revised_bible:storyboard.bible,revised_suffix:[{...spec('p2',2),action:'Keep the key'}]};},async narrativeJudge(){f.calls.push('narrative');return {outcome:'findings',findings:[blocker]};}});try {
      const id=await planned(f),before=f.local.getOwned(id,owner)!.revision;
      f.crashAt('paid:revision/p2/preview');await expect(f.service.previewRevision(owner,id,{panelId:'p2',instruction:'Keep the key'},before)).rejects.toBeInstanceOf(Crash);
      const preview=(await f.service.previewRevision(owner,id,{panelId:'p2',instruction:'Keep the key'},before)).proposal,revision=f.local.getOwned(id,owner)!.revision;
      f.crashAt(`checkpoint:revision/${preview.id}/applied`);await expect(f.service.applyRevision(owner,id,{proposalId:preview.id},revision)).rejects.toBeInstanceOf(Crash);
      expect(f.local.getOwned<any>(id,owner)!.data.pendingRevision).toBeUndefined();
      const result=await f.service.applyRevision(owner,id,{proposalId:preview.id},revision);expect(result.comic.storyRevision).toBe(2);expect(result.comic.storyReview?.accepted).toBe(false);
      expect(f.calls).toEqual(['revision','narrative']);
    }finally{f.local.close();}
  });
  test('revocation before visual review keeps the image and stops before another panel',async()=>{
    const f=fixture();try {const id=await planned(f),revision=f.local.getOwned(id,owner)!.revision;f.revokeAt('panel/p1/visual-review');
      await expect(f.service.generatePage(owner,id,'page1',{intent:'generate'},revision)).rejects.toThrow('connection was revoked');
      const panel=f.local.getOwned<any>(id,owner)!.data.pages[0].panels[0];expect(panel.assetId).toBeTruthy();expect(f.files.has(panel.assetId)).toBe(true);expect(panel.status).toBe('needs_review');expect(f.calls.filter(c=>c==='panel')).toHaveLength(1);
    }finally{f.local.close();}
  });
  test('a resolved visual-review result clears its unknown marker without another provider call',async()=>{
    let calls=0;const f=fixture({async visualJudge(){calls++;throw new AIError('unknown_outcome','Review outcome is unknown.');}});try {
      const id=await planned(f),revision=f.local.getOwned(id,owner)!.revision;await expect(f.service.generatePage(owner,id,'page1',{intent:'generate'},revision)).rejects.toMatchObject({code:'unknown_outcome'});
      f.paid.set('panel/p1/visual-review',{outcome:'pass',findings:[]});f.paid.set('panel/p2/visual-review',{outcome:'pass',findings:[]});
      const resumed=await f.service.generatePage(owner,id,'page1',{intent:'generate'},revision);expect(resumed.comic.pages[0].panels[0].imageUrl).toBeTruthy();
      expect(f.local.getOwned<any>(id,owner)!.data.operations?.['panel:p1']).toBeUndefined();expect(calls).toBe(1);
    }finally{f.local.close();}
  });
  test('a resolved review cannot clear another operation’s unknown marker',async()=>{
    const f=fixture({async visualJudge(){throw new AIError('unknown_outcome','Unknown review');}});try {
      const id=await planned(f),revision=f.local.getOwned(id,owner)!.revision;await expect(f.service.generatePage(owner,id,'page1',{intent:'generate'},revision)).rejects.toMatchObject({code:'unknown_outcome'});
      f.paid.set('panel/p1/visual-review',{outcome:'pass',findings:[]});const saved=f.local.getOwned<any>(id,owner)!,replacement=randomUUID();f.local.update(id,owner,saved.revision,{...saved.data,durableOperationMarkers:{...saved.data.durableOperationMarkers,'panel:p1':replacement}});
      await expect(f.service.generatePage(owner,id,'page1',{intent:'generate'},revision)).rejects.toMatchObject({code:'conflict'});expect(f.local.getOwned<any>(id,owner)!.data.durableOperationMarkers['panel:p1']).toBe(replacement);
    }finally{f.local.close();}
  });
  test('an unknown visual review preserves the image and propagates uncertainty',async()=>{
    const f=fixture({async visualJudge(){throw new AIError('unknown_outcome','Review outcome is unknown.');}});try {
      const id=await planned(f),revision=f.local.getOwned(id,owner)!.revision;
      await expect(f.service.generatePage(owner,id,'page1',{intent:'generate'},revision)).rejects.toMatchObject({code:'unknown_outcome'});
      const panel=f.local.getOwned<any>(id,owner)!.data.pages[0].panels[0];expect(panel.assetId).toBeTruthy();expect(f.files.has(panel.assetId)).toBe(true);expect(panel.status).toBe('checking');
    }finally{f.local.close();}
  });
});
