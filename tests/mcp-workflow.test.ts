import {expect, test} from 'bun:test';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {Client, StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {LocalStore} from '../src/lib/local-store';
import {createComicService} from '../src/lib/application/comics';
import {createComexMcpHandler, type McpIdentity, type MutationAction, type OperationRequest} from '../src/lib/mcp/server';

test('a client follows the shared guided workflow through queued fake-provider operations',async()=>{
  const owner='owner-alice', identity:McpIdentity={actor:owner,scopes:['comex:read','comex:write','comex:generate','comex:publish']};
  const store=new LocalStore(':memory:');
  const files=new Map<string,Buffer>();
  const png=await sharp({create:{width:8,height:8,channels:4,background:'#fff'}}).png().toBuffer();
  const state={location:'Town',time:'day',props:[],outfits:[],injuries:[],knowledge:[]};
  let providerCalls=0, images=0;
  const finding={severity:'blocker',dimension:'story',panel_id:'p1',character_id:null,reference_id:null,expected:'key',observed:'key missing',repair:'restore key'};
  const provider=()=>({
    async visualScreen(){return {needsDiagnosis:true};},
    async questions(){providerCalls++;return [{id:'ignored',question:'Who gets the key?',suggestedAnswer:'Her brother'}];},
    async characterSuggestions(){providerCalls++;return [{name:'Mina',role:'courier',appearance:'red hair',outfit:'coat'}];},
    async characterReference(){providerCalls++;return png;},
    async storyboard(input:{characters:{id:string}[]}){providerCalls++;const character=input.characters[0].id;return {bible:{premise:'Delivery',setting:'Town',rules:[],character_ids:[character]},pages:[{index:1,panels:[{id:'p1',index:1,character_ids:[character],action:'Find the key',framing:'wide',dialogue:[{speaker_id:character,text:'Here it is'}],state_before:state,state_after:state}]}]};},
    async narrativeJudge(){providerCalls++;return {outcome:'findings',findings:[finding]};},
    async panel(){providerCalls++;images++;return png;},
    async editPanel(){providerCalls++;images++;return png;},
    async classifyEdit(){providerCalls++;return {intent:'uncertain',reason:'The scene may change'};},
    async visualJudge(){providerCalls++;return {outcome:'findings',findings:[finding]};},
    async revision(input:{storyboard:{bible:unknown;pages:{panels:Record<string,unknown>[]}[]}}){providerCalls++;return {earliest_affected_panel_id:'p1',explanation:'Keep the key',revised_bible:input.storyboard.bible,revised_suffix:[{...input.storyboard.pages[0].panels[0],action:'Keep the key'}]};},
  }) as unknown as ReturnType<typeof import('../src/lib/ai/service').createAIService>;
  const dependencies={repository:store,assets:{async read(id:string){const bytes=files.get(id);if(!bytes)throw new Error('missing');return bytes;},async save(bytes:Buffer){const id=randomUUID();files.set(id,bytes);return id;},async discard(id:string){files.delete(id);}},provider,budgetFetch:async()=>{throw new Error('unexpected provider network');},id:randomUUID};
  const service=createComicService(dependencies);
  function durableEditService() {
    const checkpoints=new Map<string,unknown>(),imageIds=new Map<string,string>();
    const durable={
      async load(key:string){return checkpoints.get(key) ?? null;},
      async checkpoint(key:string,work:(repository:LocalStore)=>Promise<unknown>){if(checkpoints.has(key))return checkpoints.get(key);const value=await work(store);checkpoints.set(key,value);return value;},
      async paid(step:{id:string},invoke:(fetch:typeof dependencies.budgetFetch)=>Promise<unknown>){const value=await invoke(dependencies.budgetFetch);if(Buffer.isBuffer(value))imageIds.set(step.id,await dependencies.assets.save(value));return value;},
      async assetIdFor(step:string){return imageIds.get(step) ?? null;},
    };
    return createComicService({...dependencies,durable} as any);
  }
  type Job={id:string;owner:string;request:OperationRequest;status:'queued'|'succeeded'|'failed';result?:unknown;error?:string};
  const jobs=new Map<string,Job>(), keys=new Map<string,{id:string;input:string}>();
  async function run(job:Job) {
    const {action,comicId,expectedRevision,input}=job.request;
    const id=comicId!;
    const methods:Partial<Record<MutationAction,()=>Promise<unknown>>>= {
      create:()=>service.create(owner,input),update:()=>service.update(owner,id,input,expectedRevision),
      initialQuestions:()=>service.initialQuestions(owner,id,{},expectedRevision),suggestCharacters:()=>service.suggestCharacters(owner,id,input,expectedRevision),
      addCharacter:()=>service.addCharacter(owner,id,input,expectedRevision),generateReference:()=>service.generateReference(owner,id,String(input.characterId),{},expectedRevision),
      approveCharacter:()=>service.approveCharacter(owner,id,String(input.characterId),{assetId:input.assetId},expectedRevision),
      planStory:()=>service.planStory(owner,id,{},expectedRevision),approveStory:()=>service.approveStory(owner,id,{revision:expectedRevision,storyRevision:input.storyRevision,fingerprint:input.fingerprint},expectedRevision),
      acceptStoryReview:()=>service.acceptStoryReview(owner,id,{fingerprint:input.fingerprint},expectedRevision),
      generatePage:()=>service.generatePage(owner,id,String(input.pageId),{},expectedRevision),acceptPanel:()=>service.acceptPanel(owner,id,String(input.panelId),{assetId:input.assetId,storyRevision:input.storyRevision,panelRevision:input.panelRevision},expectedRevision),
      editPanel:()=>durableEditService().editPanel(owner,id,String(input.panelId),'decision' in input ? {proposalId:input.proposalId,decision:input.decision} : {instruction:input.instruction,assetId:input.assetId,storyRevision:input.storyRevision,panelRevision:input.panelRevision},expectedRevision),
      exportPage:async()=>({bytes:(await service.downloadPage(owner,id,String(input.pageId),expectedRevision)).length}),
      publish:()=>service.publish(owner,id,{title:input.title,creator:input.creator},expectedRevision),
      withdraw:async()=>{if((await service.getPublished(id)).comic.editionId!==input.expectedEditionId) throw {code:'conflict'};return service.withdraw(owner,id,{},expectedRevision);},
      previewRevision:()=>service.previewRevision(owner,id,{panelId:input.panelId,instruction:input.instruction},expectedRevision),
      applyRevision:()=>service.applyRevision(owner,id,{proposalId:input.proposalId},expectedRevision),
    };
    try {job.result=await methods[action]!();job.status='succeeded';} catch(error){job.error=error && typeof error==='object' && 'code' in error ? String(error.code) : 'error';job.status='failed';}
  }
  const handle=createComexMcpHandler({allowedOrigins:['https://comex.example'],resourceMetadata:'https://comex.example/.well-known/oauth-protected-resource',editorOrigin:'https://comex.example',
    authenticate:async request=>request.headers.get('authorization')==='Bearer creator' ? identity : null,
    reads:{async listStyles(){return service.listStyles();},async listComics(actor,{limit}){return {comics:(await service.list(actor.actor)).comics.slice(0,limit)};},async getComic(actor,id){return service.get(actor.actor,id);},async getAsset(actor,id,asset){return {bytes:await service.getAsset(actor.actor,id,asset),mimeType:'image/png'};},async getExport(){throw {code:'not_found'};},async listOperations(){return {operations:[]};},async getOperation(actor,id){const job=jobs.get(id);if(!job || job.owner!==actor.actor)throw {code:'not_found'};return {id:job.id,status:job.status,result:job.result,error:job.error};}},
    operations:{kind:'durable',async enqueue(request){const key=`${request.identity.actor}:${request.action}:${request.requestKey}`,input=JSON.stringify(request);const existing=keys.get(key);if(existing){if(existing.input!==input)throw {code:'conflict'};return {id:existing.id,status:jobs.get(existing.id)!.status};}const job={id:randomUUID(),owner:request.identity.actor,request,status:'queued' as const};jobs.set(job.id,job);keys.set(key,{id:job.id,input});return {id:job.id,status:'queued',...(request.comicId?{comicId:request.comicId}:{})};}},
  });
  const client=new Client({name:'workflow-test',version:'1'});
  const transport=new StreamableHTTPClientTransport(new URL('https://comex.example/mcp'),{requestInit:{headers:{Authorization:'Bearer creator'}},fetch:async(input,init)=>handle(new Request(input,init))});
  await client.connect(transport);
  let sequence=0;
  const call=async(name:string,args:Record<string,unknown>)=>await client.callTool({name,arguments:args});
  const queue=async(name:string,args:Record<string,unknown>,key=`request-${++sequence}`)=>{
    const reply=await call(name,{...args,requestKey:key});expect(reply.isError).not.toBe(true);
    const operationId=(reply.structuredContent as any).data.operationId as string;
    expect(jobs.get(operationId)?.status).toBe('queued');return operationId;
  };
  const finish=async(id:string)=>{await run(jobs.get(id)!);return (await call('comex_get_operation',{operationId:id})).structuredContent as any;};
  const current=async(id:string)=>((await call('comex_get_comic',{comicId:id})).structuredContent as any).data.comic;
  try {
    const created=await queue('comex_create_comic',{title:'Courier',plot:'Deliver a key',style:'ink-manga'});
    expect(providerCalls).toBe(0);
    const createdResult=await finish(created);const comicId=createdResult.data.result.comic.id as string;
    let comic=await current(comicId);
    expect(comic.initialQuestions).toBe('pending');
    const questions=await queue('comex_start_initial_questions',{comicId,expectedRevision:comic.revision},'questions-key');
    const duplicate=await call('comex_start_initial_questions',{comicId,expectedRevision:comic.revision,requestKey:'questions-key'});
    expect((duplicate.structuredContent as any).data.operationId).toBe(questions);
    const mismatch=await call('comex_start_initial_questions',{comicId,expectedRevision:comic.revision+1,requestKey:'questions-key'});
    expect(mismatch.isError).toBe(true);expect((mismatch.structuredContent as any).error.code).toBe('conflict');
    expect(providerCalls).toBe(0);
    await finish(questions);comic=await current(comicId);
    expect(comic.questions[0]).toMatchObject({question:'Who gets the key?',suggestedAnswer:'Her brother'});
    const questionId=comic.questions[0].id;
    await finish(await queue('comex_update_comic',{comicId,expectedRevision:comic.revision,answers:{[questionId]:'Her sister'}}));
    comic=await current(comicId);expect(comic.answers[questionId]).toBe('Her sister');
    await finish(await queue('comex_suggest_characters',{comicId,expectedRevision:comic.revision}));
    comic=await current(comicId);expect(comic.characterSuggestions[0]).toMatchObject({name:'Mina',appearance:'red hair'});
    await finish(await queue('comex_add_character',{comicId,expectedRevision:comic.revision,name:'Mina',role:'courier',appearance:'red hair',outfit:'blue coat'}));
    comic=await current(comicId);const characterId=comic.characters[0].id;
    await finish(await queue('comex_generate_reference',{comicId,characterId,expectedRevision:comic.revision}));
    comic=await current(comicId);expect(comic.characters[0].approved).toBe(false);
    const reference=comic.characters[0].referenceVersion;
    expect((await call('comex_get_asset',{comicId,assetId:reference})).content.some(item=>item.type==='image')).toBe(true);
    await finish(await queue('comex_approve_reference',{comicId,characterId,assetId:reference,expectedRevision:comic.revision}));
    comic=await current(comicId);
    await finish(await queue('comex_plan_story',{comicId,expectedRevision:comic.revision}));
    comic=await current(comicId);expect(comic.storyboard.pages[0].panels[0].dialogue[0].text).toBe('Here it is');expect(comic.storyApproval.approved).toBe(false);
    expect(comic.storyReview.findings[0].severity).toBe('blocker');
    await finish(await queue('comex_approve_story',{comicId,expectedRevision:comic.revision,storyRevision:comic.storyRevision,fingerprint:comic.storyApproval.fingerprint}));
    comic=await current(comicId);expect(comic.storyApproval.approved).toBe(true);expect(comic.storyReview.accepted).toBe(false);
    expect(comic.nextActions).toContain('generate_page');expect(comic.nextActions).toContain('accept_story_review');
    const generated=await finish(await queue('comex_generate_page',{comicId,pageId:comic.pages[0].id,expectedRevision:comic.revision,intent:'generate'}));
    expect(generated.data.status).toBe('succeeded');expect(images).toBe(1);
    comic=await current(comicId);const panel=comic.pages[0].panels[0];expect(panel.evaluation).toBe('blocker');expect(panel.accepted).toBe(false);expect(panel.ready).toBe(true);
    expect(comic.nextSteps).toContainEqual({...panel.reviewVersion,action:'accept_panel',pageId:comic.pages[0].id,panelId:'p1',requiresConfirmation:true});
    const storyAcceptance=await finish(await queue('comex_accept_story_review',{comicId,expectedRevision:comic.revision,fingerprint:comic.storyReview.fingerprint}));
    expect(storyAcceptance.data.status).toBe('succeeded');comic=await current(comicId);expect(comic.storyReview.accepted).toBe(true);
    const panelAcceptance=await finish(await queue('comex_accept_panel',{comicId,panelId:'p1',expectedRevision:comic.revision,...panel.reviewVersion}));
    expect(panelAcceptance.data.status).toBe('succeeded');
    comic=await current(comicId);expect(comic.pages[0].panels[0].accepted).toBe(true);
    const edited=await finish(await queue('comex_edit_panel',{comicId,panelId:'p1',expectedRevision:comic.revision,instruction:'Change the lighting',...comic.pages[0].panels[0].reviewVersion}));
    expect(edited.data.result.editDecision).toMatchObject({intent:'uncertain',reason:'The scene may change'});
    comic=await current(comicId);expect(comic.pendingArtworkDecision.choices).toEqual(['preview_story','artwork_only']);
    await finish(await queue('comex_confirm_artwork_edit',{comicId,panelId:'p1',expectedRevision:comic.revision,proposalId:comic.pendingArtworkDecision.id,decision:'artwork_only'}));
    comic=await current(comicId);expect(comic.pages[0].panels[0].accepted).toBe(false);
    expect(comic.pages[0].panels[0].ready).toBe(true);expect(comic.pages[0].panels[0].reviewed).toBe(true);
    await expect(service.getPublished(comicId)).rejects.toMatchObject({code:'not_found'});
    const published=await finish(await queue('comex_publish_comic',{comicId,expectedRevision:comic.revision,title:'Public courier',creator:'Mina',expectedEditionId:null}));
    expect(published.data.status).toBe('succeeded');const edition=(await service.getPublished(comicId)).comic;
    comic=await current(comicId);expect(comic.pages[0].panels[0].accepted).toBe(false);
    const stale=await finish(await queue('comex_accept_panel',{comicId,panelId:'p1',expectedRevision:comic.revision,...panel.reviewVersion}));expect(stale.data.status).toBe('failed');
    const currentPanel=comic.pages[0].panels[0];expect(comic.nextSteps).toContainEqual({...currentPanel.reviewVersion,action:'accept_panel',pageId:comic.pages[0].id,panelId:'p1',requiresConfirmation:true});
    const accepted=await finish(await queue('comex_accept_panel',{comicId,panelId:'p1',expectedRevision:comic.revision,...currentPanel.reviewVersion}));expect(accepted.data.status).toBe('succeeded');
    comic=await current(comicId);expect(comic.pages[0].panels[0].accepted).toBe(true);
    await finish(await queue('comex_export_page',{comicId,pageId:comic.pages[0].id,expectedRevision:comic.revision}));
    comic=await current(comicId);
    await finish(await queue('comex_preview_revision',{comicId,expectedRevision:comic.revision,panelId:'p1',instruction:'Keep the key'}));
    comic=await current(comicId);expect(comic.pendingRevision.storyboard.pages[0].panels[0].action).toBe('Keep the key');
    await finish(await queue('comex_apply_revision',{comicId,expectedRevision:comic.revision,proposalId:comic.pendingRevision.id}));
    comic=await current(comicId);expect(comic.storyApproval.approved).toBe(true);expect(comic.storyReview.accepted).toBe(false);
    expect(comic.storyReview.findings[0].severity).toBe('blocker');expect(comic.pages[0].panels[0].ready).toBe(true);expect(images).toBe(3);
    expect((await service.getPublished(comicId)).comic).toEqual(edition);
    const wrongWithdrawal=await finish(await queue('comex_withdraw_comic',{comicId,expectedRevision:comic.revision,expectedEditionId:'wrong-edition'}));
    expect(wrongWithdrawal.data.status).toBe('failed');expect((await service.getPublished(comicId)).comic).toEqual(edition);
    await finish(await queue('comex_withdraw_comic',{comicId,expectedRevision:comic.revision,expectedEditionId:edition.editionId}));
    await expect(service.getPublished(comicId)).rejects.toMatchObject({code:'not_found'});
  } finally {await client.close();store.close();}
});
