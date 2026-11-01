import {expect,test} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {Pool,type PoolClient} from 'pg';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {createComicService} from '../src/lib/application/comics';
import type {ComicDependencies,Draft} from '../src/lib/application/contracts';
import {PostgresAssets,type PrivateObjects} from '../src/lib/storage/assets';
import {applyMigrations} from '../src/lib/storage/postgres';
import {PostgresOperationCoordinator,type MutationAction,type OperationIdentity} from '../src/lib/operations/coordinator';
import {PostgresComicExecutor,type DurableContext} from '../src/lib/operations/executor';
import {PostgresOperationRepository} from '../src/lib/operations/postgres';
import {readOwnedExport} from '../src/lib/operations/atomic-executor';
import {createHostedBackend} from '../src/lib/hosted-api';
import {createMcpReads} from '../src/lib/mcp/reads';
import {createComexMcpHandler} from '../src/lib/mcp/server';
import type {OperationRepository,WorkerLease,TransactionWork,TransactionPolicy,Json} from '../src/lib/operations/contracts';

const pgTest=process.env.TEST_DATABASE_URL?test:test.skip;
const owner='owner',otherOwner='other-owner';
const identity:OperationIdentity={actor:owner,grantId:'grant',scopes:['comex:read','comex:write','comex:generate','comex:publish']};
const otherIdentity:OperationIdentity={actor:otherOwner,grantId:'other-grant',scopes:['comex:read','comex:write','comex:generate','comex:publish']};
const creation={title:'The courier',plot:'A courier carries a key',style:'ink-manga'};
const card={name:'Mina',role:'courier',appearance:'dark hair',outfit:'red coat'};
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJX8AAAAASUVORK5CYII=','base64');
const state={location:'town',time:'day',props:[],outfits:[],injuries:[],knowledge:[]};
const wrap=(value:unknown)=>Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]});

type Pause={reached:Promise<void>; release:()=>void};
function pause() {
  let reached!:()=>void,release!:()=>void;
  return {reached:new Promise<void>(r=>{reached=r;}),wait:new Promise<void>(r=>{release=r;}),signal:()=>reached(),release:()=>release()};
}
class FakeProvider {
  readonly calls:string[]=[];
  unknownOnce:string|undefined;
  paused?:{name:string;gate:ReturnType<typeof pause>};
  async fetch(url:string|URL|Request,init?:RequestInit):Promise<Response> {
    const target=typeof url==='string'?url:url instanceof URL?url.href:url.url;
    if(!target.startsWith('https://api.openai.com/v1/'))throw new Error('Unexpected provider URL.');
    let name:string,body:any;
    if(target.endsWith('/responses')) {
      body=JSON.parse(String(init?.body));name=body.text.format.name;
    } else if(target.endsWith('/images/generations'))name='character_reference';
    else if(target.endsWith('/images/edits'))name='panel_image';
    else throw new Error('Unexpected provider endpoint.');
    this.calls.push(name);
    if(this.paused?.name===name){const gate=this.paused.gate;this.paused=undefined;gate.signal();await gate.wait;}
    if(this.unknownOnce===name){this.unknownOnce=undefined;throw new Error('Simulated lost response');}
    if(name==='character_reference'||name==='panel_image')return Response.json({data:[{b64_json:png.toString('base64')}]});
    if(name==='narrative_questions')return wrap({questions:[{id:'provider-question',question:'Who receives the key?',suggested_answer:'Her brother'}]});
    if(name==='character_suggestions')return wrap({characters:[card]});
    if(name==='narrative_judgment'||name==='visual_judgment')return wrap({outcome:'pass',findings:[]});
    if(name==='storyboard') {
      const input=JSON.parse(body.input[1].content),ids=input.characters.map((c:{id:string})=>c.id);
      const pages=Array.from({length:input.pageCount},(_,p)=>({index:p+1,panels:Array.from({length:input.panelsPerPage},(_,i)=>({id:`panel-${p+1}-${i+1}`,index:i+1,character_ids:ids,action:`Beat ${p+1}.${i+1}`,framing:'wide',dialogue:[],state_before:state,state_after:state}))}));
      return wrap({bible:{premise:'Delivery',setting:'Town',rules:[],character_ids:ids},pages});
    }
    throw new Error(`Unexpected structured response type: ${name}`);
  }
}

async function fixture() {
  const schema=`comex_real_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});
  try {
    await applyMigrations(pool);
    for(const [user,session,grant,actor] of [['user','session','grant',owner],['other-user','other-session','other-grant',otherOwner]]) {
      await pool.query('INSERT INTO "user"(id,name,email,"emailVerified") VALUES ($1,$2,$3,true)',[user,user,`${user}@example.test`]);
      await pool.query('INSERT INTO "session"(id,token,"userId","expiresAt","updatedAt") VALUES ($1,$2,$3,now()+interval \'1 hour\',now())',[session,`${session}-token`,user]);
      await pool.query('INSERT INTO mcp_grants(id,owner,client_id,session_id,user_id,client_name,created_at) VALUES ($1,$2,$3,$4,$5,$6,1)',[grant,actor,'client',session,user,'Test client']);
    }
    const files=new Map<string,Buffer>();
    const objects:PrivateObjects={put:async(path,bytes)=>{files.set(path,Buffer.from(bytes));return path;},read:async(path)=>{const bytes=files.get(path);if(!bytes)throw new Error('Missing private object');return Buffer.from(bytes);},delete:async(path)=>{files.delete(path);}};
    const assets=new PostgresAssets(pool,objects),repo=new PostgresOperationRepository(pool,{maxCalls:30,maxConcurrent:1}),provider=new FakeProvider();
    const coordinator=new PostgresOperationCoordinator(pool,repo);
    let gate:{key:string;once:boolean;control:ReturnType<typeof pause>}|undefined;
    const intercepted=new Proxy(repo,{get(target,key){
      const value=Reflect.get(target,key,target);
      if(key==='runCheckpoint')return async(lease:WorkerLease,checkpointKey:string,work:TransactionWork<PoolClient>,beforeLock?:TransactionPolicy<PoolClient>)=>{
        if(gate?.key===checkpointKey&&!gate.once){gate.once=true;gate.control.signal();await gate.control.wait;}
        return target.runCheckpoint(lease,checkpointKey,work,beforeLock);
      };
      return typeof value==='function'?value.bind(target):value;
    }}) as OperationRepository<PoolClient>;
    const adapter={kind:'comex-durable-service-v1' as const,create:(deps:ComicDependencies,durable:DurableContext)=>createComicService({...deps,durable})};
    const executor=new PostgresComicExecutor(pool,intercepted,objects,assets,adapter,provider.fetch.bind(provider));
    let nextKey=0;
    async function comic(id:string){const row=(await pool.query('SELECT revision,draft FROM comics WHERE id=$1 AND owner=$2',[id,owner])).rows[0];if(!row)throw new Error('Fixture comic not found');return {revision:row.revision as number,draft:row.draft as Draft};}
    async function enqueue(action:MutationAction,input:Record<string,unknown>={},comicId?:string,requestKey=`request-${++nextKey}`) {
      const expectedRevision=comicId?(await comic(comicId)).revision:undefined;
      return coordinator.enqueue({identity,action,requestKey,...(comicId?{comicId,expectedRevision}:{}),input});
    }
    async function execute(action:MutationAction,input:Record<string,unknown>={},comicId?:string) {
      const ticket=await enqueue(action,input,comicId);await executor.execute(ticket.id);
      const op=await repo.getOwned(owner,ticket.id);expect(op).toMatchObject({status:'succeeded'});return {ticket,op:op!};
    }
    function gateCheckpoint(key:string):Pause {const control=pause();gate={key,once:false,control};return {reached:control.reached,release:control.release};}
    async function waitUntilReached(gate:Pause,job:Promise<void>) {
      let timer:ReturnType<typeof setTimeout>|undefined;
      try {await Promise.race([gate.reached,job.then(()=>{throw new Error('Operation finished before the requested checkpoint');}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Timed out waiting for checkpoint')),15000);})]);}
      finally {if(timer)clearTimeout(timer);}
    }
    async function close(){await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
    return {pool,repo,coordinator,provider,executor,assets,objects,files,comic,enqueue,execute,gateCheckpoint,waitUntilReached,close};
  } catch(error){await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();throw error;}
}

async function runWithFixture(run:(h:Awaited<ReturnType<typeof fixture>>)=>Promise<void>) {
  const previous=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='test-only-no-network';
  let h:Awaited<ReturnType<typeof fixture>>|undefined;
  try {h=await fixture();await run(h);} finally {if(h)await h.close();if(previous===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=previous;}
}

pgTest('real executor and service persist the guided workflow from questions through a rendered page',async()=>runWithFixture(async h=>{
  const request={identity,action:'create' as const,requestKey:'create-deduplicated',input:creation};
  const first=await h.coordinator.enqueue(request),duplicate=await h.coordinator.enqueue(request);
  expect(duplicate.id).toBe(first.id);await h.executor.execute(first.id);
  expect((await h.coordinator.enqueue(request)).id).toBe(first.id);
  expect((await h.repo.getOwned(owner,first.id))?.result).toMatchObject({comic:{id:first.id}});
  expect(await h.repo.getOwned(otherOwner,first.id)).toBeNull();
  await expect(h.coordinator.enqueue({identity:otherIdentity,action:'update',requestKey:'wrong-owner',comicId:first.id,expectedRevision:1,input:{title:'No'}})).rejects.toMatchObject({code:'not_found'});
  await expect(h.coordinator.enqueue({...request,input:{...creation,title:'Different'}})).rejects.toMatchObject({code:'idempotency_conflict'});
  await expect(h.coordinator.enqueue({identity:{...identity,scopes:['comex:write']},action:'initialQuestions',requestKey:'missing-generate-scope',comicId:first.id,expectedRevision:1,input:{}})).rejects.toMatchObject({code:'invalid_input'});
  expect((await h.pool.query('SELECT count(*)::int AS n FROM provider_reservations')).rows[0].n).toBe(0);
  const id=first.id;
  const questions=await h.execute('initialQuestions',{},id),afterQuestions=await h.comic(id);
  expect(afterQuestions.draft.questions).toHaveLength(1);expect(afterQuestions.draft.questions[0]).toMatchObject({question:'Who receives the key?',suggestedAnswer:'Her brother'});
  expect((await h.repo.getStep(owner,questions.ticket.id,'initial/questions'))?.state).toBe('completed');
  const suggestions=await h.execute('suggestCharacters',{},id),afterSuggestions=await h.comic(id);
  expect(afterSuggestions.draft.characterSuggestions?.[0]).toMatchObject(card);
  expect((await h.repo.getStep(owner,suggestions.ticket.id,'suggestions'))?.state).toBe('completed');
  await h.execute('update',{panelsPerPage:2},id);
  await h.execute('addCharacter',card,id);
  const character=(await h.comic(id)).draft.characters[0];
  const ref=await h.execute('generateReference',{characterId:character.id},id);
  const generated=(await h.comic(id)).draft.characters[0];
  expect((await h.repo.getStep(owner,ref.ticket.id,`character/${character.id}/reference`))?.result).toMatchObject({format:'private_asset'});
  expect(generated.referenceAssetId).toBeTruthy();expect(await h.assets.read(generated.referenceAssetId!)).toEqual(png);
  expect(h.provider.calls.filter(c=>c==='character_reference')).toHaveLength(1);
  await h.execute('approveCharacter',{characterId:character.id,assetId:generated.referenceAssetId},id);
  const story=await h.execute('planStory',{},id),planned=await h.comic(id);
  expect(planned.draft.storyboard?.pages).toHaveLength(3);expect(planned.draft.storyboard?.pages[0].panels).toHaveLength(2);
  expect((await h.repo.getStep(owner,story.ticket.id,'story/plan'))?.state).toBe('completed');
  expect((await h.repo.getStep(owner,story.ticket.id,'story/narrative'))?.state).toBe('completed');
  const storyView=(story.op.result as any).comic;
  await h.execute('approveStory',{storyRevision:storyView.storyRevision,fingerprint:storyView.storyApproval.fingerprint},id);
  const page=(await h.comic(id)).draft.pages[0];
  await expect(h.enqueue('generatePage',{pageId:page.id,intent:'resume'},id)).rejects.toMatchObject({code:'conflict'});
  const pageJob=await h.enqueue('generatePage',{pageId:page.id,intent:'generate'},id);
  await h.executor.execute(pageJob.id);
  const afterPage=await h.comic(id),rendered=afterPage.draft.pages[0];
  expect(rendered.panels).toHaveLength(2);expect(rendered.panels.every(p=>!!p.assetId)).toBe(true);
  for(const panel of rendered.panels) {
    expect((await h.repo.getStep(owner,pageJob.id,`panel/${panel.id}/image`))?.state).toBe('completed');
    expect((await h.repo.getStep(owner,pageJob.id,`panel/${panel.id}/visual-review`))?.state).toBe('completed');
  }
  expect(h.provider.calls).toEqual(['narrative_questions','character_suggestions','character_reference','storyboard','narrative_judgment','panel_image','visual_judgment','panel_image','visual_judgment']);
  const pageOperation=await h.repo.getOwned(owner,pageJob.id);
  if(pageOperation?.status!=='succeeded') {
    const prepared=await h.repo.getCheckpoint(owner,pageJob.id,`page/${page.id}/prepared`) as any;
    const saved=afterPage.draft.pageOperations?.[page.id];
    const constructed={storyRevision:prepared?.operation?.storyRevision,baseline:prepared?.operation?.baseline};
    throw new Error(`Page ended ${pageOperation?.status}: ${JSON.stringify(pageOperation?.result)}; constructed operation ${JSON.stringify(constructed)}; saved operation ${JSON.stringify(saved)}`);
  }
}));

pgTest('an MCP client and browser projection share the real Postgres guided workflow',async()=>runWithFixture(async h=>{
  const backend=createHostedBackend({pool:h.pool,objects:h.objects,origin:'https://comex.example',workspaceSecret:'test-only-workspace-secret-0123456789',budgetFetch:async()=>{throw new Error('Unexpected direct provider call');}});
  const reads=createMcpReads(h.pool,backend.service,h.repo,(actor,id)=>readOwnedExport(h.repo,h.assets,actor,id));
  const handler=createComexMcpHandler({allowedOrigins:['https://comex.example'],resourceMetadata:'https://comex.example/.well-known/oauth-protected-resource/mcp',editorOrigin:'https://comex.example',
    authenticate:async request=>request.headers.get('authorization')==='Bearer test-client'?identity:null,
    reads,operations:{kind:'durable',enqueue:request=>h.coordinator.enqueue(request)}});
  const client=new Client({name:'postgres-workflow-test',version:'1'});
  const transport=new StreamableHTTPClientTransport(new URL('https://comex.example/mcp'),{requestInit:{headers:{Authorization:'Bearer test-client'}},fetch:async(input,init)=>handler(new Request(input,init))});
  await client.connect(transport);
  let sequence=0;
  const call=async(name:string,args:Record<string,unknown>)=>{const response=await client.callTool({name,arguments:args});expect(response.isError).not.toBe(true);return response;};
  const current=async(id:string)=>((await call('comex_get_comic',{comicId:id})).structuredContent as any).data.comic;
  const execute=async(name:string,args:Record<string,unknown>)=>{
    const reply=await call(name,{...args,requestKey:`mcp-${++sequence}`});
    const id=(reply.structuredContent as any).data.operationId as string;
    await h.executor.execute(id);
    const operation=(await call('comex_get_operation',{operationId:id})).structuredContent as any;
    expect(operation.data.status).toBe('succeeded');return operation.data;
  };
  try {
    const created=await execute('comex_create_comic',creation),id=created.result.comic.id as string;
    let comic=await current(id);
    await execute('comex_start_initial_questions',{comicId:id,expectedRevision:comic.revision});
    comic=await current(id);
    expect(comic.questions[0]).toMatchObject({question:'Who receives the key?',suggestedAnswer:'Her brother'});
    await execute('comex_update_comic',{comicId:id,expectedRevision:comic.revision,answers:{[comic.questions[0].id]:'Her sister'},panelsPerPage:2});
    comic=await current(id);
    await execute('comex_suggest_characters',{comicId:id,expectedRevision:comic.revision});
    comic=await current(id);
    expect(comic.characterSuggestions[0]).toMatchObject(card);
    const browser=(await backend.service.get(owner,id)).comic;
    expect(browser.questions).toEqual(comic.questions);expect(browser.answers).toEqual(comic.answers);expect(browser.characterSuggestions).toEqual(comic.characterSuggestions);
    await execute('comex_add_character',{comicId:id,expectedRevision:comic.revision,...card});
    comic=await current(id);const characterId=comic.characters[0].id;
    await execute('comex_generate_reference',{comicId:id,characterId,expectedRevision:comic.revision});
    comic=await current(id);expect(comic.characters[0].approved).toBe(false);
    const reference=comic.characters[0].referenceVersion;
    expect((await call('comex_get_asset',{comicId:id,assetId:reference})).content.some(item=>item.type==='image')).toBe(true);
    await execute('comex_approve_reference',{comicId:id,characterId,assetId:reference,expectedRevision:comic.revision});
    comic=await current(id);await execute('comex_plan_story',{comicId:id,expectedRevision:comic.revision});
    comic=await current(id);expect(comic.storyApproval.approved).toBe(false);
    await execute('comex_approve_story',{comicId:id,expectedRevision:comic.revision,storyRevision:comic.storyRevision,fingerprint:comic.storyApproval.fingerprint});
    comic=await current(id);await execute('comex_generate_page',{comicId:id,expectedRevision:comic.revision,pageId:comic.pages[0].id,intent:'generate'});
    comic=await current(id);expect(comic.pages[0].panels.every((panel:{imageUrl:string|null})=>!!panel.imageUrl)).toBe(true);
    expect((await backend.service.get(owner,id)).comic.pages).toEqual(comic.pages);
    expect(h.provider.calls).toEqual(['narrative_questions','character_suggestions','character_reference','storyboard','narrative_judgment','panel_image','visual_judgment','panel_image','visual_judgment']);
  } finally {await client.close();}
}));

pgTest('a reference provider result survives a worker lost before image association',async()=>runWithFixture(async h=>{
  const id=(await h.execute('create',creation)).ticket.id;
  await h.execute('addCharacter',card,id);
  const character=(await h.comic(id)).draft.characters[0],ref=await h.enqueue('generateReference',{characterId:character.id},id);
  const gate=h.gateCheckpoint(`character/${character.id}/associated`),firstWorker=h.executor.execute(ref.id);
  try {
    await h.waitUntilReached(gate,firstWorker);
    const paid=await h.repo.getStep(owner,ref.id,`character/${character.id}/reference`);
    expect(paid?.state).toBe('completed');expect(paid?.result).toMatchObject({format:'private_asset'});
    expect((await h.comic(id)).draft.characters[0].referenceAssetId).toBeUndefined();
    await h.pool.query('UPDATE operations SET lease_until=0 WHERE id=$1',[ref.id]);
    await h.executor.execute(ref.id);
  } finally {gate.release();await firstWorker;}
  const operation=await h.repo.getOwned(owner,ref.id),generated=(await h.comic(id)).draft.characters[0];
  expect(h.provider.calls.filter(c=>c==='character_reference')).toHaveLength(1);
  if(operation?.status!=='succeeded'){
    const prepared=await h.repo.getCheckpoint(owner,ref.id,`character/${character.id}/prepared`) as any;
    throw new Error(`Reference replay ended ${operation?.status}: ${JSON.stringify(operation?.result)}; prepared character ${JSON.stringify(prepared?.character)}; saved character ${JSON.stringify(generated)}`);
  }
  expect(generated.referenceAssetId).toBeTruthy();expect(await h.assets.read(generated.referenceAssetId!)).toEqual(png);
}));

pgTest('a saved question response resumes after its worker lease expires without another call',async()=>runWithFixture(async h=>{
  const id=(await h.execute('create',creation)).ticket.id,job=await h.enqueue('initialQuestions',{},id),gate=h.gateCheckpoint('initial/completed');
  const firstWorker=h.executor.execute(job.id);
  try {
    await h.waitUntilReached(gate,firstWorker);
    expect((await h.repo.getStep(owner,job.id,'initial/questions'))?.state).toBe('completed');
    await h.pool.query('UPDATE operations SET lease_until=0 WHERE id=$1',[job.id]);
    await h.executor.execute(job.id);
  } finally {gate.release();await firstWorker;}
  const operation=await h.repo.getOwned(owner,job.id);
  if(operation?.status!=='succeeded')throw new Error(`Question replay ended ${operation?.status}: ${JSON.stringify(operation?.result)}`);
  expect((await h.comic(id)).draft.questions[0]).toMatchObject({question:'Who receives the key?',suggestedAnswer:'Her brother'});
  expect(h.provider.calls.filter(c=>c==='narrative_questions')).toHaveLength(1);
}));

pgTest('a changed story prevents an already received question result from replacing current data',async()=>runWithFixture(async h=>{
  const id=(await h.execute('create',creation)).ticket.id,job=await h.enqueue('initialQuestions',{},id),gate=h.gateCheckpoint('initial/completed');
  const worker=h.executor.execute(job.id);
  try {
    await h.waitUntilReached(gate,worker);
    expect((await h.repo.getStep(owner,job.id,'initial/questions'))?.state).toBe('completed');
    await h.execute('update',{plot:'A different story'},id);
  } finally {gate.release();await worker;}
  const current=await h.comic(id),op=await h.repo.getOwned(owner,job.id);
  expect(current.draft.plot).toBe('A different story');expect(current.draft.questions).toEqual([]);expect(op?.status).toBe('obsolete');
  expect((await h.repo.getStep(owner,job.id,'initial/questions'))?.result).toMatchObject({format:'json'});
  expect(h.provider.calls.filter(c=>c==='narrative_questions')).toHaveLength(1);
}));

pgTest('an unknown question remains blocked until a known failure clears its own text lock',async()=>runWithFixture(async h=>{
  const id=(await h.execute('create',creation)).ticket.id;h.provider.unknownOnce='narrative_questions';
  const job=await h.enqueue('initialQuestions',{},id);await h.executor.execute(job.id);
  expect((await h.repo.getOwned(owner,job.id))?.status).toBe('unknown_outcome');
  expect((await h.comic(id)).draft.initialQuestions).toBe('unknown');
  expect((await h.pool.query('SELECT state,operation_id FROM comic_text_operations WHERE comic_id=$1',[id])).rows[0]).toEqual({state:'unknown',operation_id:job.id});
  expect((await h.repo.getStep(owner,job.id,'initial/questions'))?.state).toBe('unknown');
  expect((await h.pool.query("SELECT state FROM provider_reservations WHERE state='unknown'")).rows).toHaveLength(1);
  await h.executor.execute(job.id);expect(h.provider.calls.filter(c=>c==='narrative_questions')).toHaveLength(1);
  await h.repo.reconcileUnknown(job.id,'initial/questions','failed',null,async(_tx,context)=>{if(context.operation.owner!==owner)throw new Error('Wrong owner');});
  expect((await h.repo.getOwned(owner,job.id))?.status).toBe('queued');
  await h.executor.execute(job.id);
  expect((await h.repo.getOwned(owner,job.id))?.status).toBe('failed');
  expect((await h.comic(id)).draft.initialQuestions).toBe('failed');
  expect((await h.pool.query('SELECT count(*)::int AS n FROM comic_text_operations WHERE comic_id=$1',[id])).rows[0].n).toBe(0);
  expect((await h.pool.query("SELECT state FROM provider_reservations")).rows).toEqual([{state:'completed'}]);
  expect(h.provider.calls.filter(c=>c==='narrative_questions')).toHaveLength(1);
}));

pgTest('grant revocation after story dispatch prevents the undispatched narrative step',async()=>runWithFixture(async h=>{
  const id=(await h.execute('create',creation)).ticket.id;
  await h.execute('initialQuestions',{},id);await h.execute('addCharacter',card,id);
  const character=(await h.comic(id)).draft.characters[0];await h.execute('generateReference',{characterId:character.id},id);
  const reference=(await h.comic(id)).draft.characters[0].referenceAssetId!;
  await h.execute('approveCharacter',{characterId:character.id,assetId:reference},id);
  const gate=pause();h.provider.paused={name:'storyboard',gate};
  const job=await h.enqueue('planStory',{},id),worker=h.executor.execute(job.id);
  try {
    await h.waitUntilReached({reached:gate.reached,release:gate.release},worker);
    await h.pool.query("UPDATE mcp_grants SET revoked_at=1 WHERE id='grant'");
  } finally {gate.release();await worker;}
  expect((await h.repo.getOwned(owner,job.id))?.status).toBe('revoked');
  expect((await h.repo.getStep(owner,job.id,'story/plan'))?.state).toBe('completed');
  expect(await h.repo.getStep(owner,job.id,'story/narrative')).toBeNull();
  expect(h.provider.calls.filter(c=>c==='narrative_judgment')).toHaveLength(0);
  expect((await h.pool.query('SELECT count(*)::int AS n FROM comic_text_operations WHERE comic_id=$1',[id])).rows[0].n).toBe(0);
}));
