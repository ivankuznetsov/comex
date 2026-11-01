import {afterEach,expect,test} from 'bun:test';
import {activateHostedWorkspace,browserOperationFor,recoverHostedOperation,rememberHostedOperation,startHostedOperation,readHostedOperation,pendingHostedOperations,forgetHostedOperation} from '../components/api';

const originalFetch=globalThis.fetch;
const originalStorage=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
function storage():Storage {
  const map=new Map<string,string>();
  return {get length(){return map.size;},clear(){map.clear();},getItem(key){return map.get(key)??null;},key(index){return [...map.keys()][index]??null;},removeItem(key){map.delete(key);},setItem(key,value){map.set(key,String(value));}};
}
function setup() {Object.defineProperty(globalThis,'localStorage',{value:storage(),configurable:true});activateHostedWorkspace('workspace-a');}
afterEach(()=>{globalThis.fetch=originalFetch;if(originalStorage)Object.defineProperty(globalThis,'localStorage',originalStorage);else delete (globalThis as {localStorage?:Storage}).localStorage;});

test('a lost enqueue response is retried with the persisted request key and exact original version',async()=>{
  setup();
  const sent:Record<string,unknown>[]=[];let fail=true;
  globalThis.fetch=(async(_url:unknown,init?:RequestInit)=>{sent.push(JSON.parse(String(init?.body)));if(fail){fail=false;throw new TypeError('connection lost');}return Response.json({id:'op-1',status:'queued',comicId:'comic'},{status:202});}) as typeof fetch;
  const input={action:'initialQuestions',comicId:'comic',expectedRevision:2,input:{}};
  await expect(startHostedOperation(input,'auto:initialQuestions:comic')).rejects.toThrow();
  expect(pendingHostedOperations('comic')).toHaveLength(1);
  const retried=await startHostedOperation({...input,expectedRevision:3},'auto:initialQuestions:comic');
  expect(retried.id).toBe('op-1');expect(sent[0]).toEqual(sent[1]);
  expect(sent[1]).toMatchObject({requestKey:'auto:initialQuestions:comic',expectedRevision:2});
});

test('polling survives reload and an unknown outcome never starts another operation',async()=>{
  setup();
  let posts=0,gets=0;
  globalThis.fetch=(async(url:unknown,init?:RequestInit)=>{if(init?.method==='POST'){posts++;return Response.json({id:'op-2',status:'queued',comicId:'comic'},{status:202});}gets++;return Response.json({id:'op-2',action:'generatePage',comicId:'comic',status:'unknown_outcome',error:'Provider outcome unknown'});}) as typeof fetch;
  const entry=await startHostedOperation({action:'generatePage',comicId:'comic',expectedRevision:4,input:{pageId:'page',intent:'generate'}},'user-key');
  expect(pendingHostedOperations('comic')[0].id).toBe(entry.id);
  const result=await readHostedOperation(pendingHostedOperations('comic')[0]);expect(result.status).toBe('unknown_outcome');
  const reloaded=pendingHostedOperations('comic')[0];expect(reloaded.status).toBe('unknown_outcome');expect(reloaded.error).toBe('Provider outcome unknown');
  await readHostedOperation(reloaded);expect(posts).toBe(1);expect(gets).toBe(2);
  forgetHostedOperation(reloaded);expect(pendingHostedOperations('comic')).toEqual([]);
});

test('hosted page intent and publication preconditions use the displayed state',()=>{
  const comic={id:'comic',revision:7,published:true,publication:{editionId:'edition-1'},pages:[{id:'page',panels:[{imageUrl:'/old.png',status:'current'},{imageUrl:null,status:'planned'}]}]};
  expect(browserOperationFor(comic,'/pages/page/generate',{},'POST')).toMatchObject({action:'generatePage',expectedRevision:7,input:{pageId:'page',intent:'resume'}});
  expect(browserOperationFor(comic,'/publish',{title:'Title',creator:'Mina'},'POST').input).toEqual({title:'Title',creator:'Mina',expectedEditionId:'edition-1'});
  expect(()=>browserOperationFor({...comic,publication:null},'/unpublish',{},'POST')).toThrow(/edition/i);
});

test('page intent follows its current generation checkpoint, not old panel images',()=>{
  const page={id:'page',generationPending:true,panels:[{imageUrl:'/old.png',status:'current'}]};
  const comic={id:'comic',revision:7,pages:[page]};
  expect(browserOperationFor(comic,'/pages/page/generate',{},'POST').input.intent).toBe('resume');
  expect(browserOperationFor({...comic,pages:[{...page,generationPending:false}]},'/pages/page/generate',{},'POST').input.intent).toBe('regenerate');
});

test('a lost acknowledgement is redacted across accounts and recovered by the original workspace key',async()=>{
  setup();let posts=0;
  globalThis.fetch=(async(url:unknown,init?:RequestInit)=>{
    if(init?.method==='POST'){posts++;throw new TypeError('connection lost');}
    expect(String(url)).toContain('requestKey=private-key');
    return Response.json({operation:{id:'op-1',action:'create',status:'unknown_outcome'}});
  }) as typeof fetch;
  const input={action:'create',input:{title:'Secret title',plot:'Secret plot',style:'ink-manga'}};
  await expect(startHostedOperation(input,'private-key')).rejects.toThrow();
  const stale=pendingHostedOperations()[0];
  activateHostedWorkspace('workspace-b');
  await expect(startHostedOperation(stale,'private-key')).rejects.toThrow(/workspace/i);
  expect(JSON.stringify([...Array(localStorage.length)].map((_,i)=>localStorage.getItem(localStorage.key(i)!)))).not.toContain('Secret');
  expect(pendingHostedOperations()).toEqual([]);
  activateHostedWorkspace('workspace-a');
  const saved=pendingHostedOperations()[0];expect(saved.redacted).toBe(true);
  const recovered=await recoverHostedOperation(saved);expect(recovered.id).toBe('op-1');expect(recovered.status).toBe('unknown_outcome');expect(posts).toBe(1);
});

test('a redacted ID-less request needs the exact input and the original key',async()=>{
  setup();let posts=0;
  globalThis.fetch=(async(_url:unknown,init?:RequestInit)=>{
    if(init?.method==='POST'){posts++;if(posts===1)throw new TypeError('connection lost');return Response.json({id:'op-1',status:'queued'});}
    return Response.json({error:'Not found'},{status:404});
  }) as typeof fetch;
  const input={action:'create',input:{title:'Original',plot:'The original plot',style:'ink-manga'}};
  await expect(startHostedOperation(input,'same-key')).rejects.toThrow();
  activateHostedWorkspace('workspace-b');activateHostedWorkspace('workspace-a');
  const saved=pendingHostedOperations()[0];
  await expect(recoverHostedOperation(saved)).rejects.toThrow(/re-enter/i);
  await expect(recoverHostedOperation(saved,{...input,input:{...input.input,plot:'Changed'}})).rejects.toThrow(/different|match/i);
  expect(posts).toBe(1);
  expect((await recoverHostedOperation(saved,input)).id).toBe('op-1');expect(posts).toBe(2);
});

test('a late enqueue response cannot restore private input after another tab switches workspace',async()=>{
  setup();let finish!:(response:Response)=>void,started!:()=>void;
  const sent=new Promise<void>(resolve=>{started=resolve;});
  globalThis.fetch=(()=>new Promise<Response>(resolve=>{finish=resolve;started();})) as unknown as typeof fetch;
  const pending=startHostedOperation({action:'create',input:{title:'Private title',plot:'Private plot'}},'late-key');
  await sent;
  activateHostedWorkspace('workspace-b');finish(Response.json({id:'late-op',status:'queued'}));
  await expect(pending).rejects.toThrow(/workspace|session/i);
  expect(JSON.stringify([...Array(localStorage.length)].map((_,i)=>localStorage.getItem(localStorage.key(i)!)))).not.toContain('Private');
});

test('reviewed story and artwork choices keep their exact versions and proposal IDs',()=>{
  const comic={id:'comic',revision:7,pages:[]};
  expect(browserOperationFor(comic,'/story/approve',{revision:7,storyRevision:3,fingerprint:'story-hash'},'POST')).toEqual({action:'approveStory',comicId:'comic',expectedRevision:7,input:{storyRevision:3,fingerprint:'story-hash'}});
  expect(browserOperationFor(comic,'/story/accept',{fingerprint:'review-hash'},'POST')).toMatchObject({action:'acceptStoryReview',input:{fingerprint:'review-hash'}});
  expect(browserOperationFor(comic,'/panels/p1/edit',{proposalId:'proposal-1',decision:'artwork_only'},'POST')).toMatchObject({action:'editPanel',input:{panelId:'p1',proposalId:'proposal-1',decision:'artwork_only'}});
  expect(browserOperationFor(comic,'/revisions',{proposalId:'revision-1'},'POST')).toMatchObject({action:'applyRevision',input:{proposalId:'revision-1'}});
});

test('an operation discovered from another client is polled by ID without enqueueing it again',async()=>{
  setup();
  let posts=0;
  globalThis.fetch=(async(_url:unknown,init?:RequestInit)=>{if(init?.method==='POST')posts++;return Response.json({id:'remote-op',action:'generatePage',comicId:'comic',status:'unknown_outcome'});}) as typeof fetch;
  const entry=rememberHostedOperation({id:'remote-op',action:'generatePage',comicId:'comic',status:'running'})!;
  expect((await readHostedOperation(entry)).status).toBe('unknown_outcome');expect(posts).toBe(0);
  expect(pendingHostedOperations('comic')[0]).toMatchObject({id:'remote-op',status:'unknown_outcome',requestKey:'discovered:remote-op'});
});

test('a deliberately retried failed operation is not redisplayed by later discovery',()=>{
  setup();
  const failure={id:'failed-op',action:'generatePage',comicId:'comic',pageId:'page',expectedRevision:4,status:'failed' as const};
  const entry=rememberHostedOperation(failure)!;expect(entry.input).toEqual({pageId:'page'});forgetHostedOperation(entry);
  expect(rememberHostedOperation(failure)).toBeNull();
});
