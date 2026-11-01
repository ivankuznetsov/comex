import { beforeAll, describe, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import {createHash, randomBytes} from 'node:crypto';
import {LocalStore} from '@/src/lib/local-store';

async function waitForComic(id:string,cookie:string,predicate:(comic:any)=>boolean) {
  for (let attempt=0;attempt<100;attempt++) {
    const response=await handleApi(request(`comics/${id}`,'GET',undefined,cookie),['comics',id]);
    const comic=(await response.json()).comic;
    if (predicate(comic)) return comic;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  throw new Error('Timed out waiting for background review');
}

test('a held visual review does not block progress or overwrite a newer story', async () => {
  const {mkdtemp,writeFile,rm}=await import('node:fs/promises'); const {tmpdir}=await import('node:os'); const {join}=await import('node:path');
  const sharp=(await import('sharp')).default; const {createComic}=await import('@/src/lib/domain/comic');
  const dir=await mkdtemp(join(tmpdir(),'comex-background-review-')); const originalFetch=globalThis.fetch;
  process.env.COMEX_ASSET_PATH=dir;process.env.COMEX_BUDGET_DB_PATH=join(dir,'budget.sqlite');process.env.COMEX_MAX_PROVIDER_CALLS='10';process.env.COMEX_MAX_CONCURRENT_CALLS='4';process.env.OPENAI_API_KEY='test';
  let release!:()=>void, started!:()=>void,releaseSecond!:()=>void,secondStarted!:()=>void;const gate=new Promise<void>(r=>release=r), began=new Promise<void>(r=>started=r),gateSecond=new Promise<void>(r=>releaseSecond=r),beganSecond=new Promise<void>(r=>secondStarted=r);let images=0,reviews=0;
  try {
    const png=await sharp({create:{width:8,height:8,channels:4,background:'#fff'}}).png().toBuffer(),ref='11111111-1111-4111-8111-111111111111';await writeFile(join(dir,`${ref}.png`),png);
    const created=await post('comics',{title:'Background',plot:'A courier',style:'ink-manga'});const {comic}=await created.json();const cookie=created.headers.get('set-cookie')!.split(';')[0],owner=cookie.split('=')[1];
    const store=(globalThis as typeof globalThis & {__comexLocalStore:LocalStore}).__comexLocalStore;const initial=store.getOwned<any>(comic.id,owner)!;
    const domain=createComic({id:comic.id,ownerId:owner,title:'Background',creatorName:'',plot:'A courier',styleId:'ink-manga',pages:[{id:'page1',panels:[{id:'p1',beat:'First'}]},{id:'page2',panels:[{id:'p2',beat:'Second'}]}]});
    const state={location:'town',time:'day',props:[],outfits:[],injuries:[],knowledge:[]};const spec=(id:string)=>({id,index:1,character_ids:['mina'],action:id,framing:'wide',dialogue:[],state_before:state,state_after:state});
    const storyboard={bible:{premise:'A courier',setting:'town',rules:[],character_ids:['mina']},pages:[{index:1,panels:[spec('p1')]},{index:2,panels:[spec('p2')]}]};
    expect(store.update(comic.id,owner,initial.revision,{...initial.data,...domain,storyboard,characters:[{id:'mina',name:'Mina',role:'courier',appearance:'hair',outfit:'coat',approved:true,referenceAssetId:ref}]})).toBe(true);
    await approveSeededStory(comic.id,cookie);
    globalThis.fetch=(async (url:string|URL|Request)=>{
      if(String(url).includes('/images/')){images++;return Response.json({data:[{b64_json:png.toString('base64')}]});}
      reviews++; if(reviews===1){started();await gate;} else if(reviews===2){secondStarted();await gateSecond;}
      return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({outcome:'findings',findings:[{severity:'blocker',dimension:'action',panel_id:'p1',character_id:null,reference_id:null,expected:'key',observed:'wrong key',repair:'fix'}]})}]}]});
    }) as unknown as typeof fetch;
    const first=await post(`comics/${comic.id}/pages/page1/generate`,{},cookie);expect(first.status).toBe(200);await began;
    const initialResponse=await first.json();expect(initialResponse.comic.pages[0].panels[0].status).toBe('checking');
    const second=await post(`comics/${comic.id}/pages/page2/generate`,{},cookie);expect(second.status).toBe(200);await beganSecond;expect(images).toBe(2);
    expect((await post(`comics/${comic.id}/publish`,{title:'Background',creator:'Mina'},cookie)).status).toBe(200);
    const beforeReview=store.getOwned<any>(comic.id,owner)!;
    release();
    const reviewed=await waitForComic(comic.id,cookie,c=>c.pages[0].panels[0].reviewOutcome==='findings');
    expect(store.getOwned<any>(comic.id,owner)!.revision).toBe(beforeReview.revision);
    expect(reviewed.pages[0].panels[0].evaluation).toBe('blocker');expect(reviewed.pages[0].panels[0].accepted).toBe(false);
    // A second late review of an older story must not mutate the new story.
    const afterReview=store.getOwned<any>(comic.id,owner)!;
    expect(store.update(comic.id,owner,afterReview.revision,{...afterReview.data,storyRevision:2})).toBe(true);
    releaseSecond();await new Promise(resolve=>setTimeout(resolve,30));
    const latest=store.getOwned<any>(comic.id,owner)!;expect(latest.data.storyRevision).toBe(2);expect(latest.data.panelReviews?.p2).toBeUndefined();
    expect((await post(`comics/${comic.id}/unpublish`,{},cookie)).status).toBe(200);
  } finally {release();releaseSecond();await new Promise(resolve=>setTimeout(resolve,20));globalThis.fetch=originalFetch;delete process.env.COMEX_ASSET_PATH;delete process.env.COMEX_BUDGET_DB_PATH;delete process.env.COMEX_MAX_PROVIDER_CALLS;delete process.env.COMEX_MAX_CONCURRENT_CALLS;delete process.env.OPENAI_API_KEY;await rm(dir,{recursive:true,force:true});}
});

test('story planning returns while its narrative review is still running', async () => {
  const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const dir=await mkdtemp(join(tmpdir(),'comex-background-story-'));const originalFetch=globalThis.fetch;
  process.env.COMEX_BUDGET_DB_PATH=join(dir,'budget.sqlite');process.env.COMEX_MAX_PROVIDER_CALLS='10';process.env.COMEX_MAX_CONCURRENT_CALLS='4';process.env.OPENAI_API_KEY='test';
  let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>release=r),began=new Promise<void>(r=>started=r);
  try {
    const created=await post('comics',{title:'Story',plot:'Deliver a key',style:'ink-manga'});const {comic}=await created.json();const cookie=created.headers.get('set-cookie')!.split(';')[0],owner=cookie.split('=')[1];
    const store=(globalThis as typeof globalThis & {__comexLocalStore:LocalStore}).__comexLocalStore;const current=store.getOwned<any>(comic.id,owner)!;
    expect(store.update(comic.id,owner,current.revision,{...current.data,characters:[{id:'mina',name:'Mina',role:'courier',appearance:'hair',outfit:'coat',approved:true,referenceAssetId:'11111111-1111-4111-8111-111111111111'}]})).toBe(true);
    const state={location:'town',time:'day',props:[],outfits:[],injuries:[],knowledge:[]};
    const pages=Array.from({length:3},(_,i)=>({index:i+1,panels:Array.from({length:3},(_,j)=>({id:`p${i*3+j+1}`,index:j+1,character_ids:['mina'],action:'Deliver',framing:'wide',dialogue:[],state_before:state,state_after:state}))}));
    globalThis.fetch=(async (_url:string|URL|Request,init?:RequestInit)=>{
      const name=JSON.parse(String(init?.body)).text.format.name;
      if(name==='narrative_judgment'){started();await gate;}
      const value=name==='storyboard'?{bible:{premise:'Deliver a key',setting:'town',rules:[],character_ids:['mina']},pages}:{outcome:'pass',findings:[]};
      return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]});
    }) as unknown as typeof fetch;
    const response=await post(`comics/${comic.id}/story/plan`,{},cookie);expect(response.status).toBe(200);await began;
    const result=await response.json();expect(result.comic.pages).toHaveLength(3);expect(result.comic.storyReview.outcome).toBe('pending');
    const before=store.getOwned<any>(comic.id,owner)!;
    release();await new Promise(resolve=>setTimeout(resolve,50));
    const after=store.getOwned<any>(comic.id,owner)!;expect(after.revision).toBe(before.revision);
    const reviewed=await (await handleApi(request(`comics/${comic.id}`,'GET',undefined,cookie),['comics',comic.id])).json();expect(reviewed.comic.storyReview.outcome).toBe('pass');
    for (const outcome of ['inconclusive','failed'] as const) {
      const next=await post('comics',{title:'Story',plot:'Deliver a key',style:'ink-manga'});const nextComic=(await next.json()).comic;const nextCookie=next.headers.get('set-cookie')!.split(';')[0],nextOwner=nextCookie.split('=')[1];
      const record=store.getOwned<any>(nextComic.id,nextOwner)!;expect(store.update(nextComic.id,nextOwner,record.revision,{...record.data,characters:[{id:'mina',name:'Mina',role:'courier',appearance:'hair',outfit:'coat',approved:true,referenceAssetId:'11111111-1111-4111-8111-111111111111'}]})).toBe(true);
      globalThis.fetch=(async (_url:string|URL|Request,init?:RequestInit)=>{const name=JSON.parse(String(init?.body)).text.format.name;if(name==='narrative_judgment'&&outcome==='failed')return new Response('{}',{status:400});const value=name==='storyboard'?{bible:{premise:'Deliver a key',setting:'town',rules:[],character_ids:['mina']},pages}:{outcome,findings:[]};return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]});}) as unknown as typeof fetch;
      expect((await post(`comics/${nextComic.id}/story/plan`,{},nextCookie)).status).toBe(200);await new Promise(resolve=>setTimeout(resolve,30));
      const observed=await (await handleApi(request(`comics/${nextComic.id}`,'GET',undefined,nextCookie),['comics',nextComic.id])).json();expect(observed.comic.storyReview.outcome).toBe(outcome);
    }
  } finally {release();await new Promise(resolve=>setTimeout(resolve,20));globalThis.fetch=originalFetch;delete process.env.COMEX_BUDGET_DB_PATH;delete process.env.COMEX_MAX_PROVIDER_CALLS;delete process.env.COMEX_MAX_CONCURRENT_CALLS;delete process.env.OPENAI_API_KEY;await rm(dir,{recursive:true,force:true});}
});

test('routing restores intended state and returns version-bound story and clarification handoffs', async () => {
  const {mkdtemp,writeFile,rm}=await import('node:fs/promises'); const {tmpdir}=await import('node:os'); const {join}=await import('node:path');
  const sharp=(await import('sharp')).default; const {createComic,commitPanelRender,acceptPanel,setPageComposition}=await import('@/src/lib/domain/comic');
  const dir=await mkdtemp(join(tmpdir(),'comex-edit-choice-')); const originalFetch=globalThis.fetch;
  process.env.COMEX_ASSET_PATH=dir;process.env.COMEX_BUDGET_DB_PATH=join(dir,'budget.sqlite');process.env.COMEX_MAX_PROVIDER_CALLS='20';process.env.OPENAI_API_KEY='test';
  try {
    const png=await sharp({create:{width:8,height:8,channels:4,background:'#fff'}}).png().toBuffer();
    const image='11111111-1111-4111-8111-111111111111', ref='22222222-2222-4222-8222-222222222222';
    await writeFile(join(dir,`${image}.png`),png);await writeFile(join(dir,`${ref}.png`),png);
    const created=await post('comics',{title:'Light',plot:'A sailor watches a dark lighthouse',style:'ink-manga'});
    const {comic}=await created.json();const cookie=created.headers.get('set-cookie')!.split(';')[0],owner=cookie.split('=')[1];
    const store=(globalThis as typeof globalThis & {__comexLocalStore:LocalStore}).__comexLocalStore;const initial=store.getOwned<any>(comic.id,owner)!;
    let domain=createComic({id:comic.id,ownerId:owner,title:'Light',creatorName:'',plot:'A sailor watches a dark lighthouse',styleId:'ink-manga',pages:[{id:'page1',panels:[{id:'p1',beat:'The lighthouse is dark'}]}]});
    domain=commitPanelRender(domain,owner,'p1',{storyRevision:1,panelRevision:1},image,'uncertain');
    domain=acceptPanel(domain,owner,'p1',image,1); domain=setPageComposition(domain,owner,'page1','old-composition',[image]);
    const state={location:'lighthouse',time:'night',props:[{key:'lamp',value:'off'}],outfits:[],injuries:[],knowledge:[]};
    const spec={id:'p1',index:1,character_ids:['mina'],action:'The lighthouse lamp is off',framing:'wide',dialogue:[{speaker_id:'mina',text:'It is dark'}],state_before:state,state_after:state};
    const storyboard={bible:{premise:'A dark lighthouse',setting:'coast',rules:['Keep lamp off'],character_ids:['mina']},pages:[{index:1,panels:[spec]}]};
    expect(store.update(comic.id,owner,initial.revision,{...initial.data,...domain,storyboard,characters:[{id:'mina',name:'Mina',role:'sailor',appearance:'hair',outfit:'coat',approved:true,referenceAssetId:ref}]})).toBe(true);
    let unapprovedCalls=0;globalThis.fetch=(async()=>{unapprovedCalls++;throw new Error('Unexpected provider call');}) as unknown as typeof fetch;
    expect((await post(`comics/${comic.id}/panels/p1/edit`,{instruction:'Turn the lamp off',assetId:image,storyRevision:1,panelRevision:2},cookie)).status).toBe(409);expect(unapprovedCalls).toBe(0);
    await approveSeededStory(comic.id,cookie);
    let classes=0,images=0,previewCalls=0,imagePrompt='',classifyAs:'restore'|'story'|'clarify'='restore';
    globalThis.fetch=(async (url:string|URL|Request,init?:RequestInit)=>{
      if(String(url).includes('/images/')) {images++;imagePrompt=String((init!.body as FormData).get('prompt'));return Response.json({data:[{b64_json:png.toString('base64')}]});}
      const payload=JSON.parse(String(init?.body)), name=payload.text.format.name;
      if(name==='edit_intent') {classes++; const evidence=JSON.parse(payload.input[1].content[0].text);expect(evidence.panel).toEqual(spec);expect(evidence.bible).toEqual(storyboard.bible);expect(evidence.reference_manifest).toContain('approved character, ID mina');expect(payload.input[1].content.filter((v:any)=>v.type==='input_image')).toHaveLength(2);}
      if(name==='plot_revision') previewCalls++;
      const value=name==='edit_intent'?{intent:classifyAs,reason:'Based on the intended scene.',question:classifyAs==='clarify'?'What should change?':null}:{outcome:'inconclusive',findings:[]};
      return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]});
    }) as unknown as typeof fetch;
    const path=`comics/${comic.id}/panels/p1/edit`, version={assetId:image,storyRevision:1,panelRevision:2};
    const restored=await post(path,{instruction:'Turn the lamp off',...version},cookie);expect(restored.status).toBe(200);
    const result=await restored.json();expect(result.outcome).toBe('edited');expect(result.intent).toBe('restore');expect(images).toBe(1);expect(classes).toBe(1);
    expect(imagePrompt).toContain('Edit mode: restore');expect(imagePrompt).toContain('intended storyboard facts take precedence');expect(imagePrompt).toContain('The lighthouse lamp is off');
    const after=store.getOwned<any>(comic.id,owner)!;expect(after.data.storyboard).toEqual(storyboard);expect(after.data.storyRevision).toBe(1);expect(after.data.pages[0].composition).toBeNull();expect(after.data.pages[0].panels[0].acceptance).toBeNull();expect(after.data.pages[0].panels[0].assetId).not.toBe(image);
    const currentVersion=result.comic.pages[0].panels[0].reviewVersion;
    classifyAs='story';const story=await post(path,{instruction:'Change the story',...currentVersion,expectedDraftRevision:after.revision},cookie);expect(story.status).toBe(200);
    const handoff=(await story.json()).routing;expect(handoff.intent).toBe('story');expect(handoff.instruction).toBe('Change the story');expect(handoff.panelId).toBe('p1');expect(handoff.snapshot).toEqual({draftRevision:after.revision,...currentVersion});
    classifyAs='clarify';const unclear=await post(path,{instruction:'Fix it',...currentVersion,expectedDraftRevision:after.revision},cookie);expect(unclear.status).toBe(200);const question=(await unclear.json()).routing;expect(question.question).toBe('What should change?');expect(images).toBe(1);
    classifyAs='story';const answered=await post(path,{instruction:'Fix it\n\nClarification: change the story',...currentVersion,expectedDraftRevision:question.snapshot.draftRevision},cookie);expect(answered.status).toBe(200);
    expect((await answered.json()).routing).toMatchObject({intent:'story',instruction:'Fix it\n\nClarification: change the story',snapshot:question.snapshot});expect(classes).toBe(4);expect(images).toBe(1);
    const changed=store.getOwned<any>(comic.id,owner)!;expect(store.update(comic.id,owner,changed.revision,{...changed.data,title:'New title'})).toBe(true);
    const stalePreview=await post(`comics/${comic.id}/revisions/preview`,{panelId:'p1',instruction:handoff.instruction,reviewedVersion:currentVersion,expectedDraftRevision:handoff.snapshot.draftRevision},cookie);expect(stalePreview.status).toBe(409);expect(previewCalls).toBe(0);
    const staleAnswer=await post(path,{instruction:'Fix it\n\nClarification: make it dark',...currentVersion,expectedDraftRevision:question.snapshot.draftRevision},cookie);expect(staleAnswer.status).toBe(409);expect(classes).toBe(4);expect(images).toBe(1);
    expect((await post(path,{proposalId:crypto.randomUUID(),decision:'artwork_only'},cookie)).status).toBe(400);
  } finally {globalThis.fetch=originalFetch;delete process.env.COMEX_ASSET_PATH;delete process.env.COMEX_BUDGET_DB_PATH;delete process.env.COMEX_MAX_PROVIDER_CALLS;delete process.env.OPENAI_API_KEY;await rm(dir,{recursive:true,force:true});}
});

test('image generation preserves paid output after unrelated changes and cleans stale results', async () => {
  const {mkdtemp,readdir,writeFile,rm}=await import('node:fs/promises'); const {tmpdir}=await import('node:os'); const {join}=await import('node:path');
  const sharp=(await import('sharp')).default; const {createComic,reviseStory}=await import('@/src/lib/domain/comic');
  const dir=await mkdtemp(join(tmpdir(),'comex-cas-assets-'));const originalFetch=globalThis.fetch;
  process.env.COMEX_ASSET_PATH=dir;process.env.COMEX_BUDGET_DB_PATH=join(dir,'budget.sqlite');process.env.COMEX_MAX_PROVIDER_CALLS='30';process.env.OPENAI_API_KEY='test';
  try {
    const png=await sharp({create:{width:8,height:8,channels:4,background:'#fff'}}).png().toBuffer();
    const reference='11111111-1111-4111-8111-111111111111';await writeFile(join(dir,`${reference}.png`),png);
    for (const kind of ['character','panel'] as const) for (const stale of [false,true]) {
      const created=await post('comics',{title:'CAS test',plot:'A courier',style:'ink-manga'});const {comic}=await created.json();
      const cookie=created.headers.get('set-cookie')!.split(';')[0],owner=cookie.split('=')[1];
      const store=(globalThis as typeof globalThis & {__comexLocalStore:LocalStore}).__comexLocalStore;
      const current=store.getOwned<any>(comic.id,owner)!;const card={id:randomBytes(16).toString('hex'),name:'Mina',role:'courier',appearance:'hair',outfit:'coat',approved:kind==='panel',...(kind==='panel'?{referenceAssetId:reference,referenceUrl:`/api/comics/${comic.id}/assets/${reference}`}:{})};
      if (kind==='character') expect(store.update(comic.id,owner,current.revision,{...current.data,characters:[card]})).toBe(true);
      else {
        const domain=createComic({id:comic.id,ownerId:owner,title:'CAS test',creatorName:'',plot:'A courier',styleId:'ink-manga',pages:[{id:'page1',panels:[{id:'p1',beat:'The courier arrives'}]}]});
        const state={location:'town',time:'day',props:[],outfits:[],injuries:[],knowledge:[]};
        const storyboard={bible:{premise:'A courier',setting:'town',rules:[],character_ids:[card.id]},pages:[{index:1,panels:[{id:'p1',index:1,character_ids:[card.id],action:'The courier arrives',framing:'wide',dialogue:[],state_before:state,state_after:state}]}]};
        expect(store.update(comic.id,owner,current.revision,{...current.data,...domain,characters:[card],storyboard})).toBe(true);
    await approveSeededStory(comic.id,cookie);
      }
      let release!:()=>void,started!:()=>void;const wait=new Promise<void>(r=>release=r),began=new Promise<void>(r=>started=r);
      globalThis.fetch=(async (url:string|URL|Request)=>{if(String(url).includes('/images/')){started();await wait;return Response.json({data:[{b64_json:png.toString('base64')}]});}return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({outcome:'inconclusive',findings:[]})}]}]});}) as unknown as typeof fetch;
      const filesBefore=(await readdir(dir)).filter(name=>name.endsWith('.png')).length;const path=kind==='character'?`comics/${comic.id}/characters/${card.id}/reference`:`comics/${comic.id}/pages/page1/generate`;
      const pending=post(path,{},cookie);await began;
      if (stale) {
        const inFlight=store.getOwned<any>(comic.id,owner)!;
        const changed=kind==='character'?{...inFlight.data,styleId:'clear-line-adventure'}:reviseStory(inFlight.data,owner,inFlight.data.storyRevision,'p1',{p1:'Changed action'});
        expect(store.update(comic.id,owner,inFlight.revision,changed)).toBe(true);
      } else expect((await handleApi(request(`comics/${comic.id}`,'PATCH',{title:'Concurrent title'},cookie),['comics',comic.id])).status).toBe(200);
      release();const result=await pending;
      expect(result.status).toBe(stale?409:200);
      expect((await readdir(dir)).filter(name=>name.endsWith('.png')).length).toBe(filesBefore+(stale?0:1));
      if (!stale) {const body=await result.json();expect(body.comic.title).toBe('Concurrent title');expect(kind==='character'?body.comic.characters[0].referenceUrl:body.comic.pages[0].panels[0].imageUrl).toBeTruthy();}
    }
  } finally {globalThis.fetch=originalFetch;delete process.env.COMEX_ASSET_PATH;delete process.env.COMEX_BUDGET_DB_PATH;delete process.env.COMEX_MAX_PROVIDER_CALLS;delete process.env.OPENAI_API_KEY;await rm(dir,{recursive:true,force:true});}
});

test('question refresh preserves answered questions and sends their text to planning and judges', async () => {
  const {mkdtemp,rm}=await import('node:fs/promises'); const {tmpdir}=await import('node:os'); const {join}=await import('node:path');
  const dir=await mkdtemp(join(tmpdir(),'comex-qa-answers-')); process.env.COMEX_BUDGET_DB_PATH=join(dir,'budget.sqlite'); process.env.COMEX_MAX_PROVIDER_CALLS='10'; process.env.OPENAI_API_KEY='test';
  const originalFetch=globalThis.fetch;
  try {
    const created=await post('comics',{title:'Questions',plot:'A courier',style:'ink-manga'}); const {comic}=await created.json();
    const cookie=created.headers.get('set-cookie')!.split(';')[0],owner=cookie.split('=')[1];
    const store=(globalThis as typeof globalThis & {__comexLocalStore:import('@/src/lib/local-store').LocalStore}).__comexLocalStore;
    const record=store.getOwned<Record<string,unknown>>(comic.id,owner)!;
    const questions=[{id:'q1',question:'Who is the recipient?'},{id:'q2',question:'Where does she go?'}];
    const characters=[{id:'mina',name:'Mina',role:'courier',appearance:'hair',outfit:'coat',approved:true,referenceAssetId:'11111111-1111-4111-8111-111111111111'}];
    expect(store.update(comic.id,owner,record.revision,{...record.data,questions,answers:{q1:'Her brother'},characters})).toBe(true);
    const state={location:'town',time:'day',props:[],outfits:[],injuries:[],knowledge:[]};
    const pages=Array.from({length:3},(_,i)=>({index:i+1,panels:Array.from({length:4},(_,j)=>({id:`p${i*4+j+1}`,index:j+1,character_ids:['mina'],action:'Deliver',framing:'wide',dialogue:[],state_before:state,state_after:state}))}));
    const inputs:Record<string,unknown>[]=[];
    globalThis.fetch=(async (_url:string|URL|Request,init?:RequestInit)=>{
      const body=JSON.parse(String(init?.body)); inputs.push({name:body.text.format.name, ...JSON.parse(body.input[1].content)});
      const value=body.text.format.name==='narrative_questions'?{questions:[{id:'q1',question:'What is the weather?',suggested_answer:'Sunny'}]}:body.text.format.name==='storyboard'?{bible:{premise:'Delivery',setting:'town',rules:[],character_ids:['mina']},pages}:{outcome:'inconclusive',findings:[]};
      return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]});
    }) as unknown as typeof fetch;
    const refreshed=await post(`comics/${comic.id}/questions`,{},cookie); expect(refreshed.status).toBe(200);
    const data=(await refreshed.json()).comic; expect(data.questions[0]).toEqual(questions[0]); expect(data.questions[1].id).not.toBe('q1'); expect(data.answers).toEqual({q1:'Her brother'});
    const settings=await handleApi(request(`comics/${comic.id}`,'PATCH',{panelsPerPage:4},cookie),['comics',comic.id]); expect(settings.status).toBe(200);
    const planned=await post(`comics/${comic.id}/story/plan`,{},cookie); expect(planned.status).toBe(200);
    expect((await planned.json()).comic.pages[0].panels).toHaveLength(4);
    expect((await handleApi(request(`comics/${comic.id}`,'PATCH',{panelsPerPage:2},cookie),['comics',comic.id])).status).toBe(409);
    expect(inputs.find(input=>input.name==='storyboard')?.panelsPerPage).toBe(4);
    expect(inputs.map(input=>input.name)).toEqual(['narrative_questions','storyboard','narrative_judgment']);
    for (const input of inputs) expect(input.answers).toEqual({'Who is the recipient?':'Her brother'});
  } finally {globalThis.fetch=originalFetch;delete process.env.COMEX_BUDGET_DB_PATH;delete process.env.COMEX_MAX_PROVIDER_CALLS;delete process.env.OPENAI_API_KEY;await rm(dir,{recursive:true,force:true});}
});

test('character suggestions use story answers and dispatch once across tabs', async () => {
  const {mkdtemp,rm}=await import('node:fs/promises'); const {tmpdir}=await import('node:os'); const {join}=await import('node:path');
  const dir=await mkdtemp(join(tmpdir(),'comex-suggestions-'));const originalFetch=globalThis.fetch;
  process.env.COMEX_BUDGET_DB_PATH=join(dir,'budget.sqlite');process.env.COMEX_MAX_PROVIDER_CALLS='5';process.env.OPENAI_API_KEY='test';
  try {
    const created=await post('comics',{title:'Cast',plot:'A courier delivers a key',style:'ink-manga'});const {comic}=await created.json();const cookie=created.headers.get('set-cookie')!.split(';')[0],owner=cookie.split('=')[1];
    const store=(globalThis as typeof globalThis & {__comexLocalStore:LocalStore}).__comexLocalStore;const current=store.getOwned<any>(comic.id,owner)!;
    expect(store.update(comic.id,owner,current.revision,{...current.data,initialQuestions:'complete',questions:[{id:'q',question:'Who receives it?'}],answers:{q:'Her brother'}})).toBe(true);
    let calls=0,release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>release=r),began=new Promise<void>(r=>started=r);
    globalThis.fetch=(async (_url:string|URL|Request,init?:RequestInit)=>{calls++;const body=JSON.parse(String(init?.body));expect(body.text.format.name).toBe('character_suggestions');expect(JSON.parse(body.input[1].content).answers).toEqual({'Who receives it?':'Her brother'});started();await gate;return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({characters:[{name:'Mina',role:'Courier',appearance:'Freckles and red hair',outfit:'Yellow raincoat'}]})}]}]});}) as unknown as typeof fetch;
    const pending=post(`comics/${comic.id}/characters/suggestions`,{},cookie);await began;
    const duplicate=await post(`comics/${comic.id}/characters/suggestions`,{},cookie);expect(duplicate.status).toBe(200);expect((await duplicate.json()).comic.initialSuggestions).toBe('running');
    expect((await handleApi(request(`comics/${comic.id}`,'PATCH',{title:'Updated title'},cookie),['comics',comic.id])).status).toBe(200);
    release();const result=await pending;expect(result.status).toBe(200);const data=(await result.json()).comic;
    expect(data.title).toBe('Updated title');expect(data.initialSuggestions).toBe('complete');expect(data.characterSuggestions[0]).toMatchObject({name:'Mina',role:'Courier'});expect(data.characters).toEqual([]);expect(calls).toBe(1);
    expect((await post(`comics/${comic.id}/characters/suggestions`,{},cookie)).status).toBe(200);expect(calls).toBe(1);
  } finally {globalThis.fetch=originalFetch;delete process.env.COMEX_BUDGET_DB_PATH;delete process.env.COMEX_MAX_PROVIDER_CALLS;delete process.env.OPENAI_API_KEY;await rm(dir,{recursive:true,force:true});}
});

test('uncertain character suggestion outcomes never redispatch automatically', async () => {
  const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const dir=await mkdtemp(join(tmpdir(),'comex-suggestions-unknown-'));const originalFetch=globalThis.fetch;
  process.env.COMEX_BUDGET_DB_PATH=join(dir,'budget.sqlite');process.env.COMEX_MAX_PROVIDER_CALLS='5';process.env.OPENAI_API_KEY='test';
  try {
    const created=await post('comics',{title:'Cast',plot:'A courier delivers a key',style:'ink-manga'});const {comic}=await created.json();const cookie=created.headers.get('set-cookie')!.split(';')[0],owner=cookie.split('=')[1];
    const store=(globalThis as typeof globalThis & {__comexLocalStore:LocalStore}).__comexLocalStore;const current=store.getOwned<any>(comic.id,owner)!;expect(store.update(comic.id,owner,current.revision,{...current.data,initialQuestions:'complete'})).toBe(true);
    let calls=0;globalThis.fetch=(async ()=>{calls++;throw new Error('network lost');}) as unknown as typeof fetch;
    expect((await post(`comics/${comic.id}/characters/suggestions`,{},cookie)).status).toBe(502);
    expect((await post(`comics/${comic.id}/characters/suggestions`,{retry:true},cookie)).status).toBe(409);expect(calls).toBe(1);
    const view=await handleApi(request(`comics/${comic.id}`,'GET',undefined,cookie),['comics',comic.id]);expect((await view.json()).comic.initialSuggestions).toBe('unknown');
  } finally {globalThis.fetch=originalFetch;delete process.env.COMEX_BUDGET_DB_PATH;delete process.env.COMEX_MAX_PROVIDER_CALLS;delete process.env.OPENAI_API_KEY;await rm(dir,{recursive:true,force:true});}
});

test('failed character suggestions preserve existing cards and require an explicit retry', async () => {
  const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const dir=await mkdtemp(join(tmpdir(),'comex-suggestions-retry-'));const originalFetch=globalThis.fetch;
  process.env.COMEX_BUDGET_DB_PATH=join(dir,'budget.sqlite');process.env.COMEX_MAX_PROVIDER_CALLS='5';process.env.OPENAI_API_KEY='test';
  try {
    const created=await post('comics',{title:'Cast',plot:'A courier delivers a key',style:'ink-manga'});const {comic}=await created.json();const cookie=created.headers.get('set-cookie')!.split(';')[0],owner=cookie.split('=')[1];
    const store=(globalThis as typeof globalThis & {__comexLocalStore:LocalStore}).__comexLocalStore;const current=store.getOwned<any>(comic.id,owner)!;const manual={id:'manual',name:'Original',role:'Courier',appearance:'Dark hair',outfit:'Blue coat',approved:false};
    expect(store.update(comic.id,owner,current.revision,{...current.data,initialQuestions:'complete',characters:[manual]})).toBe(true);
    let calls=0;globalThis.fetch=(async ()=>{calls++;return calls===1?Response.json({error:{}},{status:400}):Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({characters:[{name:'Other',role:'Friend',appearance:'Short hair',outfit:'Red scarf'}]})}]}]});}) as unknown as typeof fetch;
    expect((await post(`comics/${comic.id}/characters/suggestions`,{},cookie)).status).toBe(502);
    const failed=await handleApi(request(`comics/${comic.id}`,'GET',undefined,cookie),['comics',comic.id]);expect((await failed.json()).comic.initialSuggestions).toBe('failed');
    expect((await post(`comics/${comic.id}/characters/suggestions`,{},cookie)).status).toBe(200);expect(calls).toBe(1);
    const retry=await post(`comics/${comic.id}/characters/suggestions`,{retry:true},cookie);expect(retry.status).toBe(200);const view=(await retry.json()).comic;
    expect(view.characters[0].name).toBe('Original');expect(view.characterSuggestions[0].name).toBe('Other');expect(calls).toBe(2);
  } finally {globalThis.fetch=originalFetch;delete process.env.COMEX_BUDGET_DB_PATH;delete process.env.COMEX_MAX_PROVIDER_CALLS;delete process.env.OPENAI_API_KEY;await rm(dir,{recursive:true,force:true});}
});

async function approveSeededStory(id:string, cookie:string) {
  const response=await handleApi(request(`comics/${id}`,'GET',undefined,cookie),['comics',id]);
  const comic=(await response.json()).comic;
  expect(comic.storyApproval.approved).toBe(false);
  const approved=await post(`comics/${id}/story/approve`,{revision:comic.revision,storyRevision:comic.storyApproval.storyRevision,fingerprint:comic.storyApproval.fingerprint},cookie);
  expect(approved.status).toBe(200);
}

let handleApi: typeof import('@/src/lib/local-api').handleApi;
beforeAll(async () => {
  process.env.COMEX_DB_PATH = ':memory:';
  (globalThis as typeof globalThis & {__comexLocalStore?: LocalStore}).__comexLocalStore = new LocalStore(':memory:');
  ({ handleApi } = await import('@/src/lib/local-api'));
});
function request(path: string, method = 'GET', body?: unknown, cookie?: string, origin?: string) {
  const headers = new Headers();
  if (body !== undefined) headers.set('content-type', 'application/json');
  if (cookie) headers.set('cookie', cookie);
  if (origin) headers.set('origin', origin);
  return new NextRequest(`http://localhost:3000/api/${path}`, {method, headers, body: body === undefined ? undefined : JSON.stringify(body)});
}
function fixtureSession() {
  const store=(globalThis as typeof globalThis & {__comexLocalStore:LocalStore}).__comexLocalStore;
  const token=randomBytes(32).toString('hex');
  const db=(store as unknown as {db:import('node:sqlite').DatabaseSync}).db;
  db.prepare('INSERT INTO auth_users VALUES (?,?)').run(`${token}@example.test`,token);
  db.prepare('INSERT INTO auth_sessions VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'),token,Date.now()+60000);
  return `comex_auth=${token}`;
}
const post = async (path: string, body: unknown, cookie?: string, origin?: string) => {
  const fixture = path === 'comics' && !cookie ? fixtureSession() : undefined;
  const response=await handleApi(request(path,'POST',body,cookie ?? fixture,origin),path.split('/'));
  if (fixture && response.status === 201) response.headers.set('set-cookie',`${fixture}; HttpOnly`);
  return response;
};

test('automatic initial questions dispatch once across tabs and preserve unrelated draft changes', async () => {
  const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const dir=await mkdtemp(join(tmpdir(),'comex-initial-questions-'));const originalFetch=globalThis.fetch;
  process.env.COMEX_BUDGET_DB_PATH=join(dir,'budget.sqlite');process.env.COMEX_MAX_PROVIDER_CALLS='10';process.env.OPENAI_API_KEY='test';
  let release!:()=>void,started!:()=>void;const gate=new Promise<void>(resolve=>release=resolve), began=new Promise<void>(resolve=>started=resolve);let calls=0;
  try {
    const created=await post('comics',{title:'First title',plot:'A courier',style:'ink-manga'});const {comic}=await created.json();const cookie=created.headers.get('set-cookie')!.split(';')[0];
    globalThis.fetch=(async ()=>{calls++;started();await gate;return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({questions:[{id:'q1',question:'Who is the recipient?',suggested_answer:'A friend'}]})}]}]});}) as unknown as typeof fetch;
    const first=post(`comics/${comic.id}/questions/initial`,{},cookie);await began;
    const duplicate=await post(`comics/${comic.id}/questions/initial`,{},cookie);expect(duplicate.status).toBe(200);expect((await duplicate.json()).comic.initialQuestions).toBe('running');
    const rename=await handleApi(request(`comics/${comic.id}`,'PATCH',{title:'New title'},cookie),['comics',comic.id]);expect(rename.status).toBe(200);
    release();const result=await first;expect(result.status).toBe(200);const updated=(await result.json()).comic;
    expect(updated.title).toBe('New title');expect(updated.initialQuestions).toBe('complete');expect(updated.questions[0].question).toBe('Who is the recipient?');
    expect((await post(`comics/${comic.id}/questions/initial`,{},cookie)).status).toBe(200);expect(calls).toBe(1);
  } finally {globalThis.fetch=originalFetch;delete process.env.COMEX_BUDGET_DB_PATH;delete process.env.COMEX_MAX_PROVIDER_CALLS;delete process.env.OPENAI_API_KEY;await rm(dir,{recursive:true,force:true});}
});

test('automatic questions expose failed and unknown outcomes without automatic redispatch', async () => {
  const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const dir=await mkdtemp(join(tmpdir(),'comex-initial-failure-'));const originalFetch=globalThis.fetch;
  process.env.COMEX_BUDGET_DB_PATH=join(dir,'budget.sqlite');process.env.COMEX_MAX_PROVIDER_CALLS='10';process.env.COMEX_MAX_CONCURRENT_CALLS='3';process.env.OPENAI_API_KEY='test';
  try {
    for (const ambiguous of [false,true]) {
      const created=await post('comics',{title:'Failure',plot:'A courier',style:'ink-manga'});const {comic}=await created.json();const cookie=created.headers.get('set-cookie')!.split(';')[0];let calls=0;
      globalThis.fetch=(async ()=>{calls++;if(ambiguous)throw new Error('connection lost');return new Response('{}',{status:400});}) as unknown as typeof fetch;
      expect((await post(`comics/${comic.id}/questions/initial`,{},cookie)).status).toBe(502);
      const get=await handleApi(request(`comics/${comic.id}`,'GET',undefined,cookie),['comics',comic.id]);expect((await get.json()).comic.initialQuestions).toBe(ambiguous?'unknown':'failed');
      expect((await post(`comics/${comic.id}/questions/initial`,{},cookie)).status).toBe(200);expect(calls).toBe(1);
      if (ambiguous) {expect((await post(`comics/${comic.id}/questions`,{},cookie)).status).toBe(409);expect(calls).toBe(1);}
      else {
        globalThis.fetch=(async ()=>{calls++;throw new Error('connection lost on explicit retry');}) as unknown as typeof fetch;
        expect((await post(`comics/${comic.id}/questions`,{},cookie)).status).toBe(502);
        const afterRetry=await handleApi(request(`comics/${comic.id}`,'GET',undefined,cookie),['comics',comic.id]);
        expect((await afterRetry.json()).comic.initialQuestions).toBe('unknown');
      }
    }
  } finally {globalThis.fetch=originalFetch;delete process.env.COMEX_BUDGET_DB_PATH;delete process.env.COMEX_MAX_PROVIDER_CALLS;delete process.env.COMEX_MAX_CONCURRENT_CALLS;delete process.env.OPENAI_API_KEY;await rm(dir,{recursive:true,force:true});}
});

test('legacy browser drafts and their private assets remain accessible without reviving expired or forged sessions', async () => {
  const {mkdtemp,writeFile,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os'); const {join}=await import('node:path');
  const {createBlankComic}=await import('@/src/lib/domain/comic');
  const dir=await mkdtemp(join(tmpdir(),'comex-legacy-owner-'));
  process.env.COMEX_ASSET_PATH=dir;
  try {
    const store=(globalThis as typeof globalThis & {__comexLocalStore:LocalStore}).__comexLocalStore;
    const owner=randomBytes(32).toString('hex'), id=randomBytes(16).toString('hex');
    const assetId='11111111-1111-4111-8111-111111111111';
    const card={id:'legacy-character',name:'Mina',role:'courier',appearance:'red hair',outfit:'coat',approved:true,referenceAssetId:assetId};
    const draft={...createBlankComic(id,owner),title:'Legacy draft',plot:'Delivery',styleId:'ink-manga',characters:[card],questions:[],answers:{}};
    store.create(id,owner,draft);
    const png=Buffer.from([137,80,78,71,13,10,26,10]); await writeFile(join(dir,`${assetId}.png`),png);
    const cookie=`comex_session=${owner}`;
    const list=await handleApi(request('comics','GET',undefined,cookie),['comics']);
    expect(list.status).toBe(200); expect((await list.json()).comics.some((comic:{id:string})=>comic.id===id)).toBe(true);
    expect((await handleApi(request(`comics/${id}`,'GET',undefined,cookie),['comics',id])).status).toBe(200);
    const next=await post('comics',{title:'Next draft',plot:'Another delivery',style:'ink-manga',email:'legacy@example.test'},cookie);
    expect(next.status).toBe(201);expect(store.getOwned((await next.json()).comic.id,owner)).not.toBeNull();
    const image=await handleApi(request(`comics/${id}/assets/${assetId}`,'GET',undefined,cookie),['comics',id,'assets',assetId]);
    expect(image.status).toBe(200); expect(Buffer.from(await image.arrayBuffer())).toEqual(png);
    const unknown=`comex_session=${randomBytes(32).toString('hex')}`;
    expect((await handleApi(request('comics','GET',undefined,unknown),['comics'])).status).toBe(401);
    expect((await handleApi(request(`comics/${id}/assets/${assetId}`,'GET',undefined,unknown),['comics',id,'assets',assetId])).status).toBe(404);
    const expired=store.createGuest('expired@example.test',Date.now()-31*24*60*60*1000);
    store.create(randomBytes(16).toString('hex'),expired.owner,{...draft,id:randomBytes(16).toString('hex'),ownerId:expired.owner});
    for (const value of [expired.token,expired.owner]) expect((await handleApi(request('comics','GET',undefined,`comex_session=${value}`),['comics'])).status).toBe(401);
    const valid=store.createGuest('guest@example.test');
    store.create(randomBytes(16).toString('hex'),valid.owner,{...draft,id:randomBytes(16).toString('hex'),ownerId:valid.owner});
    expect((await handleApi(request('comics','GET',undefined,`comex_session=${valid.token}`),['comics'])).status).toBe(200);
    expect((await handleApi(request('comics','GET',undefined,`comex_session=${valid.owner}`),['comics'])).status).toBe(401);
    const accountCookie=fixtureSession(), accountOwner=accountCookie.split('=')[1];
    store.create(randomBytes(16).toString('hex'),accountOwner,{...draft,id:randomBytes(16).toString('hex'),ownerId:accountOwner});
    expect((await handleApi(request('comics','GET',undefined,`comex_session=${accountOwner}`),['comics'])).status).toBe(401);
  } finally {delete process.env.COMEX_ASSET_PATH;await rm(dir,{recursive:true,force:true});}
});

test('concurrent story operations dispatch once per unchanged draft', async () => {
  const {mkdtemp,rm}=await import('node:fs/promises'); const {tmpdir}=await import('node:os'); const {join}=await import('node:path');
  const {createComic}=await import('@/src/lib/domain/comic');
  const dir=await mkdtemp(join(tmpdir(),'comex-text-lock-')); const originalFetch=globalThis.fetch;
  process.env.COMEX_BUDGET_DB_PATH=join(dir,'budget.sqlite'); process.env.COMEX_MAX_PROVIDER_CALLS='30'; process.env.COMEX_MAX_CONCURRENT_CALLS='4'; process.env.OPENAI_API_KEY='test';
  try {
    const state={location:'town',time:'day',props:[],outfits:[],injuries:[],knowledge:[]};
    const spec=(id:string,index:number)=>({id,index,character_ids:['mina'],action:'Deliver',framing:'wide',dialogue:[],state_before:state,state_after:state});
    const bible={premise:'Delivery',setting:'town',rules:[],character_ids:['mina']};
    const pages=Array.from({length:3},(_,i)=>({index:i+1,panels:Array.from({length:3},(_,j)=>spec(`p${i*3+j+1}`,j+1))}));
    const storyboard={bible,pages};
    const revision={earliest_affected_panel_id:'p1',explanation:'Change the first beat.',revised_bible:bible,revised_suffix:pages.flatMap(p=>p.panels)};
    for(const operation of ['questions','plan','preview','apply'] as const) {
      const created=await post('comics',{title:operation,plot:'Deliver',style:'ink-manga'}); const {comic}=await created.json();
      const cookie=created.headers.get('set-cookie')!.split(';')[0], owner=cookie.split('=')[1];
      const store=(globalThis as typeof globalThis & {__comexLocalStore:import('@/src/lib/local-store').LocalStore}).__comexLocalStore;
      let current=store.getOwned<Record<string,unknown>>(comic.id,owner)!;
      const character={id:'mina',name:'Mina',role:'courier',appearance:'hair',outfit:'coat',approved:true,referenceAssetId:'11111111-1111-4111-8111-111111111111'};
      if (operation !== 'questions') {
        const domain=operation === 'plan' ? {} : createComic({id:comic.id,ownerId:owner,title:operation,creatorName:'',plot:'Deliver',styleId:'ink-manga',pages:pages.map((page,i)=>({id:`page${i+1}`,panels:page.panels.map(p=>({id:p.id,beat:p.action}))}))});
        expect(store.update(comic.id,owner,current.revision,{...current.data,...domain,characters:[character],...(operation === 'plan'?{}:{storyboard}),...(operation === 'apply'?{pendingRevision:{id:'proposal',baseRevision:current.revision+1,result:revision}}:{})})).toBe(true);
        current=store.getOwned<Record<string,unknown>>(comic.id,owner)!;
      }
      let calls=0, release!:()=>void, started!:()=>void; const ready=new Promise<void>(r=>{started=r;}); const gate=new Promise<void>(r=>{release=r;});
      globalThis.fetch=(async (_url:string|URL|Request,init?:RequestInit)=>{
        calls++; if(calls===1){started();await gate;}
        const name=JSON.parse(String(init?.body)).text.format.name;
        const value=name==='narrative_questions'?{questions:[{id:'q1',question:'Where?',suggested_answer:'Town'}]}:name==='storyboard'?storyboard:name==='plot_revision'?revision:{outcome:'findings',findings:[{severity:'blocker',dimension:'story',panel_id:null,character_id:null,reference_id:null,expected:'A',observed:'B',repair:'Fix'}]};
        return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]});
      }) as unknown as typeof fetch;
      const path=operation==='questions'?'questions':operation==='plan'?'story/plan':operation==='preview'?'revisions/preview':'revisions';
      const body=operation==='preview'?{panelId:'p1',instruction:'Change it'}:operation==='apply'?{proposalId:'proposal'}:{};
      const first=post(`comics/${comic.id}/${path}`,body,cookie); await ready;
      const second=await post(`comics/${comic.id}/${path}`,body,cookie); expect(second.status).toBe(409); expect(calls).toBe(1);
      release(); const result=await first; expect(result.status).toBe(200);
      expect(calls).toBe(operation==='plan'?2:1);
    }
  } finally {globalThis.fetch=originalFetch;delete process.env.COMEX_BUDGET_DB_PATH;delete process.env.COMEX_MAX_PROVIDER_CALLS;delete process.env.COMEX_MAX_CONCURRENT_CALLS;delete process.env.OPENAI_API_KEY;await rm(dir,{recursive:true,force:true});}
});

test('unknown text outcome stays reserved and blocks a repeat dispatch', async () => {
  const {mkdtemp,rm}=await import('node:fs/promises'); const {tmpdir}=await import('node:os'); const {join}=await import('node:path');
  const dir=await mkdtemp(join(tmpdir(),'comex-text-unknown-')); const originalFetch=globalThis.fetch;
  process.env.COMEX_BUDGET_DB_PATH=join(dir,'budget.sqlite'); process.env.COMEX_MAX_PROVIDER_CALLS='10'; process.env.COMEX_MAX_CONCURRENT_CALLS='4'; process.env.OPENAI_API_KEY='test';
  try {
    const created=await post('comics',{title:'Unknown',plot:'Deliver',style:'ink-manga'}); const {comic}=await created.json(); const cookie=created.headers.get('set-cookie')!.split(';')[0];
    let calls=0; globalThis.fetch=(async ()=>{calls++; throw new Error('connection lost');}) as unknown as typeof fetch;
    expect((await post(`comics/${comic.id}/questions`,{},cookie)).status).toBe(502);
    expect((await post(`comics/${comic.id}/questions`,{},cookie)).status).toBe(409); expect(calls).toBe(1);
  } finally {globalThis.fetch=originalFetch;delete process.env.COMEX_BUDGET_DB_PATH;delete process.env.COMEX_MAX_PROVIDER_CALLS;delete process.env.COMEX_MAX_CONCURRENT_CALLS;delete process.env.OPENAI_API_KEY;await rm(dir,{recursive:true,force:true});}
});

test('page layout changes composition without changing the published edition or story', async () => {
  const {mkdtemp,writeFile,rm}=await import('node:fs/promises'); const {tmpdir}=await import('node:os'); const {join}=await import('node:path');
  const sharp=(await import('sharp')).default;
  const {createComic,commitPanelRender,acceptPanel}=await import('@/src/lib/domain/comic');
  const dir=await mkdtemp(join(tmpdir(),'comex-grid-')); process.env.COMEX_ASSET_PATH=dir;
  try {
    const created=await post('comics',{title:'Layout',plot:'A delivery',style:'ink-manga'});const {comic}=await created.json();const cookie=created.headers.get('set-cookie')!.split(';')[0],owner=cookie.split('=')[1];
    const store=(globalThis as typeof globalThis & {__comexLocalStore:LocalStore}).__comexLocalStore;
    const ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444'];
    const colors=['#ff0000','#0000ff','#00ff00','#ffff00'];
    for (let i=0;i<ids.length;i++) await writeFile(join(dir,`${ids[i]}.png`),await sharp({create:{width:40,height:40,channels:4,background:colors[i]}}).png().toBuffer());
    let domain=createComic({id:comic.id,ownerId:owner,title:'Layout',creatorName:'',plot:'A delivery',styleId:'ink-manga',pages:[{id:'page1',panels:ids.map((_,i)=>({id:`p${i+1}`,beat:`Beat ${i+1}`}))}]});
    for (let i=0;i<ids.length;i++) {domain=commitPanelRender(domain,owner,`p${i+1}`,{storyRevision:1,panelRevision:1},ids[i],'uncertain');domain=acceptPanel(domain,owner,`p${i+1}`,ids[i],1);}
    const state={location:'town',time:'day',props:[],outfits:[],injuries:[],knowledge:[]};
    const storyboard={bible:{premise:'Delivery',setting:'town',rules:[],character_ids:[]},pages:[{index:1,panels:ids.map((_,i)=>({id:`p${i+1}`,index:i+1,character_ids:[],action:`Beat ${i+1}`,framing:'wide',dialogue:[{speaker_id:'Mina',text:'Hello there.'}],state_before:state,state_after:state}))}]};
    const original=store.getOwned<Record<string,unknown>>(comic.id,owner)!;expect(store.update(comic.id,owner,original.revision,{...original.data,...domain,storyboard})).toBe(true);
    expect((await post(`comics/${comic.id}/publish`,{title:'Old edition',creator:'Mina'},cookie)).status).toBe(200);
    const originalEdition=(await (await handleApi(request(`published/${comic.id}`),['published',comic.id])).json()).comic;
    const oldUrl=new URL(originalEdition.pages[0].imageUrl,'http://localhost:3000');
    const oldImage=await handleApi(new NextRequest(oldUrl),['published',comic.id,'assets',oldUrl.pathname.split('/').pop()!]);
    const oldBytes=Buffer.from(await oldImage.arrayBuffer());
    const changed=await handleApi(request(`comics/${comic.id}`,'PATCH',{pageLayout:'grid'},cookie),['comics',comic.id]);expect(changed.status).toBe(200);
    const updated=(await changed.json()).comic;expect(updated.pageLayout).toBe('grid');expect(updated.unpublishedChanges).toBe(true);expect(updated.pages[0].panels.map((p:any)=>p.imageUrl.split('/').pop())).toEqual(ids);
    const oldAfter=await handleApi(new NextRequest(oldUrl),['published',comic.id,'assets',oldUrl.pathname.split('/').pop()!]);expect(Buffer.from(await oldAfter.arrayBuffer())).toEqual(oldBytes);
    const download=await handleApi(request(`comics/${comic.id}/pages/page1/download`,'GET',undefined,cookie),['comics',comic.id,'pages','page1','download']);expect(download.status).toBe(200);
    const grid=Buffer.from(await download.arrayBuffer());const {data:pixel,info}=await sharp(grid).raw().toBuffer({resolveWithObject:true});
    expect(info.width).toBe(1020);expect(info.height).toBeLessThan((await sharp(oldBytes).metadata()).height!);
    const color=(x:number,y:number)=>Array.from(pixel.subarray((y*info.width+x)*info.channels,(y*info.width+x)*info.channels+3));
    expect(color(260,150)).toEqual([255,0,0]);expect(color(760,150)).toEqual([0,0,255]);expect(color(260,484)).toEqual([0,255,0]);expect(color(760,484)).toEqual([255,255,0]);
    expect((await post(`comics/${comic.id}/publish`,{title:'New edition',creator:'Mina'},cookie)).status).toBe(200);
    const next=(await (await handleApi(request(`published/${comic.id}`),['published',comic.id])).json()).comic;const nextUrl=new URL(next.pages[0].imageUrl,'http://localhost:3000');
    const nextImage=await handleApi(new NextRequest(nextUrl),['published',comic.id,'assets',nextUrl.pathname.split('/').pop()!]);expect(Buffer.from(await nextImage.arrayBuffer())).toEqual(grid);
    expect((await post(`comics/${comic.id}/unpublish`,{},cookie)).status).toBe(200);
  } finally {delete process.env.COMEX_ASSET_PATH;await rm(dir,{recursive:true,force:true});}
});

describe('local HTTP boundary', () => {
  test('draft ownership, private fields and unready publication', async () => {
    const created = await post('comics', {title:'Courier',plot:'Deliver a key',style:'clear-line-adventure'});
    expect(created.status).toBe(201);
    const {comic} = await created.json();
    const cookie = created.headers.get('set-cookie')!.split(';')[0];
    expect(cookie).toContain('comex_auth=');
    const mine = await handleApi(request(`comics/${comic.id}`,'GET',undefined,cookie), ['comics',comic.id]);
    expect(mine.status).toBe(200);
    const data = await mine.json();
    expect(data.comic.plot).toBe('Deliver a key');
    expect(data.comic.ownerId).toBeUndefined();
    const other = await handleApi(request(`comics/${comic.id}`), ['comics',comic.id]);
    expect(other.status).toBe(404);
    const stranger = await post(`comics/${comic.id}/publish`, {title:'Stolen',creator:'Other'});
    expect(stranger.status).toBe(404);
    const incomplete = await post(`comics/${comic.id}/publish`, {title:'Courier',creator:'A'},cookie);
    expect(incomplete.status).toBe(409);
    expect((await post(`comics/${comic.id}/not-a-route`,{},cookie)).status).toBe(404);
    const gallery = await handleApi(request('published'), ['published']);
    expect((await gallery.json()).comics).toEqual([]);
  });
  test('rejects cross-origin changes and invalid input without creating a draft', async () => {
    const result = await post('comics', {title:'X',plot:'Y',style:'ink-manga'}, undefined, 'https://evil.example');
    expect(result.status).toBe(403);
    const invalid = await post('comics', {title:'',plot:'Y',style:'bogus'});
    expect(invalid.status).toBe(400);
    const publicList = await handleApi(request('published'), ['published']);
    expect((await publicList.json()).comics).toEqual([]);
  });
});

test('character approval applies only to the reviewed reference and waits for pending draws', async () => {
  const created=await post('comics',{title:'Reference race',plot:'Deliver',style:'ink-manga'});
  const {comic}=await created.json();const cookie=created.headers.get('set-cookie')!.split(';')[0],owner=cookie.split('=')[1];
  const added=await post(`comics/${comic.id}/characters`,{name:'Mina',role:'Courier',appearance:'Hair',outfit:'Coat'},cookie);
  const characterId=(await added.json()).comic.characters[0].id;
  const store=(globalThis as typeof globalThis & {__comexLocalStore:LocalStore}).__comexLocalStore;
  const assetA='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',assetB='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  let current=store.getOwned<any>(comic.id,owner)!;
  expect(store.update(comic.id,owner,current.revision,{...current.data,characters:[{...current.data.characters[0],referenceAssetId:assetA,referenceUrl:`/api/comics/${comic.id}/assets/${assetA}`}]})).toBe(true);
  const viewed=(await (await handleApi(request(`comics/${comic.id}`,'GET',undefined,cookie),['comics',comic.id])).json()).comic.characters[0];
  current=store.getOwned<any>(comic.id,owner)!;
  expect(store.update(comic.id,owner,current.revision,{...current.data,characters:[{...current.data.characters[0],referenceAssetId:assetB,referenceUrl:`/api/comics/${comic.id}/assets/${assetB}`}]})).toBe(true);
  const url=`comics/${comic.id}/characters/${characterId}/approve`;
  expect((await post(url,{},cookie)).status).toBe(400);
  expect((await post(url,{assetId:assetA},cookie)).status).toBe(409);
  expect(store.getOwned<any>(comic.id,owner)!.data.characters[0].approved).toBe(false);
  current=store.getOwned<any>(comic.id,owner)!;
  expect(store.update(comic.id,owner,current.revision,{...current.data,operations:{[`character:${characterId}`]:'running'}})).toBe(true);
  expect((await post(url,{assetId:assetB},cookie)).status).toBe(409);
  current=store.getOwned<any>(comic.id,owner)!;
  expect(store.update(comic.id,owner,current.revision,{...current.data,operations:{}})).toBe(true);
  expect((await post(url,{assetId:assetB},cookie)).status).toBe(200);
  current=store.getOwned<any>(comic.id,owner)!;
  expect(store.update(comic.id,owner,current.revision,{...current.data,operations:{[`character:${characterId}`]:'running'}})).toBe(true);
  expect((await post(`comics/${comic.id}/story/plan`,{},cookie)).status).toBe(409);
  expect(viewed.referenceVersion).toBe(assetA);
});

test('character cards can be edited and removed without retaining a stale reference', async () => {
  const created = await post('comics', {title:'Cards',plot:'Deliver a key',style:'ink-manga'});
  const {comic} = await created.json();
  const cookie = created.headers.get('set-cookie')!.split(';')[0];
  const owner = cookie.split('=')[1];
  const originalCard = {name:'Mina',role:'Courier',appearance:'Black hair',outfit:'Blue coat'};
  const added = await post(`comics/${comic.id}/characters`, originalCard, cookie);
  const characterId = (await added.json()).comic.characters[0].id;
  const store = (globalThis as typeof globalThis & {__comexLocalStore: import('@/src/lib/local-store').LocalStore}).__comexLocalStore;
  const current = store.getOwned<any>(comic.id,owner)!;
  const assetId = '11111111-1111-4111-8111-111111111111';
  const originalUrl = `/api/comics/${comic.id}/assets/${assetId}`;
  expect(store.update(comic.id,owner,current.revision,{...current.data,characters:[{...current.data.characters[0],approved:true,referenceAssetId:assetId,referenceUrl:originalUrl}]})).toBe(true);
  const path = `comics/${comic.id}/characters/${characterId}`;
  const run = (method:string, body:unknown, givenCookie = cookie, origin?:string) => handleApi(request(path,method,body,givenCookie,origin),path.split('/'));
  expect((await run('PATCH',originalCard,'')).status).toBe(404);
  expect((await run('PATCH',originalCard,cookie,'https://evil.example')).status).toBe(403);
  const unchanged = await run('PATCH',originalCard);
  expect((await unchanged.json()).comic.characters[0].approved).toBe(true);
  const changed = await run('PATCH',{...originalCard,appearance:'Red hair'});
  expect(changed.status).toBe(200);
  const card = (await changed.json()).comic.characters[0];
  expect(card.appearance).toBe('Red hair'); expect(card.approved).toBe(false); expect(card.referenceUrl).toBeUndefined();
  expect((await handleApi(request(`comics/${comic.id}/assets/${assetId}`,'GET',undefined,cookie),['comics',comic.id,'assets',assetId])).status).toBe(404);
  expect((await post(`comics/${comic.id}/characters/${characterId}/approve`,{assetId},cookie)).status).toBe(409);
  const pending = store.getOwned<any>(comic.id,owner)!;
  expect(store.update(comic.id,owner,pending.revision,{...pending.data,operations:{[`character:${characterId}`]:'running'}})).toBe(true);
  expect((await run('PATCH',originalCard)).status).toBe(409);
  expect((await run('DELETE',{})).status).toBe(409);
  const planned = store.getOwned<any>(comic.id,owner)!;
  expect(store.update(comic.id,owner,planned.revision,{...planned.data,operations:{},pages:[{id:'planned',panels:[]}]})).toBe(true);
  expect((await run('PATCH',originalCard)).status).toBe(409);
  expect((await run('DELETE',{})).status).toBe(409);
  const unplanned = store.getOwned<any>(comic.id,owner)!;
  expect(store.update(comic.id,owner,unplanned.revision,{...unplanned.data,pages:[]})).toBe(true);
  const removed = await run('DELETE',{}); expect(removed.status).toBe(200); expect((await removed.json()).comic.characters).toEqual([]);
  expect((await run('DELETE',{})).status).toBe(404);
});

test('publication snapshots are isolated, pinned, and withdrawn', async () => {
  const { mkdtemp, mkdir, writeFile, readdir, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const sharp = (await import('sharp')).default;
  const {createComic, commitPanelRender, acceptPanel} = await import('@/src/lib/domain/comic');
  const dir = await mkdtemp(join(tmpdir(), 'comex-assets-')); process.env.COMEX_ASSET_PATH = dir;
  try {
    const created = await post('comics', {title:'Secret draft',plot:'Deliver a key',style:'clear-line-adventure'});
    const {comic} = await created.json();
    const cookie = created.headers.get('set-cookie')!.split(';')[0];
    const owner = cookie.split('=')[1];
    const store = (globalThis as typeof globalThis & {__comexLocalStore: import('@/src/lib/local-store').LocalStore}).__comexLocalStore;
    const original = store.getOwned<Record<string, unknown>>(comic.id,owner)!;
    const assetId = '11111111-1111-4111-8111-111111111111';
    await mkdir(dir,{recursive:true});
    await writeFile(join(dir,`${assetId}.png`), await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="20" height="20" fill="#ff0000"/><rect x="20" width="20" height="20" fill="#0000ff"/></svg>')).png().toBuffer());
    let domain = createComic({id:comic.id,ownerId:owner,title:'Secret draft',creatorName:'A',plot:'Deliver a key',styleId:'clear-line-adventure',pages:[{id:'page1',panels:[{id:'p1',beat:'Mina delivers'}]}]});
    domain = commitPanelRender(domain,owner,'p1',{storyRevision:1,panelRevision:1},assetId,'uncertain');
    domain = acceptPanel(domain,owner,'p1',assetId,1);
    const storyboard = {bible:{premise:'Deliver',setting:'town',rules:[],character_ids:[]},pages:[{index:1,panels:[{id:'p1',index:1,character_ids:[],action:'Deliver',framing:'wide',dialogue:[{speaker_id:'mina',text:'界'.repeat(225)}],state_before:{location:'town',time:'day',props:[],outfits:[],injuries:[],knowledge:[]},state_after:{location:'town',time:'day',props:[],outfits:[],injuries:[],knowledge:[]}}]}]};
    expect(store.update(comic.id,owner,original.revision,{...original.data,...domain,storyboard})).toBe(true);
    const legacyUrl = `/api/published/${comic.id}/assets/${assetId}?edition=legacy`;
    expect(store.publish(comic.id,owner,original.revision+1,{id:comic.id,title:'Legacy',creator:'Mina',editionId:'legacy',sourceRevision:original.revision+2,pages:[{id:'page1',imageUrl:legacyUrl}]})).toBe(true);
    expect((await handleApi(new NextRequest(`http://localhost:3000${legacyUrl}`),['published',comic.id,'assets',assetId])).status).toBe(200);
    const published = await post(`comics/${comic.id}/publish`,{title:'Public comic',creator:'Mina'},cookie);
    expect(published.status).toBe(200);
    const reopened = await handleApi(request(`comics/${comic.id}`,'GET',undefined,cookie),['comics',comic.id]);
    expect((await reopened.json()).comic.publication).toMatchObject({title:'Public comic',creator:'Mina',editionId:expect.any(String)});
    const reader = await handleApi(request(`published/${comic.id}`),['published',comic.id]);
    const publicComic = (await reader.json()).comic;
    expect(publicComic.title).toBe('Public comic');
    expect(publicComic.pages.length).toBe(1);
    const gallery=(await (await handleApi(request('published'),['published'])).json()).comics;
    const coverUrl=new URL(gallery.find((item:any)=>item.id===comic.id).coverUrl,'http://localhost:3000');
    const cover=await handleApi(new NextRequest(coverUrl),['published',comic.id,'assets',coverUrl.pathname.split('/').pop()!]);
    expect(cover.status).toBe(200);
    expect(Buffer.from(await cover.arrayBuffer())).toEqual(await (await import('node:fs/promises')).readFile(join(dir,`${assetId}.png`)));
    const url = new URL(publicComic.pages[0].imageUrl,'http://localhost:3000');
    const image = await handleApi(new NextRequest(url), ['published',comic.id,'assets',url.pathname.split('/').pop()!]);
    expect(image.status).toBe(200); expect(image.headers.get('content-type')).toBe('image/png');
    const imageBytes = Buffer.from(await image.arrayBuffer());
    const meta = await sharp(imageBytes).metadata(); expect(meta.height).toBeGreaterThan(600);
    const {data:pixels,info} = await sharp(imageBytes).raw().toBuffer({resolveWithObject:true});
    const color = (x:number,y:number) => Array.from(pixels.subarray((y*info.width+x)*info.channels,(y*info.width+x)*info.channels+3));
    expect(color(110,200)).toEqual([255,0,0]); expect(color(910,200)).toEqual([0,0,255]);
    const filesBeforeDownloads = await readdir(dir);
    const download = await handleApi(request(`comics/${comic.id}/pages/page1/download`,'GET',undefined,cookie),['comics',comic.id,'pages','page1','download']);
    expect(download.status).toBe(200); expect(download.headers.get('content-disposition')).toContain('attachment');
    const firstBytes = await download.arrayBuffer();
    const second = await handleApi(request(`comics/${comic.id}/pages/page1/download`,'GET',undefined,cookie),['comics',comic.id,'pages','page1','download']);
    expect(second.status).toBe(200);
    expect(Buffer.from(await second.arrayBuffer())).toEqual(Buffer.from(firstBytes));
    expect((await readdir(dir)).sort()).toEqual(filesBeforeDownloads.sort());
    expect((await handleApi(request(`comics/${comic.id}/pages/page1/download`),['comics',comic.id,'pages','page1','download'])).status).toBe(404);
    const wrongEdition = await handleApi(new NextRequest(`http://localhost:3000${url.pathname}?edition=old`), ['published',comic.id,'assets',url.pathname.split('/').pop()!]);
    expect(wrongEdition.status).toBe(404);
    const privateImage = await handleApi(request(`comics/${comic.id}/assets/${assetId}`), ['comics',comic.id,'assets',assetId]);
    expect(privateImage.status).toBe(404);
    const concurrent = await Promise.all([
      post(`comics/${comic.id}/publish`,{title:'Second',creator:'Mina'},cookie),
      post(`comics/${comic.id}/publish`,{title:'Third',creator:'Mina'},cookie),
    ]);
    expect(concurrent.map(response => response.status).sort()).toEqual([200,409]);
    const winner = concurrent.find(response => response.status === 200)!;
    expect((await winner.json()).comic.unpublishedChanges).toBe(false);
    expect((await handleApi(new NextRequest(url), ['published',comic.id,'assets',url.pathname.split('/').pop()!])).status).toBe(404);
    const latest = (await (await handleApi(request(`published/${comic.id}`),['published',comic.id])).json()).comic;
    const latestUrl = new URL(latest.pages[0].imageUrl,'http://localhost:3000');
    expect((await handleApi(new NextRequest(latestUrl), ['published',comic.id,'assets',latestUrl.pathname.split('/').pop()!])).status).toBe(200);
    expect((await readdir(dir)).sort()).toEqual(filesBeforeDownloads.sort());
    const changed = await handleApi(request(`comics/${comic.id}`,'PATCH',{title:'Private change'},cookie), ['comics',comic.id]);
    expect(changed.status).toBe(200);
    expect((await changed.json()).comic.unpublishedChanges).toBe(true);
    expect((await (await handleApi(request(`published/${comic.id}`),['published',comic.id])).json()).comic.title).toBe(latest.title);
    const withdrawn = await post(`comics/${comic.id}/unpublish`,{},cookie); expect(withdrawn.status).toBe(200);
    expect((await handleApi(new NextRequest(latestUrl), ['published',comic.id,'assets',latestUrl.pathname.split('/').pop()!])).status).toBe(404);
  } finally { delete process.env.COMEX_ASSET_PATH; await rm(dir,{recursive:true,force:true}); }
});

test('same-origin checks use the browser Host header rather than normalized Next URL', async () => {
  const headers = {'content-type':'application/json','host':'127.0.0.1:3100','origin':'http://127.0.0.1:3100',cookie:fixtureSession()};
  const payload = JSON.stringify({title:'Host test',plot:'A courier',style:'ink-manga'});
  const accepted = await handleApi(new NextRequest('http://localhost:3100/api/comics',{method:'POST',headers,body:payload}),['comics']);
  expect(accepted.status).toBe(201);
  const localhost = await handleApi(new NextRequest('http://localhost:3100/api/comics',{method:'POST',headers:{...headers,host:'localhost:3100',origin:'http://localhost:3100'},body:payload}),['comics']);
  expect(localhost.status).toBe(201);
  const mismatch = await handleApi(new NextRequest('http://localhost:3100/api/comics',{method:'POST',headers:{...headers,origin:'http://localhost:3100'},body:payload}),['comics']);
  expect(mismatch.status).toBe(403);
});

test('a failed image dispatch records unknown outcome and avoids another paid request', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const sharp = (await import('sharp')).default;
  const { createComic } = await import('@/src/lib/domain/comic');
  const dir = await mkdtemp(join(tmpdir(),'comex-render-')); process.env.COMEX_ASSET_PATH = dir; process.env.OPENAI_API_KEY = 'test'; process.env.COMEX_BUDGET_DB_PATH = join(dir,'budget.sqlite'); process.env.COMEX_MAX_PROVIDER_CALLS = '3';
  const originalFetch = globalThis.fetch; let calls = 0;
  try {
    const created = await post('comics',{title:'Image',plot:'Deliver',style:'ink-manga'});
    const {comic} = await created.json(); const cookie = created.headers.get('set-cookie')!.split(';')[0]; const owner = cookie.split('=')[1];
    const store = (globalThis as typeof globalThis & {__comexLocalStore: import('@/src/lib/local-store').LocalStore}).__comexLocalStore;
    const original = store.getOwned<Record<string, unknown>>(comic.id,owner)!;
    const referenceAssetId = '22222222-2222-4222-8222-222222222222';
    await writeFile(join(dir,`${referenceAssetId}.png`),await sharp({create:{width:8,height:8,channels:4,background:'#fff'}}).png().toBuffer());
    const domain = createComic({id:comic.id,ownerId:owner,title:'Image',creatorName:'',plot:'Deliver',styleId:'ink-manga',pages:[{id:'page1',panels:[{id:'p1',beat:'Mina arrives'}]}]});
    const state={location:'town',time:'day',props:[],outfits:[],injuries:[],knowledge:[]};
    const storyboard={bible:{premise:'Deliver',setting:'town',rules:[],character_ids:['mina']},pages:[{index:1,panels:[{id:'p1',index:1,character_ids:['mina'],action:'Arrives',framing:'wide',dialogue:[],state_before:state,state_after:state}]}]};
    expect(store.update(comic.id,owner,original.revision,{...original.data,...domain,storyboard,characters:[{id:'mina',name:'Mina',role:'courier',appearance:'hair',outfit:'coat',approved:true,referenceAssetId}]})).toBe(true);
    await approveSeededStory(comic.id,cookie);
    globalThis.fetch = (async () => {calls++; throw new Error('network timed out');}) as unknown as typeof fetch;
    const first = await post(`comics/${comic.id}/pages/page1/generate`,{},cookie);
    expect(first.status).toBe(502); expect((await first.json()).code).toBe('unknown_outcome');
    const second = await post(`comics/${comic.id}/pages/page1/generate`,{},cookie);
    expect(second.status).toBe(409); expect(calls).toBe(1);
  } finally { globalThis.fetch=originalFetch; delete process.env.OPENAI_API_KEY; delete process.env.COMEX_ASSET_PATH; delete process.env.COMEX_BUDGET_DB_PATH; delete process.env.COMEX_MAX_PROVIDER_CALLS; await rm(dir,{recursive:true,force:true}); }
});

test('story planning removes only identical duplicate state facts before validating', async () => {
  const {mkdtemp,rm}=await import('node:fs/promises'); const {tmpdir}=await import('node:os'); const {join}=await import('node:path');
  const dir=await mkdtemp(join(tmpdir(),'comex-ledger-duplicates-')); const originalFetch=globalThis.fetch;
  process.env.COMEX_BUDGET_DB_PATH=join(dir,'budget.sqlite'); process.env.COMEX_MAX_PROVIDER_CALLS='10'; process.env.OPENAI_API_KEY='test';
  try {
    for (const conflicting of [false,true]) {
      const created=await post('comics',{title:'Ledger',plot:'Deliver a key',style:'ink-manga'});
      const {comic}=await created.json(); const cookie=created.headers.get('set-cookie')!.split(';')[0],owner=cookie.split('=')[1];
      const store=(globalThis as typeof globalThis & {__comexLocalStore:LocalStore}).__comexLocalStore;
      const record=store.getOwned<Record<string,unknown>>(comic.id,owner)!;
      const characters=[{id:'mina',name:'Mina',role:'courier',appearance:'hair',outfit:'coat',approved:true,referenceAssetId:'11111111-1111-4111-8111-111111111111'}];
      expect(store.update(comic.id,owner,record.revision,{...record.data,characters})).toBe(true);
      const fact={key:'mina_knows',value:'the key opens the door'};
      const state={location:'town',time:'day',props:[{key:'key',value:'mina'},{key:'key',value:'mina'}],outfits:[{key:'mina',value:'coat'},{key:'mina',value:'coat'}],injuries:[{key:'mina',value:'none'},{key:'mina',value:'none'}],knowledge:[fact,{...fact,value:conflicting?'the key is lost':fact.value}]};
      const pages=Array.from({length:3},(_,i)=>({index:i+1,panels:Array.from({length:3},(_,j)=>({id:`p${i*3+j+1}`,index:j+1,character_ids:['mina'],action:'Deliver',framing:'wide',dialogue:[],state_before:state,state_after:state}))}));
      const storyboard={bible:{premise:'Delivery',setting:'town',rules:[],character_ids:['mina']},pages};
      let calls=0;
      globalThis.fetch=(async (_url:string|URL|Request,init?:RequestInit)=>{
        calls++;
        const name=JSON.parse(String(init?.body)).text.format.name;
        const value=name==='storyboard'?storyboard:{outcome:'inconclusive',findings:[]};
        return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]});
      }) as unknown as typeof fetch;
      const planned=await post(`comics/${comic.id}/story/plan`,{},cookie);
      if (conflicting) {
        expect(planned.status).toBe(422);
        expect((await planned.json()).error).toContain('duplicate knowledge');
        expect(calls).toBe(1);
        expect(store.getOwned<any>(comic.id,owner)!.data.storyboard).toBeUndefined();
      } else {
        expect(planned.status).toBe(200);
        expect(calls).toBe(2);
        const saved=store.getOwned<any>(comic.id,owner)!.data.storyboard;
        for (const panel of saved.pages.flatMap((page:any)=>page.panels)) for (const panelState of [panel.state_before,panel.state_after]) {
          expect(panelState.props).toEqual([{key:'key',value:'mina'}]);
          expect(panelState.outfits).toEqual([{key:'mina',value:'coat'}]);
          expect(panelState.injuries).toEqual([{key:'mina',value:'none'}]);
          expect(panelState.knowledge).toEqual([fact]);
        }
      }
    }
  } finally {globalThis.fetch=originalFetch;delete process.env.COMEX_BUDGET_DB_PATH;delete process.env.COMEX_MAX_PROVIDER_CALLS;delete process.env.OPENAI_API_KEY;await rm(dir,{recursive:true,force:true});}
});

test('storyboard ledger rejects unexplained location or prop ownership changes', async () => {
  const {validateStoryLedger} = await import('@/src/lib/local-api');
  const state = {location:'station',time:'day',props:[{key:'key',value:'mina'}],outfits:[],injuries:[],knowledge:[]};
  const panel = (id:string,before:typeof state,after:typeof state) => ({id,index:1,character_ids:['mina'],action:'Move',framing:'wide',dialogue:[],state_before:before,state_after:after});
  const storyboard = {bible:{premise:'Delivery',setting:'station',rules:[],character_ids:['mina']},pages:[{index:1,panels:[panel('p1',state,state),panel('p2',{...state,location:'tower',props:[{key:'key',value:'pip'}]},state)]}]};
  const issues = validateStoryLedger(storyboard);
  expect(issues.some(x => x.includes('scene state'))).toBe(true);
  expect(issues.some(x => x.includes('props'))).toBe(true);
  storyboard.pages[0].panels[1].state_before = state;
  expect(validateStoryLedger(storyboard)).toEqual([]);
});

test('blocks DNS rebinding even when host and origin match', async () => {
  const payload = JSON.stringify({title:'X',plot:'Y',style:'ink-manga'});
  const request = new NextRequest('http://localhost:3100/api/comics',{method:'POST',headers:{'content-type':'application/json',host:'evil.example:3100',origin:'http://evil.example:3100'},body:payload});
  expect((await handleApi(request,['comics'])).status).toBe(403);
});

test('resuming a partially failed whole-page regeneration preserves completed panel', async () => {
  const {mkdtemp,writeFile,rm} = await import('node:fs/promises'); const {tmpdir} = await import('node:os'); const {join} = await import('node:path');
  const sharp = (await import('sharp')).default; const {createComic,commitPanelRender} = await import('@/src/lib/domain/comic');
  const dir=await mkdtemp(join(tmpdir(),'comex-page-')); process.env.COMEX_ASSET_PATH=dir; process.env.COMEX_BUDGET_DB_PATH=join(dir,'budget.sqlite'); process.env.COMEX_MAX_PROVIDER_CALLS='10'; process.env.OPENAI_API_KEY='test';
  const originalFetch=globalThis.fetch; let imageCalls=0;
  try {
    const png=await sharp({create:{width:8,height:8,channels:4,background:'#fcc'}}).png().toBuffer();
    const ids=['33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444','55555555-5555-4555-8555-555555555555'];
    for(const id of ids) await writeFile(join(dir,`${id}.png`),png);
    const created=await post('comics',{title:'Page',plot:'Delivery',style:'ink-manga'}); const {comic}=await created.json(); const cookie=created.headers.get('set-cookie')!.split(';')[0], owner=cookie.split('=')[1];
    const store=(globalThis as typeof globalThis & {__comexLocalStore: import('@/src/lib/local-store').LocalStore}).__comexLocalStore;
    const existing=store.getOwned<Record<string,unknown>>(comic.id,owner)!;
    let domain=createComic({id:comic.id,ownerId:owner,title:'Page',creatorName:'',plot:'Delivery',styleId:'ink-manga',pages:[{id:'page1',panels:[{id:'p1',beat:'Arrives'},{id:'p2',beat:'Leaves'}]}]});
    domain=commitPanelRender(domain,owner,'p1',{storyRevision:1,panelRevision:1},ids[1],'uncertain');
    domain=commitPanelRender(domain,owner,'p2',{storyRevision:1,panelRevision:1},ids[2],'uncertain');
    const state={location:'town',time:'day',props:[],outfits:[],injuries:[],knowledge:[]};
    const panel=(id:string,index:number)=>({id,index,character_ids:['mina'],action:id,framing:'wide',dialogue:[],state_before:state,state_after:state});
    const storyboard={bible:{premise:'Delivery',setting:'town',rules:[],character_ids:['mina']},pages:[{index:1,panels:[panel('p1',1),panel('p2',2)]}]};
    expect(store.update(comic.id,owner,existing.revision,{...existing.data,...domain,storyboard,characters:[{id:'mina',name:'Mina',role:'courier',appearance:'hair',outfit:'coat',approved:true,referenceAssetId:ids[0]}]})).toBe(true);
    await approveSeededStory(comic.id,cookie);
    globalThis.fetch=(async (url: string | URL | Request) => {
      if (String(url).includes('/images/')) { imageCalls++; if (imageCalls === 2) return new Response('{}',{status:400}); return Response.json({data:[{b64_json:png.toString('base64')}]}); }
      return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({outcome:'inconclusive',findings:[]})}]}]});
    }) as unknown as typeof fetch;
    const first=await post(`comics/${comic.id}/pages/page1/generate`,{},cookie); expect(first.status).toBe(502);
    const afterFirst=store.getOwned<{pages:{panels:{assetId:string}[]}[]}>(comic.id,owner)!.data.pages[0].panels;
    const firstReplaced=afterFirst[0].assetId; expect(firstReplaced).not.toBe(ids[1]); expect(afterFirst[1].assetId).toBe(ids[2]);
    const resume=await post(`comics/${comic.id}/pages/page1/generate`,{},cookie); expect(resume.status).toBe(200);
    const afterResume=store.getOwned<{pages:{panels:{assetId:string}[]}[]}>(comic.id,owner)!.data.pages[0].panels;
    expect(afterResume[0].assetId).toBe(firstReplaced); expect(afterResume[1].assetId).not.toBe(ids[2]); expect(imageCalls).toBe(3);
  } finally {globalThis.fetch=originalFetch; delete process.env.COMEX_ASSET_PATH;delete process.env.COMEX_BUDGET_DB_PATH;delete process.env.COMEX_MAX_PROVIDER_CALLS;delete process.env.OPENAI_API_KEY;await rm(dir,{recursive:true,force:true});}
});

test('missing finite budget rejects an AI request before provider dispatch', async () => {
  const {mkdtemp,rm} = await import('node:fs/promises'); const {tmpdir} = await import('node:os'); const {join} = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(),'comex-no-budget-')); process.env.COMEX_BUDGET_DB_PATH=join(dir,'budget.sqlite'); process.env.OPENAI_API_KEY='test'; delete process.env.COMEX_MAX_PROVIDER_CALLS;
  const originalFetch=globalThis.fetch; let calls=0;
  try {
    const created=await post('comics',{title:'Budget',plot:'Delivery',style:'ink-manga'}); const {comic}=await created.json(); const cookie=created.headers.get('set-cookie')!.split(';')[0];
    globalThis.fetch=(async () => {calls++; throw new Error('must not dispatch');}) as unknown as typeof fetch;
    const response=await post(`comics/${comic.id}/questions`,{},cookie);
    expect(response.status).toBe(503); expect((await response.json()).code).toBe('budget_not_configured'); expect(calls).toBe(0);
  } finally { globalThis.fetch=originalFetch; delete process.env.OPENAI_API_KEY; delete process.env.COMEX_BUDGET_DB_PATH; await rm(dir,{recursive:true,force:true}); }
});

test('revision preview names earlier impact and apply preserves frozen prefix', async () => {
  const {mkdtemp,writeFile,rm}=await import('node:fs/promises'); const {tmpdir}=await import('node:os'); const {join}=await import('node:path');
  const sharp=(await import('sharp')).default; const {createComic,commitPanelRender}=await import('@/src/lib/domain/comic');
  const dir=await mkdtemp(join(tmpdir(),'comex-revision-')); process.env.COMEX_ASSET_PATH=dir;process.env.COMEX_BUDGET_DB_PATH=join(dir,'budget.sqlite');process.env.COMEX_MAX_PROVIDER_CALLS='10';process.env.OPENAI_API_KEY='test';
  const originalFetch=globalThis.fetch;
  try {
    const png=await sharp({create:{width:8,height:8,channels:4,background:'#fed'}}).png().toBuffer();
    const ids=['66666666-6666-4666-8666-666666666666','77777777-7777-4777-8777-777777777777','88888888-8888-4888-8888-888888888888','99999999-9999-4999-8999-999999999999'];
    for(const assetId of ids) await writeFile(join(dir,`${assetId}.png`),png);
    const created=await post('comics',{title:'Revision',plot:'Deliver',style:'ink-manga'});const {comic}=await created.json();const cookie=created.headers.get('set-cookie')!.split(';')[0],owner=cookie.split('=')[1];
    const store=(globalThis as typeof globalThis & {__comexLocalStore:import('@/src/lib/local-store').LocalStore}).__comexLocalStore;const current=store.getOwned<Record<string,unknown>>(comic.id,owner)!;
    let domain=createComic({id:comic.id,ownerId:owner,title:'Revision',creatorName:'',plot:'Deliver',styleId:'ink-manga',pages:[{id:'page1',panels:[{id:'p1',beat:'A'}]},{id:'page2',panels:[{id:'p2',beat:'B'}]},{id:'page3',panels:[{id:'p3',beat:'C'}]}]});
    for(let i=1;i<=3;i++) domain=commitPanelRender(domain,owner,`p${i}`,{storyRevision:1,panelRevision:1},ids[i],'pass');
    domain.pages[0].panels[0]={...domain.pages[0].panels[0],status:'checking',evaluation:'uncertain'};
    const state={location:'town',time:'day',props:[],outfits:[],injuries:[],knowledge:[]};const spec=(id:string,action:string)=>({id,index:1,character_ids:['mina'],action,framing:'wide',dialogue:[],state_before:state,state_after:state});
    const original=[spec('p1','A'),spec('p2','B'),spec('p3','C')];const bible={premise:'Delivery',setting:'town',rules:[],character_ids:['mina']};
    const storyboard={bible,pages:original.map((p,i)=>({index:i+1,panels:[p]}))};
    expect(store.update(comic.id,owner,current.revision,{...current.data,...domain,storyboard,characters:[{id:'mina',name:'Mina',role:'courier',appearance:'hair',outfit:'coat',approved:true,referenceAssetId:ids[0]}]})).toBe(true);
    store.putAdvisoryReview(comic.id,owner,`panel:p1:${ids[1]}:1:2`,{outcome:'pass',findings:[]});
    let images=0;globalThis.fetch=(async (url:string|URL|Request,init?:RequestInit)=>{
      if(String(url).includes('/images/')){images++;return Response.json({data:[{b64_json:png.toString('base64')}]});}
      const name=JSON.parse(String(init?.body)).text.format.name;
      const learned={...state,knowledge:[{key:'mina',value:'knows the recipient'},{key:'mina',value:'knows the recipient'}]};
      const value=name==='plot_revision'?{earliest_affected_panel_id:'p2',explanation:'The key changes hands earlier.',revised_bible:bible,revised_suffix:[{...spec('p2','New B'),dialogue:[{speaker_id:'mina',text:'I have the key.'}],state_after:learned},{...spec('p3','New C'),state_before:learned,state_after:learned}]}:{outcome:'inconclusive',findings:[]};
      return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]});
    }) as unknown as typeof fetch;
    const preview=await post(`comics/${comic.id}/revisions/preview`,{panelId:'p3',instruction:'Keep the key'},cookie);expect(preview.status).toBe(200);const {proposal}=await preview.json();
    expect(proposal.affectedPage).toBe(2);expect(proposal.earliestPanelId).toBe('p2');
    expect(proposal.panels).toEqual([{id:'p2',page:2,panel:1,previousAction:'B',action:'New B',dialogue:[{speaker:'Mina',text:'I have the key.'}]},{id:'p3',page:3,panel:1,previousAction:'C',action:'New C',dialogue:[]}]);
    const restored=(await (await handleApi(request(`comics/${comic.id}`,'GET',undefined,cookie),['comics',comic.id])).json()).comic.pendingRevision;
    expect(restored.id).toBe(proposal.id);expect(restored.panels).toEqual(proposal.panels);expect(restored.instruction).toBe('Keep the key');
    const savedProposal=store.getOwned<any>(comic.id,owner)!.data.pendingRevision;
    expect(savedProposal.result.revised_suffix[0].state_after.knowledge).toEqual([{key:'mina',value:'knows the recipient'}]);
    expect(savedProposal.result.revised_suffix[1].state_before.knowledge).toEqual([{key:'mina',value:'knows the recipient'}]);
    expect(store.getOwned<{storyRevision:number}>(comic.id,owner)!.data.storyRevision).toBe(1);
    const invalid=await post(`comics/${comic.id}/revisions`,{proposalId:'wrong'},cookie);expect(invalid.status).toBe(409);
    const apply=await post(`comics/${comic.id}/revisions`,{proposalId:proposal.id},cookie);expect(apply.status).toBe(200);
    const prefix=(await apply.json()).comic.pages[0].panels[0];expect(prefix.reviewOutcome).toBe('pass');expect(prefix.reviewed).toBe(true);
    expect(store.getOwned<any>(comic.id,owner)!.data.storyboard.pages[1].panels[0].state_after.knowledge).toEqual([{key:'mina',value:'knows the recipient'}]);
    const final=store.getOwned<{storyRevision:number,pages:{panels:{id:string,assetId:string,status:string}[]}[]}>(comic.id,owner)!.data;
    expect(final.storyRevision).toBe(2);expect(final.pages[0].panels[0].assetId).toBe(ids[1]);expect(final.pages[1].panels[0].assetId).not.toBe(ids[2]);expect(final.pages[2].panels[0].assetId).toBe(ids[3]);expect(final.pages[2].panels[0].status).toBe('outdated');expect(images).toBe(1);
  } finally {globalThis.fetch=originalFetch;delete process.env.COMEX_ASSET_PATH;delete process.env.COMEX_BUDGET_DB_PATH;delete process.env.COMEX_MAX_PROVIDER_CALLS;delete process.env.OPENAI_API_KEY;await rm(dir,{recursive:true,force:true});}
});

test('artwork edit is bound to the viewed panel before and after classification', async () => {
  const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const {createComic,commitPanelRender,reviseStory}=await import('@/src/lib/domain/comic');const sharp=(await import('sharp')).default;
  const dir=await mkdtemp(join(tmpdir(),'comex-edit-version-'));const originalFetch=globalThis.fetch;
  process.env.COMEX_ASSET_PATH=dir;process.env.COMEX_BUDGET_DB_PATH=join(dir,'budget.sqlite');process.env.COMEX_MAX_PROVIDER_CALLS='10';process.env.OPENAI_API_KEY='test';
  let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>release=r),began=new Promise<void>(r=>started=r);let textCalls=0,imageCalls=0;
  try {
    const created=await post('comics',{title:'Edit version',plot:'Deliver',style:'ink-manga'});const {comic}=await created.json();const cookie=created.headers.get('set-cookie')!.split(';')[0],owner=cookie.split('=')[1];
    const store=(globalThis as typeof globalThis & {__comexLocalStore:LocalStore}).__comexLocalStore;const current=store.getOwned<any>(comic.id,owner)!;
    const asset='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';let draft=createComic({id:comic.id,ownerId:owner,title:'Edit version',creatorName:'',plot:'Deliver',styleId:'ink-manga',pages:[{id:'page1',panels:[{id:'p1',beat:'First'}]}]});
    draft=commitPanelRender(draft,owner,'p1',{storyRevision:1,panelRevision:1},asset,'uncertain');
    const state={location:'town',time:'day',props:[],outfits:[],injuries:[],knowledge:[]};const panel={id:'p1',index:1,character_ids:[],action:'First',framing:'wide',dialogue:[],state_before:state,state_after:state};const storyboard={bible:{premise:'Deliver',setting:'town',rules:[],character_ids:[]},pages:[{index:1,panels:[panel]}]};
    expect(store.update(comic.id,owner,current.revision,{...current.data,...draft,storyboard})).toBe(true);
    await approveSeededStory(comic.id,cookie);
    const png=await sharp({create:{width:8,height:8,channels:4,background:'#fff'}}).png().toBuffer(); await writeFile(join(dir,`${asset}.png`),png);
    globalThis.fetch=(async (url:string|URL|Request)=>{if(String(url).includes('/images/')){imageCalls++;return Response.json({data:[{b64_json:png.toString('base64')}]});} textCalls++;started();await gate;return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({intent:'restore',reason:'lighting',question:null})}]}]});}) as unknown as typeof fetch;
    const path=`comics/${comic.id}/panels/p1/edit`;
    const unbound=post(path,{instruction:'Change lighting'},cookie);
    const first=await Promise.race([unbound.then(r=>r.status),began.then(()=>-1)]);
    expect(first).toBe(400);
    expect(textCalls).toBe(0);
    expect((await post(path,{instruction:'Change lighting',assetId:asset,storyRevision:1,panelRevision:1},cookie)).status).toBe(409);
    expect(textCalls).toBe(0);
    const pending=post(path,{instruction:'Change lighting',assetId:asset,storyRevision:1,panelRevision:2},cookie);await began;
    const latest=store.getOwned<any>(comic.id,owner)!;
    const revised=reviseStory(latest.data,owner,1,'p1',{p1:'Changed beat'});
    expect(revised.pages[0].panels[0].assetId).toBe(asset);
    expect(revised.pages[0].panels[0].status).toBe('outdated');
    expect(store.update(comic.id,owner,latest.revision,revised)).toBe(true);
    release();expect((await pending).status).toBe(409);expect(imageCalls).toBe(0);expect(textCalls).toBe(1);
  } finally {release();globalThis.fetch=originalFetch;delete process.env.COMEX_ASSET_PATH;delete process.env.COMEX_BUDGET_DB_PATH;delete process.env.COMEX_MAX_PROVIDER_CALLS;delete process.env.OPENAI_API_KEY;await rm(dir,{recursive:true,force:true});}
});


test('classification cannot hand off after a changed whole draft even when the panel version is retained', async () => {
  const {mkdtemp,writeFile,rm}=await import('node:fs/promises'); const {tmpdir}=await import('node:os'); const {join}=await import('node:path');
  const {createComic,commitPanelRender}=await import('@/src/lib/domain/comic'); const sharp=(await import('sharp')).default;
  const dir=await mkdtemp(join(tmpdir(),'comex-edit-draft-race-')); const originalFetch=globalThis.fetch;
  process.env.COMEX_ASSET_PATH=dir; process.env.COMEX_BUDGET_DB_PATH=join(dir,'budget.sqlite'); process.env.COMEX_MAX_PROVIDER_CALLS='10'; process.env.OPENAI_API_KEY='test';
  let release!:()=>void,started!:()=>void; const gate=new Promise<void>(r=>release=r), began=new Promise<void>(r=>started=r); let imageCalls=0;
  try {
    const image='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const png=await sharp({create:{width:8,height:8,channels:4,background:'#fff'}}).png().toBuffer(); await writeFile(join(dir,`${image}.png`),png);
    const created=await post('comics',{title:'Race',plot:'A lighthouse',style:'ink-manga'}); const {comic}=await created.json(); const cookie=created.headers.get('set-cookie')!.split(';')[0], owner=cookie.split('=')[1];
    const store=(globalThis as typeof globalThis & {__comexLocalStore:LocalStore}).__comexLocalStore; const initial=store.getOwned<any>(comic.id,owner)!;
    let draft=createComic({id:comic.id,ownerId:owner,title:'Race',creatorName:'',plot:'A lighthouse',styleId:'ink-manga',pages:[{id:'page1',panels:[{id:'p1',beat:'Lamp is off'}]}]});
    draft=commitPanelRender(draft,owner,'p1',{storyRevision:1,panelRevision:1},image,'pass');
    const state={location:'coast',time:'night',props:[{key:'lamp',value:'off'}],outfits:[],injuries:[],knowledge:[]};
    const spec={id:'p1',index:1,character_ids:[],action:'Lamp is off',framing:'wide',dialogue:[],state_before:state,state_after:state};
    const storyboard={bible:{premise:'Dark lighthouse',setting:'coast',rules:[],character_ids:[]},pages:[{index:1,panels:[spec]}]};
    expect(store.update(comic.id,owner,initial.revision,{...initial.data,...draft,storyboard})).toBe(true);
    await approveSeededStory(comic.id,cookie);
    globalThis.fetch=(async (url:string|URL|Request)=>{if(String(url).includes('/images/')) {imageCalls++;throw new Error('Unexpected image');} started();await gate;return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({intent:'story',reason:'Changes story',question:null})}]}]});}) as unknown as typeof fetch;
    const pending=post(`comics/${comic.id}/panels/p1/edit`,{instruction:'Turn it on',assetId:image,storyRevision:1,panelRevision:2},cookie); await began;
    const current=store.getOwned<any>(comic.id,owner)!;
    expect(store.update(comic.id,owner,current.revision,{...current.data,title:'Edited elsewhere'})).toBe(true);
    release(); expect((await pending).status).toBe(409); expect(imageCalls).toBe(0);
  } finally {release();globalThis.fetch=originalFetch;delete process.env.COMEX_ASSET_PATH;delete process.env.COMEX_BUDGET_DB_PATH;delete process.env.COMEX_MAX_PROVIDER_CALLS;delete process.env.OPENAI_API_KEY;await rm(dir,{recursive:true,force:true});}
});


test('an edit rendering after a draft write is discarded, and a lost classifier response is not retried', async () => {
  const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const sharp=(await import('sharp')).default;const {createComic,commitPanelRender}=await import('@/src/lib/domain/comic');
  const dir=await mkdtemp(join(tmpdir(),'comex-edit-commit-race-'));const originalFetch=globalThis.fetch;
  process.env.COMEX_ASSET_PATH=dir;process.env.COMEX_BUDGET_DB_PATH=join(dir,'budget.sqlite');process.env.COMEX_MAX_PROVIDER_CALLS='20';process.env.OPENAI_API_KEY='test';
  let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>release=r),began=new Promise<void>(r=>started=r);let images=0,classes=0,failClassification=false;
  try {
    const png=await sharp({create:{width:8,height:8,channels:4,background:'#fff'}}).png().toBuffer();const asset='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';await writeFile(join(dir,`${asset}.png`),png);
    const created=await post('comics',{title:'Race',plot:'A lighthouse',style:'ink-manga'});const {comic}=await created.json();const cookie=created.headers.get('set-cookie')!.split(';')[0],owner=cookie.split('=')[1];
    const store=(globalThis as typeof globalThis & {__comexLocalStore:LocalStore}).__comexLocalStore;const initial=store.getOwned<any>(comic.id,owner)!;
    let draft=createComic({id:comic.id,ownerId:owner,title:'Race',creatorName:'',plot:'A lighthouse',styleId:'ink-manga',pages:[{id:'page1',panels:[{id:'p1',beat:'Dark'}]}]});draft=commitPanelRender(draft,owner,'p1',{storyRevision:1,panelRevision:1},asset,'pass');
    const state={location:'coast',time:'night',props:[],outfits:[],injuries:[],knowledge:[]};const panel={id:'p1',index:1,character_ids:[],action:'Dark',framing:'wide',dialogue:[],state_before:state,state_after:state};const storyboard={bible:{premise:'Lighthouse',setting:'coast',rules:[],character_ids:[]},pages:[{index:1,panels:[panel]}]};
    expect(store.update(comic.id,owner,initial.revision,{...initial.data,...draft,storyboard})).toBe(true);
    await approveSeededStory(comic.id,cookie);
    globalThis.fetch=(async (url:string|URL|Request)=>{if(String(url).includes('/images/')){images++;started();await gate;return Response.json({data:[{b64_json:png.toString('base64')}]});}classes++;if(failClassification) throw new Error('connection lost');return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({intent:'restore',reason:'Repair',question:null})}]}]});}) as unknown as typeof fetch;
    const body={instruction:'Make it dark',assetId:asset,storyRevision:1,panelRevision:2},path=`comics/${comic.id}/panels/p1/edit`;
    const pending=post(path,body,cookie);await began;const current=store.getOwned<any>(comic.id,owner)!;
    const concurrentText=store.reserveTextOperation(comic.id,owner,current.revision);
    if (concurrentText) store.finishTextOperation(comic.id,owner,false);
    const concurrentPage=store.beginPageJob(comic.id,owner,'page1',crypto.randomUUID(),current.revision);
    if (concurrentPage) store.finishPageJob(concurrentPage.job.id,owner,'failed',null);
    expect(concurrentText).toBe(false);expect(concurrentPage).toBeNull();
    expect(store.update(comic.id,owner,current.revision,{...current.data,title:'Edited elsewhere'})).toBe(true);release();expect((await pending).status).toBe(409);
    expect(store.getOwned<any>(comic.id,owner)!.data.pages[0].panels[0].assetId).toBe(asset);expect(images).toBe(1);
    failClassification=true;const uncertain=await post(path,body,cookie);expect(uncertain.status).toBe(502);expect((await post(path,body,cookie)).status).toBe(409);expect(classes).toBe(2);expect(images).toBe(1);
  } finally {release();globalThis.fetch=originalFetch;delete process.env.COMEX_ASSET_PATH;delete process.env.COMEX_BUDGET_DB_PATH;delete process.env.COMEX_MAX_PROVIDER_CALLS;delete process.env.OPENAI_API_KEY;await rm(dir,{recursive:true,force:true});}
});


test('an uncertain edit image retains the panel reservation without poisoning the text reservation', async () => {
  const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const sharp=(await import('sharp')).default;const {createComic,commitPanelRender}=await import('@/src/lib/domain/comic');
  const dir=await mkdtemp(join(tmpdir(),'comex-edit-image-unknown-'));const originalFetch=globalThis.fetch;
  process.env.COMEX_ASSET_PATH=dir;process.env.COMEX_BUDGET_DB_PATH=join(dir,'budget.sqlite');process.env.COMEX_MAX_PROVIDER_CALLS='10';process.env.COMEX_MAX_CONCURRENT_CALLS='4';process.env.OPENAI_API_KEY='test';
  try {
    const png=await sharp({create:{width:8,height:8,channels:4,background:'#fff'}}).png().toBuffer();const asset='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';await writeFile(join(dir,`${asset}.png`),png);
    const created=await post('comics',{title:'Unknown edit',plot:'A lighthouse',style:'ink-manga'});const {comic}=await created.json();const cookie=created.headers.get('set-cookie')!.split(';')[0],owner=cookie.split('=')[1];
    const store=(globalThis as typeof globalThis & {__comexLocalStore:LocalStore}).__comexLocalStore;const initial=store.getOwned<any>(comic.id,owner)!;
    let draft=createComic({id:comic.id,ownerId:owner,title:'Unknown edit',creatorName:'',plot:'A lighthouse',styleId:'ink-manga',pages:[{id:'page1',panels:[{id:'p1',beat:'Dark'}]}]});draft=commitPanelRender(draft,owner,'p1',{storyRevision:1,panelRevision:1},asset,'pass');
    const state={location:'coast',time:'night',props:[],outfits:[],injuries:[],knowledge:[]};const panel={id:'p1',index:1,character_ids:[],action:'Dark',framing:'wide',dialogue:[],state_before:state,state_after:state};const storyboard={bible:{premise:'Lighthouse',setting:'coast',rules:[],character_ids:[]},pages:[{index:1,panels:[panel]}]};
    expect(store.update(comic.id,owner,initial.revision,{...initial.data,...draft,storyboard})).toBe(true);
    await approveSeededStory(comic.id,cookie);
    let images=0,classes=0;globalThis.fetch=(async (url:string|URL|Request)=>{if(String(url).includes('/images/')) {images++;throw new Error('image response lost');}classes++;return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({intent:'restore',reason:'Repair',question:null})}]}]});}) as unknown as typeof fetch;
    const body={instruction:'Make it dark',assetId:asset,storyRevision:1,panelRevision:2},path=`comics/${comic.id}/panels/p1/edit`;
    expect((await post(path,body,cookie)).status).toBe(502);
    const current=store.getOwned<any>(comic.id,owner)!;expect(current.data.operations['panel:p1']).toBe('unknown_outcome');
    expect(store.reserveTextOperation(comic.id,owner,current.revision)).toBe(true);store.finishTextOperation(comic.id,owner,false);
    expect((await post(path,body,cookie)).status).toBe(409);expect(images).toBe(1);expect(classes).toBe(1);
  } finally {globalThis.fetch=originalFetch;delete process.env.COMEX_ASSET_PATH;delete process.env.COMEX_BUDGET_DB_PATH;delete process.env.COMEX_MAX_PROVIDER_CALLS;delete process.env.COMEX_MAX_CONCURRENT_CALLS;delete process.env.OPENAI_API_KEY;await rm(dir,{recursive:true,force:true});}
});

test('artwork edit replaces only the selected panel and preserves story beats', async () => {
  const {mkdtemp,writeFile,rm}=await import('node:fs/promises'); const {tmpdir}=await import('node:os'); const {join}=await import('node:path');
  const sharp=(await import('sharp')).default; const {createComic,commitPanelRender}=await import('@/src/lib/domain/comic');
  const dir=await mkdtemp(join(tmpdir(),'comex-edit-'));process.env.COMEX_ASSET_PATH=dir;process.env.COMEX_BUDGET_DB_PATH=join(dir,'budget.sqlite');process.env.COMEX_MAX_PROVIDER_CALLS='10';process.env.OPENAI_API_KEY='test';const originalFetch=globalThis.fetch;
  try {
    const png=await sharp({create:{width:8,height:8,channels:4,background:'#fed'}}).png().toBuffer();
    const ids=['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','cccccccc-cccc-4ccc-8ccc-cccccccccccc'];for(const assetId of ids)await writeFile(join(dir,`${assetId}.png`),png);
    const created=await post('comics',{title:'Edit',plot:'Delivery',style:'ink-manga'});const {comic}=await created.json();const cookie=created.headers.get('set-cookie')!.split(';')[0],owner=cookie.split('=')[1];const store=(globalThis as typeof globalThis & {__comexLocalStore:import('@/src/lib/local-store').LocalStore}).__comexLocalStore;const current=store.getOwned<Record<string,unknown>>(comic.id,owner)!;
    let domain=createComic({id:comic.id,ownerId:owner,title:'Edit',creatorName:'',plot:'Delivery',styleId:'ink-manga',pages:[{id:'page1',panels:[{id:'p1',beat:'Arrives'},{id:'p2',beat:'Departs'}]}]});
    domain=commitPanelRender(domain,owner,'p1',{storyRevision:1,panelRevision:1},ids[1],'pass');domain=commitPanelRender(domain,owner,'p2',{storyRevision:1,panelRevision:1},ids[2],'pass');
    const state={location:'town',time:'day',props:[],outfits:[],injuries:[],knowledge:[]};const panel=(id:string,index:number)=>({id,index,character_ids:['mina'],action:id,framing:'wide',dialogue:[],state_before:state,state_after:state});const storyboard={bible:{premise:'Delivery',setting:'town',rules:[],character_ids:['mina']},pages:[{index:1,panels:[panel('p1',1),panel('p2',2)]}]};
    expect(store.update(comic.id,owner,current.revision,{...current.data,...domain,storyboard,characters:[{id:'mina',name:'Mina',role:'courier',appearance:'hair',outfit:'coat',approved:true,referenceAssetId:ids[0]}]})).toBe(true);
    await approveSeededStory(comic.id,cookie);
    globalThis.fetch=(async (url:string|URL|Request,init?:RequestInit)=>{if(String(url).includes('/images/'))return Response.json({data:[{b64_json:png.toString('base64')}]});const name=JSON.parse(String(init?.body)).text.format.name;const value=name==='edit_intent'?{intent:'cosmetic',reason:'Change light only',question:null}:{outcome:'inconclusive',findings:[]};return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]});}) as unknown as typeof fetch;
    const result=await post(`comics/${comic.id}/panels/p2/edit`,{instruction:'Change the lighting',assetId:ids[2],storyRevision:1,panelRevision:2},cookie);expect(result.status).toBe(200);
    const final=store.getOwned<{storyRevision:number,pages:{panels:{assetId:string,beat:string}[]}[]}>(comic.id,owner)!.data;expect(final.storyRevision).toBe(1);expect(final.pages[0].panels[0].assetId).toBe(ids[1]);expect(final.pages[0].panels[1].assetId).not.toBe(ids[2]);expect(final.pages[0].panels[1].beat).toBe('Departs');
  } finally {globalThis.fetch=originalFetch;delete process.env.COMEX_ASSET_PATH;delete process.env.COMEX_BUDGET_DB_PATH;delete process.env.COMEX_MAX_PROVIDER_CALLS;delete process.env.OPENAI_API_KEY;await rm(dir,{recursive:true,force:true});}
});

test('acceptance applies only to the exact panel image and story version reviewed', async () => {
  const {createComic,commitPanelRender,reviseStory}=await import('@/src/lib/domain/comic');
  const created=await post('comics',{title:'Review race',plot:'Deliver',style:'ink-manga'});
  const {comic}=await created.json(); const cookie=created.headers.get('set-cookie')!.split(';')[0]; const owner=cookie.split('=')[1];
  const store=(globalThis as typeof globalThis & {__comexLocalStore:LocalStore}).__comexLocalStore;
  const original=store.getOwned<Record<string,unknown>>(comic.id,owner)!;
  const assetA='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',assetB='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  let draft=createComic({id:comic.id,ownerId:owner,title:'Review race',creatorName:'',plot:'Deliver',styleId:'ink-manga',pages:[{id:'page1',panels:[{id:'p1',beat:'First'},{id:'p2',beat:'Next'}]}]});
  draft=commitPanelRender(draft,owner,'p1',{storyRevision:1,panelRevision:1},assetA,'uncertain');
  expect(store.update(comic.id,owner,original.revision,{...original.data,...draft})).toBe(true);
  const viewed=(await (await handleApi(request(`comics/${comic.id}`,'GET',undefined,cookie),['comics',comic.id])).json()).comic.pages[0].panels[0];
  const oldReview={assetId:assetA,storyRevision:1,panelRevision:2};
  const existing=store.getOwned<Record<string,unknown>>(comic.id,owner)!;
  draft=commitPanelRender(existing.data as unknown as typeof draft,owner,'p1',{storyRevision:1,panelRevision:2},assetB,'uncertain');
  expect(store.update(comic.id,owner,existing.revision,draft)).toBe(true);
  expect((await post(`comics/${comic.id}/panels/p1/accept`,{},cookie)).status).toBe(400);
  expect((await post(`comics/${comic.id}/panels/p1/accept`,oldReview,cookie)).status).toBe(409);
  let current=store.getOwned<typeof draft>(comic.id,owner)!;
  expect(current.data.pages[0].panels[0].acceptance).toBeNull();
  const nextReview={assetId:assetB,storyRevision:1,panelRevision:3};
  expect((await post(`comics/${comic.id}/panels/p1/accept`,{...nextReview,panelRevision:2},cookie)).status).toBe(409);
  expect((await post(`comics/${comic.id}/panels/p1/accept`,nextReview,cookie)).status).toBe(200);
  current=store.getOwned<typeof draft>(comic.id,owner)!;
  const revised=reviseStory(current.data,owner,1,'p2',{p2:'Changed'});
  expect(store.update(comic.id,owner,current.revision,revised)).toBe(true);
  expect((await post(`comics/${comic.id}/panels/p1/accept`,nextReview,cookie)).status).toBe(409);
  expect(viewed.reviewVersion).toEqual(oldReview);
});

test('blocker reviews remain advisory when advancing', async () => {
  const {mkdtemp,writeFile,rm}=await import('node:fs/promises'); const {tmpdir}=await import('node:os'); const {join}=await import('node:path');
  const sharp=(await import('sharp')).default; const {createComic}=await import('@/src/lib/domain/comic');
  const dir=await mkdtemp(join(tmpdir(),'comex-judge-race-'));process.env.COMEX_ASSET_PATH=dir;process.env.COMEX_BUDGET_DB_PATH=join(dir,'budget.sqlite');process.env.COMEX_MAX_PROVIDER_CALLS='10';process.env.OPENAI_API_KEY='test';
  const originalFetch=globalThis.fetch; let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>release=r), began=new Promise<void>(r=>started=r);let images=0;
  try {
    const png=await sharp({create:{width:8,height:8,channels:4,background:'#fff'}}).png().toBuffer();const ref='11111111-1111-4111-8111-111111111111';await writeFile(join(dir,`${ref}.png`),png);
    const created=await post('comics',{title:'Race',plot:'A story',style:'ink-manga'});const {comic}=await created.json();const cookie=created.headers.get('set-cookie')!.split(';')[0],owner=cookie.split('=')[1];
    const store=(globalThis as typeof globalThis & {__comexLocalStore:import('@/src/lib/local-store').LocalStore}).__comexLocalStore;const original=store.getOwned<Record<string,unknown>>(comic.id,owner)!;
    const domain=createComic({id:comic.id,ownerId:owner,title:'Race',creatorName:'',plot:'A story',styleId:'ink-manga',pages:[{id:'page1',panels:[{id:'p1',beat:'First'}]},{id:'page2',panels:[{id:'p2',beat:'Second'}]}]});
    const state={location:'town',time:'day',props:[],outfits:[],injuries:[],knowledge:[]};const spec=(id:string)=>({id,index:1,character_ids:['mina'],action:id,framing:'wide',dialogue:[{speaker_id:'mina',text:'Safe and dry.'}],state_before:state,state_after:state});
    const storyboard={bible:{premise:'A story',setting:'town',rules:[],character_ids:['mina']},pages:[{index:1,panels:[spec('p1')]},{index:2,panels:[spec('p2')]}]};
    expect(store.update(comic.id,owner,original.revision,{...original.data,...domain,storyboard,characters:[{id:'mina',name:'Mina',role:'courier',appearance:'hair',outfit:'coat',approved:true,referenceAssetId:ref}]})).toBe(true);
    await approveSeededStory(comic.id,cookie);
    globalThis.fetch=(async (url:string|URL|Request,init?:RequestInit)=>{if(String(url).includes('/images/')){images++;expect(String((init?.body as FormData).get('prompt'))).not.toContain('Safe and dry.');return Response.json({data:[{b64_json:png.toString('base64')}]});}const payload=JSON.parse(String(init?.body));expect(payload.input[0].content).toContain('unlettered source images');expect(payload.input[1].content[0].text).not.toContain('Safe and dry.');started();await gate;return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({outcome:'findings',findings:[{severity:'blocker',dimension:'story',panel_id:'p1',character_id:null,reference_id:null,expected:'key',observed:'no key',repair:'fix'}]})}]}]});}) as unknown as typeof fetch;
    const pending=post(`comics/${comic.id}/pages/page1/generate`,{},cookie);await began;
    const checking=(await (await handleApi(request(`comics/${comic.id}`,'GET',undefined,cookie),['comics',comic.id])).json()).comic.pages[0].panels[0];
    const acceptance=await post(`comics/${comic.id}/panels/p1/accept`,checking.reviewVersion,cookie);release();await pending;
    expect(acceptance.status).toBe(409);
    const result=await waitForComic(comic.id,cookie,c=>c.pages[0].panels[0].reviewOutcome==='findings');expect(result.pages[0].status).toBe('current');expect(result.pages[0].panels[0].evaluation).toBe('blocker');expect(result.pages[0].panels[0].accepted).toBe(false);
    expect((await post(`comics/${comic.id}/pages/page2/generate`,{},cookie)).status).toBe(200);expect(images).toBe(2);
  } finally {release();globalThis.fetch=originalFetch;delete process.env.COMEX_ASSET_PATH;delete process.env.COMEX_BUDGET_DB_PATH;delete process.env.COMEX_MAX_PROVIDER_CALLS;delete process.env.OPENAI_API_KEY;await rm(dir,{recursive:true,force:true});}
});

test('next page waits for artwork but not an advisory review', async () => {
  const {mkdtemp,writeFile,rm}=await import('node:fs/promises'); const {tmpdir}=await import('node:os'); const {join}=await import('node:path');
  const sharp=(await import('sharp')).default; const {createComic,commitPanelRender}=await import('@/src/lib/domain/comic');
  const dir=await mkdtemp(join(tmpdir(),'comex-advisory-gate-'));process.env.COMEX_ASSET_PATH=dir;process.env.COMEX_BUDGET_DB_PATH=join(dir,'budget.sqlite');process.env.COMEX_MAX_PROVIDER_CALLS='10';process.env.OPENAI_API_KEY='test';const originalFetch=globalThis.fetch;
  try {
    const png=await sharp({create:{width:8,height:8,channels:4,background:'#fff'}}).png().toBuffer();const ref='11111111-1111-4111-8111-111111111111';await writeFile(join(dir,`${ref}.png`),png);
    const created=await post('comics',{title:'Advisory',plot:'A story',style:'ink-manga'});const {comic}=await created.json();const cookie=created.headers.get('set-cookie')!.split(';')[0],owner=cookie.split('=')[1];const store=(globalThis as typeof globalThis & {__comexLocalStore:import('@/src/lib/local-store').LocalStore}).__comexLocalStore;
    const current=store.getOwned<Record<string,unknown>>(comic.id,owner)!;let domain=createComic({id:comic.id,ownerId:owner,title:'Advisory',creatorName:'',plot:'A story',styleId:'ink-manga',pages:[{id:'page1',panels:[{id:'p1',beat:'First'}]},{id:'page2',panels:[{id:'p2',beat:'Second'}]}]});domain=commitPanelRender(domain,owner,'p1',{storyRevision:1,panelRevision:1},ref,'blocker');
    const state={location:'town',time:'day',props:[],outfits:[],injuries:[],knowledge:[]};const spec=(id:string)=>({id,index:1,character_ids:['mina'],action:id,framing:'wide',dialogue:[],state_before:state,state_after:state});const storyboard={bible:{premise:'Story',setting:'town',rules:[],character_ids:['mina']},pages:[{index:1,panels:[spec('p1')]},{index:2,panels:[spec('p2')]}]};
    let draft={...current.data,...domain,storyboard,characters:[{id:'mina',name:'Mina',role:'courier',appearance:'hair',outfit:'coat',approved:true,referenceAssetId:ref}],operations:{'panel:p1':'running'}};expect(store.update(comic.id,owner,current.revision,draft)).toBe(true);
    await approveSeededStory(comic.id,cookie);
    expect((await post(`comics/${comic.id}/pages/page2/generate`,{},cookie)).status).toBe(409);
    let record=store.getOwned<any>(comic.id,owner)!;draft={...record.data,operations:{},pages:record.data.pages.map((p:any,i:number)=>i? p:{...p,panels:p.panels.map((x:any)=>({...x,status:'outdated'}))})};expect(store.update(comic.id,owner,record.revision,draft)).toBe(true);
    expect((await post(`comics/${comic.id}/pages/page2/generate`,{},cookie)).status).toBe(409);
    record=store.getOwned<any>(comic.id,owner)!;draft={...record.data,pages:record.data.pages.map((p:any,i:number)=>i? p:{...p,panels:p.panels.map((x:any)=>({...x,status:'checking'}))})};expect(store.update(comic.id,owner,record.revision,draft)).toBe(true);
    globalThis.fetch=(async (url:string|URL|Request)=>String(url).includes('/images/') ? Response.json({data:[{b64_json:png.toString('base64')}]}) : Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({outcome:'inconclusive',findings:[]})}]}]})) as unknown as typeof fetch;
    const generated=await post(`comics/${comic.id}/pages/page2/generate`,{},cookie);expect(generated.status).toBe(200);const body=await generated.json();expect(body.comic.pages[0].panels[0].accepted).toBe(false);expect(body.comic.pages[1].panels[0].imageUrl).toBeTruthy();
    await waitForComic(comic.id,cookie,c=>c.pages[1].panels[0].reviewOutcome==='inconclusive');
  } finally {globalThis.fetch=originalFetch;delete process.env.COMEX_ASSET_PATH;delete process.env.COMEX_BUDGET_DB_PATH;delete process.env.COMEX_MAX_PROVIDER_CALLS;delete process.env.OPENAI_API_KEY;await rm(dir,{recursive:true,force:true});}
});

test('a visual blocker remains visible without stopping later panels', async () => {
  const {mkdtemp,writeFile,rm}=await import('node:fs/promises'); const {tmpdir}=await import('node:os'); const {join}=await import('node:path');
  const sharp=(await import('sharp')).default; const {createComic}=await import('@/src/lib/domain/comic');
  const dir=await mkdtemp(join(tmpdir(),'comex-blocked-page-')); process.env.COMEX_ASSET_PATH=dir;process.env.COMEX_BUDGET_DB_PATH=join(dir,'budget.sqlite');process.env.COMEX_MAX_PROVIDER_CALLS='20';process.env.OPENAI_API_KEY='test';
  const originalFetch=globalThis.fetch; let images=0, reviews=0;
  try {
    const png=await sharp({create:{width:8,height:8,channels:4,background:'#fff'}}).png().toBuffer(); const ref='11111111-1111-4111-8111-111111111111';await writeFile(join(dir,`${ref}.png`),png);
    images=0;reviews=0;
    const created=await post('comics',{title:'Blocker',plot:'Deliver',style:'ink-manga'});const {comic}=await created.json();const cookie=created.headers.get('set-cookie')!.split(';')[0],owner=cookie.split('=')[1];
    const store=(globalThis as typeof globalThis & {__comexLocalStore:import('@/src/lib/local-store').LocalStore}).__comexLocalStore;const original=store.getOwned<Record<string,unknown>>(comic.id,owner)!;
    const domain=createComic({id:comic.id,ownerId:owner,title:'Blocker',creatorName:'',plot:'Deliver',styleId:'ink-manga',pages:[{id:'page1',panels:[{id:'p1',beat:'First'},{id:'p2',beat:'Second'},{id:'p3',beat:'Third'}]}]});
    const state={location:'town',time:'day',props:[],outfits:[],injuries:[],knowledge:[]};const spec=(id:string,index:number)=>({id,index,character_ids:['mina'],action:id,framing:'wide',dialogue:[],state_before:state,state_after:state});
    const storyboard={bible:{premise:'Deliver',setting:'town',rules:[],character_ids:['mina']},pages:[{index:1,panels:[spec('p1',1),spec('p2',2),spec('p3',3)]}]};
    expect(store.update(comic.id,owner,original.revision,{...original.data,...domain,storyboard,characters:[{id:'mina',name:'Mina',role:'courier',appearance:'hair',outfit:'coat',approved:true,referenceAssetId:ref}]})).toBe(true);
    await approveSeededStory(comic.id,cookie);
    globalThis.fetch=(async (url:string|URL|Request,init?:RequestInit)=>{
      if(String(url).includes('/images/')){images++;return Response.json({data:[{b64_json:png.toString('base64')}]});}
      const name=JSON.parse(String(init?.body)).text.format.name;
      const value=name==='edit_intent' ? {intent:'cosmetic',reason:'Visual correction',question:null} : ++reviews===1 ? {outcome:'findings',findings:[{severity:'blocker',dimension:'identity',panel_id:'p1',character_id:'mina',reference_id:'mina',expected:'coat',observed:'wrong coat',repair:'fix coat'}]} : {outcome:'inconclusive',findings:[]};
      return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]});
    }) as unknown as typeof fetch;
    const first=await post(`comics/${comic.id}/pages/page1/generate`,{},cookie); expect(first.status).toBe(200);
    const result=await waitForComic(comic.id,cookie,c=>c.pages[0].panels.every((p:any)=>p.reviewOutcome));
    expect(result.pages[0].panels[0].evaluation).toBe('blocker');expect(result.pages[0].panels[0].accepted).toBe(false);expect(images).toBe(3);
    expect(result.pages[0].panels.every((panel:{imageUrl:string|null})=>!!panel.imageUrl)).toBe(true);
  } finally {globalThis.fetch=originalFetch;delete process.env.COMEX_ASSET_PATH;delete process.env.COMEX_BUDGET_DB_PATH;delete process.env.COMEX_MAX_PROVIDER_CALLS;delete process.env.OPENAI_API_KEY;await rm(dir,{recursive:true,force:true});}
});

test('narrative findings remain visible without blocking page generation', async () => {
  const {mkdtemp,writeFile,rm}=await import('node:fs/promises'); const {tmpdir}=await import('node:os'); const {join}=await import('node:path');const sharp=(await import('sharp')).default;const {createComic,commitPanelRender}=await import('@/src/lib/domain/comic');
  const dir=await mkdtemp(join(tmpdir(),'comex-story-block-'));process.env.COMEX_ASSET_PATH=dir;process.env.COMEX_BUDGET_DB_PATH=join(dir,'budget.sqlite');process.env.COMEX_MAX_PROVIDER_CALLS='10';process.env.OPENAI_API_KEY='test';const originalFetch=globalThis.fetch;let calls=0;
  try {
    const png=await sharp({create:{width:8,height:8,channels:4,background:'#fff'}}).png().toBuffer();const ref='11111111-1111-4111-8111-111111111111';await writeFile(join(dir,`${ref}.png`),png);
    const created=await post('comics',{title:'Block',plot:'A story',style:'ink-manga'});const {comic}=await created.json();const cookie=created.headers.get('set-cookie')!.split(';')[0],owner=cookie.split('=')[1];const store=(globalThis as typeof globalThis & {__comexLocalStore:import('@/src/lib/local-store').LocalStore}).__comexLocalStore;const original=store.getOwned<Record<string,unknown>>(comic.id,owner)!;
    let domain=createComic({id:comic.id,ownerId:owner,title:'Block',creatorName:'',plot:'A story',styleId:'ink-manga',pages:[{id:'page1',panels:[{id:'p1',beat:'First'}]}]});domain=commitPanelRender(domain,owner,'p1',{storyRevision:1,panelRevision:1},ref,'pass');
    const state={location:'town',time:'day',props:[],outfits:[],injuries:[],knowledge:[]};const spec={id:'p1',index:1,character_ids:['mina'],action:'First',framing:'wide',dialogue:[],state_before:state,state_after:state};const storyboard={bible:{premise:'A story',setting:'town',rules:[],character_ids:['mina']},pages:[{index:1,panels:[spec]}]};
    expect(store.update(comic.id,owner,original.revision,{...original.data,...domain,storyboard,storyReview:{outcome:'findings',findings:[{severity:'blocker',dimension:'story',observed:'impossible ending'}]},characters:[{id:'mina',name:'Mina',role:'courier',appearance:'hair',outfit:'coat',approved:true,referenceAssetId:ref}]})).toBe(true);
    await approveSeededStory(comic.id,cookie);
    globalThis.fetch=(async (url:string|URL|Request,init?:RequestInit)=>{calls++;if(String(url).includes('/images/'))return Response.json({data:[{b64_json:png.toString('base64')}]});const name=JSON.parse(String(init?.body)).text.format.name;const value=name==='edit_intent'?{intent:'cosmetic',reason:'Lighting',question:null}:{outcome:'inconclusive',findings:[]};return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]});}) as unknown as typeof fetch;
    const generate=await post(`comics/${comic.id}/pages/page1/generate`,{},cookie);expect(generate.status).toBe(200);expect(calls).toBeGreaterThanOrEqual(1);
    await waitForComic(comic.id,cookie,c=>c.pages[0].panels[0].reviewOutcome==='inconclusive');
    const review=await (await handleApi(request(`comics/${comic.id}`,'GET',undefined,cookie),['comics',comic.id])).json();
    expect(review.comic.storyReview.findings[0].severity).toBe('blocker');expect(review.comic.storyReview.accepted).toBe(false);
  } finally {globalThis.fetch=originalFetch;delete process.env.COMEX_ASSET_PATH;delete process.env.COMEX_BUDGET_DB_PATH;delete process.env.COMEX_MAX_PROVIDER_CALLS;delete process.env.OPENAI_API_KEY;await rm(dir,{recursive:true,force:true});}
});

test('a completed narrative blocker can be accepted only for the reviewed story version', async () => {
  const {createComic}=await import('@/src/lib/domain/comic');
  const created=await post('comics',{title:'Review',plot:'Deliver',style:'ink-manga'});const {comic}=await created.json();const cookie=created.headers.get('set-cookie')!.split(';')[0],owner=cookie.split('=')[1];
  const store=(globalThis as typeof globalThis & {__comexLocalStore:import('@/src/lib/local-store').LocalStore}).__comexLocalStore;const original=store.getOwned<Record<string,unknown>>(comic.id,owner)!;
  const domain=createComic({id:comic.id,ownerId:owner,title:'Review',creatorName:'',plot:'Deliver',styleId:'ink-manga',pages:[{id:'page1',panels:[{id:'p1',beat:'First'}]}]});
  const state={location:'town',time:'day',props:[],outfits:[],injuries:[],knowledge:[]};const panel={id:'p1',index:1,character_ids:[],action:'First',framing:'wide',dialogue:[],state_before:state,state_after:state};
  const storyboard={bible:{premise:'Deliver',setting:'town',rules:[],character_ids:[]},pages:[{index:1,panels:[panel]}]};
  const finding={severity:'blocker',dimension:'continuity',panel_id:'p1',character_id:null,reference_id:null,expected:'key',observed:'no key',repair:'fix'};
  expect(store.update(comic.id,owner,original.revision,{...original.data,...domain,storyboard,storyReviewRunId:'review-run',storyReview:{outcome:'pending',findings:[]}})).toBe(true);
  store.putAdvisoryReview(comic.id,owner,'story:review-run:1',{outcome:'findings',findings:[finding]});
  const get=async ()=>(await (await handleApi(request(`comics/${comic.id}`,'GET',undefined,cookie),['comics',comic.id])).json()).comic;
  const before=await get();expect(before.storyReview.accepted).toBe(false);
  expect((await post(`comics/${comic.id}/story/accept`,{fingerprint:'0'.repeat(64)},cookie)).status).toBe(409);
  const accepted=await post(`comics/${comic.id}/story/accept`,{fingerprint:before.storyReview.fingerprint},cookie);expect(accepted.status).toBe(200);expect((await accepted.json()).comic.storyReview.accepted).toBe(true);
  const current=store.getOwned<Record<string,unknown>>(comic.id,owner)!;
  expect(store.update(comic.id,owner,current.revision,{...current.data,storyRevision:2,storyboard:{...storyboard,bible:{...storyboard.bible,premise:'Changed'}}})).toBe(true);
  const changed=await get();expect(changed.storyReview.accepted).toBe(false);
  expect((await post(`comics/${comic.id}/story/accept`,{fingerprint:before.storyReview.fingerprint},cookie)).status).toBe(409);
  const latest=store.getOwned<Record<string,unknown>>(comic.id,owner)!;
  expect(store.update(comic.id,owner,latest.revision,{...latest.data,storyReviewRunId:undefined,storyReview:{outcome:'inconclusive',findings:[finding]}})).toBe(true);
  const incomplete=await get();expect((await post(`comics/${comic.id}/story/accept`,{fingerprint:incomplete.storyReview.fingerprint},cookie)).status).toBe(409);
});

test('applying a story revision preserves advisory findings when drawing cannot start', async () => {
  const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {createComic}=await import('@/src/lib/domain/comic');
  const dir=await mkdtemp(join(tmpdir(),'comex-revision-block-'));process.env.COMEX_BUDGET_DB_PATH=join(dir,'budget.sqlite');process.env.COMEX_MAX_PROVIDER_CALLS='5';process.env.OPENAI_API_KEY='test';const originalFetch=globalThis.fetch;let images=0;
  try {
    const created=await post('comics',{title:'Revise',plot:'Deliver',style:'ink-manga'});const {comic}=await created.json();const cookie=created.headers.get('set-cookie')!.split(';')[0],owner=cookie.split('=')[1];const store=(globalThis as typeof globalThis & {__comexLocalStore:import('@/src/lib/local-store').LocalStore}).__comexLocalStore;const original=store.getOwned<Record<string,unknown>>(comic.id,owner)!;
    const domain=createComic({id:comic.id,ownerId:owner,title:'Revise',creatorName:'',plot:'Deliver',styleId:'ink-manga',pages:[{id:'page1',panels:[{id:'p1',beat:'First'}]}]});const state={location:'town',time:'day',props:[],outfits:[],injuries:[],knowledge:[]};const spec={id:'p1',index:1,character_ids:[],action:'Revised',framing:'wide',dialogue:[],state_before:state,state_after:state};const bible={premise:'Deliver',setting:'town',rules:[],character_ids:[]};const storyboard={bible,pages:[{index:1,panels:[spec]}]};
    const pendingRevision={id:'proposal',baseRevision:original.revision+1,result:{earliest_affected_panel_id:'p1',explanation:'Revise',revised_bible:bible,revised_suffix:[spec]}};
    expect(store.update(comic.id,owner,original.revision,{...original.data,...domain,storyboard,pendingRevision,characters:[],pageOperations:{page1:{storyRevision:1,baseline:{p1:1}}}})).toBe(true);
    globalThis.fetch=(async (url:string|URL|Request)=>{if(String(url).includes('/images/')){images++;throw new Error('must not render');}return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({outcome:'findings',findings:[{severity:'blocker',dimension:'story',panel_id:'p1',character_id:null,reference_id:null,expected:'key',observed:'no key',repair:'fix'}]})}]}]});}) as unknown as typeof fetch;
    const response=await post(`comics/${comic.id}/revisions`,{proposalId:'proposal'},cookie);expect(response.status).toBe(200);const body=await response.json();expect(body.notice).toContain('artwork did not finish');const reviewedStory=await waitForComic(comic.id,cookie,c=>c.storyReview.outcome==='findings');expect(reviewedStory.storyReview.findings[0].severity).toBe('blocker');expect(body.comic.pages[0].panels[0].status).toBe('outdated');expect(images).toBe(0);expect(store.getOwned<{storyRevision:number}>(comic.id,owner)!.data.storyRevision).toBe(2);expect(store.getOwned<{pageOperations?:Record<string,unknown>}>(comic.id,owner)!.data.pageOperations?.page1).toBeUndefined();
  } finally {globalThis.fetch=originalFetch;delete process.env.COMEX_BUDGET_DB_PATH;delete process.env.COMEX_MAX_PROVIDER_CALLS;delete process.env.OPENAI_API_KEY;await rm(dir,{recursive:true,force:true});}
});

test('a second story revision first redraws an outdated preceding panel', async () => {
  const {mkdtemp,writeFile,rm}=await import('node:fs/promises'); const {tmpdir}=await import('node:os'); const {join}=await import('node:path');
  const sharp=(await import('sharp')).default; const {createComic,commitPanelRender}=await import('@/src/lib/domain/comic');
  const dir=await mkdtemp(join(tmpdir(),'comex-qa-revision-')); process.env.COMEX_ASSET_PATH=dir;process.env.COMEX_BUDGET_DB_PATH=join(dir,'budget.sqlite');process.env.COMEX_MAX_PROVIDER_CALLS='10';process.env.OPENAI_API_KEY='test';const originalFetch=globalThis.fetch;
  try {
    const png=await sharp({create:{width:8,height:8,channels:4,background:'#fff'}}).png().toBuffer();
    const ref='11111111-1111-4111-8111-111111111111',old='22222222-2222-4222-8222-222222222222';
    await writeFile(join(dir,`${ref}.png`),png);await writeFile(join(dir,`${old}.png`),png);
    const created=await post('comics',{title:'Revision',plot:'Courier',style:'ink-manga'});const {comic}=await created.json();const cookie=created.headers.get('set-cookie')!.split(';')[0],owner=cookie.split('=')[1];
    const store=(globalThis as typeof globalThis & {__comexLocalStore:import('@/src/lib/local-store').LocalStore}).__comexLocalStore;const record=store.getOwned<Record<string,unknown>>(comic.id,owner)!;
    let domain=createComic({id:comic.id,ownerId:owner,title:'Revision',creatorName:'',plot:'Courier',styleId:'ink-manga',pages:[{id:'page1',panels:[{id:'p1',beat:'Earlier'},{id:'p2',beat:'Later'}]}]});
    domain=commitPanelRender(domain,owner,'p1',{storyRevision:1,panelRevision:1},old,'pass');domain=commitPanelRender(domain,owner,'p2',{storyRevision:1,panelRevision:1},old,'pass');
    domain.pages[0].panels[0].status='outdated';
    const state={location:'town',time:'day',props:[],outfits:[],injuries:[],knowledge:[]};const spec=(id:string,index:number)=>({id,index,character_ids:['mina'],action:id,framing:'wide',dialogue:[],state_before:state,state_after:state});
    const p1=spec('p1',1),p2=spec('p2',2),bible={premise:'Courier',setting:'town',rules:[],character_ids:['mina']},storyboard={bible,pages:[{index:1,panels:[p1,p2]}]};
    const pendingRevision={id:'proposal',baseRevision:record.revision+1,result:{earliest_affected_panel_id:'p2',explanation:'Revise later panel',revised_bible:bible,revised_suffix:[p2]}};
    expect(store.update(comic.id,owner,record.revision,{...record.data,...domain,storyboard,pendingRevision,characters:[{id:'mina',name:'Mina',role:'courier',appearance:'hair',outfit:'coat',approved:true,referenceAssetId:ref}]})).toBe(true);
    let imageCalls=0,failImage=false;globalThis.fetch=(async (url:string|URL|Request)=>{if(String(url).includes('/images/')){imageCalls++;if(failImage)return new Response('{}',{status:400});return Response.json({data:[{b64_json:png.toString('base64')}]});}return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({outcome:'inconclusive',findings:[]})}]}]});}) as unknown as typeof fetch;
    const result=await post(`comics/${comic.id}/revisions`,{proposalId:'proposal'},cookie);expect(result.status).toBe(200);expect(imageCalls).toBe(2);
    const current=store.getOwned<{pages:{panels:{assetId:string;status:string}[]}[]}>(comic.id,owner)!.data.pages[0].panels;expect(current[0].assetId).not.toBe(old);expect(current[1].assetId).not.toBe(old);
    const updated=store.getOwned<Record<string,unknown>>(comic.id,owner)!;
    expect(store.update(comic.id,owner,updated.revision,{...updated.data,pendingRevision:{...pendingRevision,baseRevision:updated.revision+1}})).toBe(true);
    failImage=true;const interrupted=await post(`comics/${comic.id}/revisions`,{proposalId:'proposal'},cookie);expect(interrupted.status).toBe(200);
    const interruptedBody=await interrupted.json();expect(interruptedBody.notice).toContain('Story change saved');expect(store.getOwned<{storyRevision:number}>(comic.id,owner)!.data.storyRevision).toBe(3);
  } finally {globalThis.fetch=originalFetch;delete process.env.COMEX_ASSET_PATH;delete process.env.COMEX_BUDGET_DB_PATH;delete process.env.COMEX_MAX_PROVIDER_CALLS;delete process.env.OPENAI_API_KEY;await rm(dir,{recursive:true,force:true});}
});

test('a failed visual judge leaves the new image uncertain and manually acceptable', async () => {
  const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const sharp=(await import('sharp')).default;const {createComic}=await import('@/src/lib/domain/comic');
  const dir=await mkdtemp(join(tmpdir(),'comex-judge-failure-'));process.env.COMEX_ASSET_PATH=dir;process.env.COMEX_BUDGET_DB_PATH=join(dir,'budget.sqlite');process.env.COMEX_MAX_PROVIDER_CALLS='5';process.env.OPENAI_API_KEY='test';const originalFetch=globalThis.fetch;
  try {
    const png=await sharp({create:{width:8,height:8,channels:4,background:'#fff'}}).png().toBuffer();const ref='11111111-1111-4111-8111-111111111111';await writeFile(join(dir,`${ref}.png`),png);const created=await post('comics',{title:'Judge',plot:'Deliver',style:'ink-manga'});const {comic}=await created.json();const cookie=created.headers.get('set-cookie')!.split(';')[0],owner=cookie.split('=')[1];const store=(globalThis as typeof globalThis & {__comexLocalStore:import('@/src/lib/local-store').LocalStore}).__comexLocalStore;const original=store.getOwned<Record<string,unknown>>(comic.id,owner)!;
    const domain=createComic({id:comic.id,ownerId:owner,title:'Judge',creatorName:'',plot:'Deliver',styleId:'ink-manga',pages:[{id:'page1',panels:[{id:'p1',beat:'First'}]}]});const state={location:'town',time:'day',props:[],outfits:[],injuries:[],knowledge:[]};const spec={id:'p1',index:1,character_ids:['mina'],action:'First',framing:'wide',dialogue:[],state_before:state,state_after:state};const storyboard={bible:{premise:'Deliver',setting:'town',rules:[],character_ids:['mina']},pages:[{index:1,panels:[spec]}]};
    expect(store.update(comic.id,owner,original.revision,{...original.data,...domain,storyboard,characters:[{id:'mina',name:'Mina',role:'courier',appearance:'hair',outfit:'coat',approved:true,referenceAssetId:ref}]})).toBe(true);
    await approveSeededStory(comic.id,cookie);
    globalThis.fetch=(async (url:string|URL|Request)=>{if(String(url).includes('/images/'))return Response.json({data:[{b64_json:png.toString('base64')}]});throw new Error('judge unavailable');}) as unknown as typeof fetch;
    const response=await post(`comics/${comic.id}/pages/page1/generate`,{},cookie);expect(response.status).toBe(200);const result=await waitForComic(comic.id,cookie,c=>c.pages[0].panels[0].reviewOutcome==='failed');const panel=result.pages[0].panels[0];expect(panel.evaluation).toBe('uncertain');expect(panel.imageUrl).toBeTruthy();expect(panel.ready).toBe(true);expect(panel.accepted).toBe(false);
  } finally {globalThis.fetch=originalFetch;delete process.env.COMEX_ASSET_PATH;delete process.env.COMEX_BUDGET_DB_PATH;delete process.env.COMEX_MAX_PROVIDER_CALLS;delete process.env.OPENAI_API_KEY;await rm(dir,{recursive:true,force:true});}
});

test('a successful visual review is distinct from failure and needs no acceptance', async () => {
  const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const sharp=(await import('sharp')).default;const {createComic}=await import('@/src/lib/domain/comic');
  const dir=await mkdtemp(join(tmpdir(),'comex-judge-pass-'));process.env.COMEX_ASSET_PATH=dir;process.env.COMEX_BUDGET_DB_PATH=join(dir,'budget.sqlite');process.env.COMEX_MAX_PROVIDER_CALLS='5';process.env.OPENAI_API_KEY='test';const originalFetch=globalThis.fetch;
  try {
    const png=await sharp({create:{width:8,height:8,channels:4,background:'#fff'}}).png().toBuffer();const ref='11111111-1111-4111-8111-111111111111';await writeFile(join(dir,`${ref}.png`),png);const created=await post('comics',{title:'Judge',plot:'Deliver',style:'ink-manga'});const {comic}=await created.json();const cookie=created.headers.get('set-cookie')!.split(';')[0],owner=cookie.split('=')[1];const store=(globalThis as typeof globalThis & {__comexLocalStore:import('@/src/lib/local-store').LocalStore}).__comexLocalStore;const original=store.getOwned<Record<string,unknown>>(comic.id,owner)!;
    const domain=createComic({id:comic.id,ownerId:owner,title:'Judge',creatorName:'',plot:'Deliver',styleId:'ink-manga',pages:[{id:'page1',panels:[{id:'p1',beat:'First'}]}]});const state={location:'town',time:'day',props:[],outfits:[],injuries:[],knowledge:[]};const spec={id:'p1',index:1,character_ids:['mina'],action:'First',framing:'wide',dialogue:[],state_before:state,state_after:state};const storyboard={bible:{premise:'Deliver',setting:'town',rules:[],character_ids:['mina']},pages:[{index:1,panels:[spec]}]};
    expect(store.update(comic.id,owner,original.revision,{...original.data,...domain,storyboard,characters:[{id:'mina',name:'Mina',role:'courier',appearance:'hair',outfit:'coat',approved:true,referenceAssetId:ref}]})).toBe(true);
    await approveSeededStory(comic.id,cookie);
    let judgeOutcome='pass';
    globalThis.fetch=(async (url:string|URL|Request)=>String(url).includes('/images/') ? Response.json({data:[{b64_json:png.toString('base64')}]}) : Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({outcome:judgeOutcome,findings:[]})}]}]})) as unknown as typeof fetch;
    const response=await post(`comics/${comic.id}/pages/page1/generate`,{},cookie);expect(response.status).toBe(200);const first=await waitForComic(comic.id,cookie,c=>c.pages[0].panels[0].reviewOutcome==='pass');const panel=first.pages[0].panels[0];
    expect(panel.reviewOutcome).toBe('pass');expect(panel.evaluation).toBe('pass');expect(panel.ready).toBe(true);expect(panel.reviewed).toBe(true);expect(panel.accepted).toBe(false);
    judgeOutcome='inconclusive';
    const redraw=await post(`comics/${comic.id}/pages/page1/generate`,{},cookie);expect(redraw.status).toBe(200);await waitForComic(comic.id,cookie,c=>c.pages[0].panels[0].reviewOutcome==='inconclusive');
    const current=store.getOwned<any>(comic.id,owner)!;const stale={...current.data,pages:current.data.pages.map((page:any)=>({...page,panels:page.panels.map((item:any)=>({...item,revision:item.revision+1}))}))};
    expect(store.update(comic.id,owner,current.revision,stale)).toBe(true);
    const fresh=await handleApi(request(`comics/${comic.id}`,'GET',undefined,cookie),['comics',comic.id]);expect((await fresh.json()).comic.pages[0].panels[0].reviewOutcome).toBeNull();
  } finally {globalThis.fetch=originalFetch;delete process.env.COMEX_ASSET_PATH;delete process.env.COMEX_BUDGET_DB_PATH;delete process.env.COMEX_MAX_PROVIDER_CALLS;delete process.env.OPENAI_API_KEY;await rm(dir,{recursive:true,force:true});}
});

test('publication allows pending and flagged background reviews without acceptance', async () => {
  const {mkdtemp,writeFile,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os'); const {join}=await import('node:path');
  const sharp=(await import('sharp')).default; const {createComic,commitPanelRender}=await import('@/src/lib/domain/comic');
  const dir=await mkdtemp(join(tmpdir(),'comex-review-publication-'));process.env.COMEX_ASSET_PATH=dir;
  try {
    const created=await post('comics',{title:'Review gate',plot:'A story',style:'ink-manga'});
    const {comic}=await created.json(), cookie=created.headers.get('set-cookie')!.split(';')[0], owner=cookie.split('=')[1];
    const store=(globalThis as typeof globalThis & {__comexLocalStore:LocalStore}).__comexLocalStore;
    const original=store.getOwned<any>(comic.id,owner)!;
    const image='22222222-2222-4222-8222-222222222222';
    await writeFile(join(dir,`${image}.png`),await sharp({create:{width:8,height:8,channels:4,background:'#fff'}}).png().toBuffer());
    let domain=createComic({id:comic.id,ownerId:owner,title:'Review gate',creatorName:'',plot:'A story',styleId:'ink-manga',pages:[{id:'page1',panels:[{id:'p1',beat:'A scene'}]}]});
    domain=commitPanelRender(domain,owner,'p1',{storyRevision:1,panelRevision:1},image,'uncertain');
    domain.pages[0].panels[0]={...domain.pages[0].panels[0],status:'checking'};
    const state={location:'town',time:'day',props:[],outfits:[],injuries:[],knowledge:[]};
    const storyboard={bible:{premise:'Story',setting:'town',rules:[],character_ids:[]},pages:[{index:1,panels:[{id:'p1',index:1,character_ids:[],action:'A scene',framing:'wide',dialogue:[],state_before:state,state_after:state}]}]};
    expect(store.update(comic.id,owner,original.revision,{...original.data,...domain,storyboard})).toBe(true);
    expect((await post(`comics/${comic.id}/publish`,{title:'Review gate',creator:'A'},cookie)).status).toBe(200);
    store.putAdvisoryReview(comic.id,owner,`panel:p1:${image}:1:2`,{outcome:'findings',findings:[{severity:'blocker',dimension:'story',observed:'Missing light',expected:'Light'}]});
    const reviewed=(await (await handleApi(request(`comics/${comic.id}`,'GET',undefined,cookie),['comics',comic.id])).json()).comic.pages[0].panels[0];
    expect(reviewed.evaluation).toBe('blocker');expect(reviewed.accepted).toBe(false);
    expect((await post(`comics/${comic.id}/publish`,{title:'Review gate',creator:'A'},cookie)).status).toBe(200);
  } finally {delete process.env.COMEX_ASSET_PATH;await rm(dir,{recursive:true,force:true});}
});


test('uploaded references are private, normalized, and approved by exact image', async () => {
  const {mkdtemp, rm} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os'); const {join} = await import('node:path');
  const sharp = (await import('sharp')).default;
  const dir = await mkdtemp(join(tmpdir(), 'comex-upload-'));
  const priorAssetPath = process.env.COMEX_ASSET_PATH; process.env.COMEX_ASSET_PATH = dir;
  const priorFetch = globalThis.fetch; let calls = 0;
  try {
    globalThis.fetch = (async () => {calls++; throw new Error('upload must not call a provider');}) as unknown as typeof fetch;
    const created = await post('comics', {title:'References',plot:'A lighthouse',style:'ink-manga'});
    const {comic} = await created.json(); const cookie = created.headers.get('set-cookie')!.split(';')[0];
    const added = await post(`comics/${comic.id}/characters`, {name:'Pip',role:'keeper',appearance:'old card',outfit:'coat'}, cookie);
    const character = (await added.json()).comic.characters[0];
    const png = await sharp({create:{width:4,height:4,channels:4,background:{r:20,g:40,b:80,alpha:0.5}}}).png().toBuffer();
    const upload = async (bytes: Uint8Array, expected: string, expectedCard: string, media = 'image/png', owner = cookie, origin?: string) => {
      const form = new FormData(); form.set('image',new File([Uint8Array.from(bytes)],'pip.png',{type:media}));
      form.set('appearance','Blue hair'); form.set('outfit','Red coat'); form.set('expectedReferenceId',expected); form.set('expectedCardVersion',expectedCard);
      const path = `comics/${comic.id}/characters/${character.id}/reference/upload`;
      return handleApi(new NextRequest(`http://localhost:3000/api/${path}`,{method:'POST',headers:{cookie:owner,...(origin ? {origin} : {})},body:form}),path.split('/'));
    };
    const first = await upload(png, '',character.cardVersion); expect(first.status).toBe(200);
    const firstCard = (await first.json()).comic.characters[0];
    expect(firstCard.approved).toBe(false); expect(firstCard.appearance).toBe('Blue hair'); expect(firstCard.referenceVersion).toBeTruthy();
    const denied = await handleApi(request(`comics/${comic.id}/assets/${firstCard.referenceVersion}`),['comics',comic.id,'assets',firstCard.referenceVersion]);
    expect(denied.status).toBe(404);
    const preview = await handleApi(request(`comics/${comic.id}/assets/${firstCard.referenceVersion}`,'GET',undefined,cookie),['comics',comic.id,'assets',firstCard.referenceVersion]);
    expect(preview.status).toBe(200); expect((await sharp(Buffer.from(await preview.arrayBuffer())).metadata()).format).toBe('png');
    const approvedFirst=await post(`comics/${comic.id}/characters/${character.id}/approve`,{assetId:firstCard.referenceVersion},cookie);
    const approvedCard=(await approvedFirst.json()).comic.characters[0]; expect(approvedCard.approved).toBe(true);
    const second = await upload(png,firstCard.referenceVersion,approvedCard.cardVersion); expect(second.status).toBe(200);
    const secondCard = (await second.json()).comic.characters[0]; expect(secondCard.referenceVersion).not.toBe(firstCard.referenceVersion); expect(secondCard.approved).toBe(false);
    const stale = await post(`comics/${comic.id}/characters/${character.id}/approve`,{assetId:firstCard.referenceVersion},cookie);
    expect(stale.status).toBe(409);
    const approved = await post(`comics/${comic.id}/characters/${character.id}/approve`,{assetId:secondCard.referenceVersion},cookie);
    expect(approved.status).toBe(200); const currentCard=(await approved.json()).comic.characters[0]; expect(currentCard.approved).toBe(true);
    expect((await upload(new Uint8Array([1,2,3]),secondCard.referenceVersion,currentCard.cardVersion)).status).toBe(400);
    expect((await upload(png,secondCard.referenceVersion,currentCard.cardVersion,'image/png',cookie,'https://evil.example')).status).toBe(403);
    expect(calls).toBe(0);
  } finally {globalThis.fetch = priorFetch; if (priorAssetPath === undefined) delete process.env.COMEX_ASSET_PATH; else process.env.COMEX_ASSET_PATH = priorAssetPath; await rm(dir,{recursive:true,force:true});}
});


test('separately uploaded character sheets remain labeled anchors in panel rendering', async () => {
  const {mkdtemp,rm}=await import('node:fs/promises'); const {tmpdir}=await import('node:os'); const {join}=await import('node:path');
  const sharp=(await import('sharp')).default; const {createComic}=await import('@/src/lib/domain/comic');
  const dir=await mkdtemp(join(tmpdir(),'comex-anchors-')); const originalFetch=globalThis.fetch;
  const previous={asset:process.env.COMEX_ASSET_PATH,budget:process.env.COMEX_BUDGET_DB_PATH,limit:process.env.COMEX_MAX_PROVIDER_CALLS,concurrent:process.env.COMEX_MAX_CONCURRENT_CALLS,key:process.env.OPENAI_API_KEY};
  process.env.COMEX_ASSET_PATH=dir; process.env.COMEX_BUDGET_DB_PATH=join(dir,'budget.sqlite'); process.env.COMEX_MAX_PROVIDER_CALLS='5'; process.env.COMEX_MAX_CONCURRENT_CALLS='2'; process.env.OPENAI_API_KEY='test';
  try {
    const created=await post('comics',{title:'Two anchors',plot:'Pip and Nora explore',style:'ink-manga'});
    const {comic}=await created.json(); const cookie=created.headers.get('set-cookie')!.split(';')[0],owner=cookie.split('=')[1];
    const images:Buffer[]=[]; const characters:string[]=[];
    for (const [name,color] of [['Pip','#a12020'],['Nora','#2040a1']]) {
      const added=await post(`comics/${comic.id}/characters`,{name,role:'Keeper',appearance:`${name} face`,outfit:'Coat'},cookie);
      const character=(await added.json()).comic.characters.at(-1); characters.push(character.id);
      const png=await sharp({create:{width:8,height:8,channels:3,background:color}}).png().toBuffer();
      const form=new FormData(); form.set('image',new File([Uint8Array.from(png)],`${name}.png`,{type:'image/png'}));
      form.set('appearance',`${name} face`); form.set('outfit','Coat'); form.set('expectedReferenceId',''); form.set('expectedCardVersion',character.cardVersion);
      const path=`comics/${comic.id}/characters/${character.id}/reference/upload`;
      const uploaded=await handleApi(new NextRequest(`http://localhost:3000/api/${path}`,{method:'POST',headers:{cookie},body:form}),path.split('/'));
      expect(uploaded.status).toBe(200); const card=(await uploaded.json()).comic.characters.find((c:{id:string})=>c.id===character.id);
      const saved=await handleApi(request(`comics/${comic.id}/assets/${card.referenceVersion}`,'GET',undefined,cookie),['comics',comic.id,'assets',card.referenceVersion]);
      images.push(Buffer.from(await saved.arrayBuffer()));
      expect((await post(`comics/${comic.id}/characters/${character.id}/approve`,{assetId:card.referenceVersion},cookie)).status).toBe(200);
    }
    const store=(globalThis as typeof globalThis & {__comexLocalStore:LocalStore}).__comexLocalStore, current=store.getOwned<any>(comic.id,owner)!;
    const domain=createComic({id:comic.id,ownerId:owner,title:'Two anchors',creatorName:'',plot:'Pip and Nora explore',styleId:'ink-manga',pages:[{id:'page1',panels:[{id:'p1',beat:'Together'}]}]});
    const state={location:'lighthouse',time:'day',props:[],outfits:[],injuries:[],knowledge:[]};
    const storyboard={bible:{premise:'Explore',setting:'lighthouse',rules:[],character_ids:characters},pages:[{index:1,panels:[{id:'p1',index:1,character_ids:characters,action:'Together',framing:'wide',dialogue:[],state_before:state,state_after:state}]}]};
    expect(store.update(comic.id,owner,current.revision,{...current.data,...domain,storyboard})).toBe(true);
    await approveSeededStory(comic.id,cookie);
    let imageCalls=0;
    globalThis.fetch=(async (url:string|URL|Request,init?:RequestInit)=>{
      if(String(url).includes('/images/')) {
        imageCalls++; const form=init!.body as FormData, prompt=String(form.get('prompt')), files=form.getAll('image[]') as File[];
        expect(prompt).toContain(`approved character, ID ${characters[0]}`); expect(prompt).toContain(`approved character, ID ${characters[1]}`);
        expect(files).toHaveLength(2); expect(Buffer.from(await files[0].arrayBuffer()).toString('hex')).toBe(images[0].toString('hex')); expect(Buffer.from(await files[1].arrayBuffer()).toString('hex')).toBe(images[1].toString('hex'));
        return Response.json({data:[{b64_json:images[0].toString('base64')}]});
      }
      return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({outcome:'pass',findings:[]})}]}]});
    }) as typeof fetch;
    expect((await post(`comics/${comic.id}/pages/page1/generate`,{},cookie)).status).toBe(200);
    await waitForComic(comic.id,cookie,c=>c.pages[0].panels[0].reviewOutcome!==null);
    expect(imageCalls).toBe(1);
  } finally {
    globalThis.fetch=originalFetch;
    for (const [name,value] of Object.entries({COMEX_ASSET_PATH:previous.asset,COMEX_BUDGET_DB_PATH:previous.budget,COMEX_MAX_PROVIDER_CALLS:previous.limit,COMEX_MAX_CONCURRENT_CALLS:previous.concurrent,OPENAI_API_KEY:previous.key})) { if(value===undefined) delete process.env[name]; else process.env[name]=value; }
    await rm(dir,{recursive:true,force:true});
  }
});

test('reference uploads reject stale cards, other owners, duplicate fields and planned or pending work', async () => {
  const {mkdtemp,rm,readdir}=await import('node:fs/promises'); const {tmpdir}=await import('node:os'); const {join}=await import('node:path');
  const sharp=(await import('sharp')).default; const dir=await mkdtemp(join(tmpdir(),'comex-upload-guards-')); const prior=process.env.COMEX_ASSET_PATH; process.env.COMEX_ASSET_PATH=dir;
  try {
    const created=await post('comics',{title:'Upload guards',plot:'A lighthouse',style:'ink-manga'}); const {comic}=await created.json();
    const cookie=created.headers.get('set-cookie')!.split(';')[0],owner=cookie.split('=')[1];
    const added=await post(`comics/${comic.id}/characters`,{name:'Pip',role:'Keeper',appearance:'Hair',outfit:'Coat'},cookie);
    const character=(await added.json()).comic.characters[0]; const path=`comics/${comic.id}/characters/${character.id}/reference/upload`;
    const png=await sharp({create:{width:4,height:4,channels:3,background:'#abc'}}).png().toBuffer();
    const upload=(givenCookie:string, expected='', duplicate=false) => {
      const form=new FormData(); form.set('image',new File([Uint8Array.from(png)],'pip.png',{type:'image/png'})); form.set('appearance','Hair'); form.set('outfit','Coat'); form.set('expectedReferenceId',expected); form.set('expectedCardVersion',character.cardVersion);
      if(duplicate) form.append('appearance','Another card');
      return handleApi(new NextRequest(`http://localhost:3000/api/${path}`,{method:'POST',headers:{cookie:givenCookie},body:form}),path.split('/'));
    };
    expect((await upload(fixtureSession())).status).toBe(404);
    expect((await upload(cookie,'',true)).status).toBe(400);
    expect((await upload(cookie,'obsolete')).status).toBe(409);
    const editPath=`comics/${comic.id}/characters/${character.id}`;
    expect((await handleApi(request(editPath,'PATCH',{name:'Pip',role:'Keeper',appearance:'New hair',outfit:'Coat'},cookie),editPath.split('/'))).status).toBe(200);
    expect((await upload(cookie)).status).toBe(409);
    const store=(globalThis as typeof globalThis & {__comexLocalStore:LocalStore}).__comexLocalStore;
    let current=store.getOwned<any>(comic.id,owner)!;
    expect(store.update(comic.id,owner,current.revision,{...current.data,operations:{[`character:${character.id}`]:'unknown_outcome'}})).toBe(true);
    expect((await upload(cookie)).status).toBe(409);
    current=store.getOwned<any>(comic.id,owner)!;
    expect(store.update(comic.id,owner,current.revision,{...current.data,operations:{},pages:[{id:'planned',panels:[]}]})).toBe(true);
    expect((await upload(cookie)).status).toBe(409);
    expect((await readdir(dir)).length).toBe(0);
  } finally {if(prior===undefined) delete process.env.COMEX_ASSET_PATH; else process.env.COMEX_ASSET_PATH=prior; await rm(dir,{recursive:true,force:true});}
});

test('an upload cannot attach after the draft changes during multipart transfer', async () => {
  const {mkdtemp,rm,readdir}=await import('node:fs/promises'); const {tmpdir}=await import('node:os'); const {join}=await import('node:path');
  const sharp=(await import('sharp')).default; const dir=await mkdtemp(join(tmpdir(),'comex-upload-race-')); const prior=process.env.COMEX_ASSET_PATH; process.env.COMEX_ASSET_PATH=dir;
  try {
    const created=await post('comics',{title:'Upload race',plot:'A lighthouse',style:'ink-manga'}); const {comic}=await created.json();
    const cookie=created.headers.get('set-cookie')!.split(';')[0],owner=cookie.split('=')[1];
    const added=await post(`comics/${comic.id}/characters`,{name:'Pip',role:'Keeper',appearance:'Hair',outfit:'Coat'},cookie);
    const character=(await added.json()).comic.characters[0]; const path=`comics/${comic.id}/characters/${character.id}/reference/upload`;
    const png=await sharp({create:{width:4,height:4,channels:3,background:'#abc'}}).png().toBuffer();
    const form=new FormData(); form.set('image',new File([Uint8Array.from(png)],'pip.png',{type:'image/png'})); form.set('appearance','Hair'); form.set('outfit','Coat'); form.set('expectedReferenceId',''); form.set('expectedCardVersion',character.cardVersion);
    const encoded=new Request('http://localhost/upload',{method:'POST',body:form}); const contentType=encoded.headers.get('content-type')!; const body=new Uint8Array(await encoded.arrayBuffer());
    let started!:()=>void,release!:()=>void; const began=new Promise<void>(r=>started=r),gate=new Promise<void>(r=>release=r); let chunk=0;
    const stream=new ReadableStream<Uint8Array>({async pull(controller) {if(chunk++===0) {controller.enqueue(body.subarray(0,10)); started();} else {await gate; controller.enqueue(body.subarray(10)); controller.close();}}},{highWaterMark:0});
    const pending=handleApi(new NextRequest(`http://localhost:3000/api/${path}`,{method:'POST',headers:{cookie,'content-type':contentType},body:stream,duplex:'half'}),path.split('/'));
    await began;
    const store=(globalThis as typeof globalThis & {__comexLocalStore:LocalStore}).__comexLocalStore, current=store.getOwned<any>(comic.id,owner)!;
    expect(store.update(comic.id,owner,current.revision,{...current.data,title:'Changed while uploading'})).toBe(true);
    release(); expect((await pending).status).toBe(409);
    expect(store.getOwned<any>(comic.id,owner)!.data.characters[0].referenceAssetId).toBeUndefined();
    expect((await readdir(dir)).length).toBe(0);
  } finally {if(prior===undefined) delete process.env.COMEX_ASSET_PATH; else process.env.COMEX_ASSET_PATH=prior; await rm(dir,{recursive:true,force:true});}
});

test('a separately reserved story operation blocks upload attachment without changing its draft revision', async () => {
  const {mkdtemp,rm,readdir}=await import('node:fs/promises'); const {tmpdir}=await import('node:os'); const {join}=await import('node:path');
  const sharp=(await import('sharp')).default,dir=await mkdtemp(join(tmpdir(),'comex-upload-story-'));const prior=process.env.COMEX_ASSET_PATH;process.env.COMEX_ASSET_PATH=dir;
  try {
    const created=await post('comics',{title:'Story reservation',plot:'A lighthouse',style:'ink-manga'});const {comic}=await created.json();
    const cookie=created.headers.get('set-cookie')!.split(';')[0],owner=cookie.split('=')[1];
    const added=await post(`comics/${comic.id}/characters`,{name:'Pip',role:'Keeper',appearance:'Hair',outfit:'Coat'},cookie);const character=(await added.json()).comic.characters[0];
    const store=(globalThis as typeof globalThis & {__comexLocalStore:LocalStore}).__comexLocalStore,record=store.getOwned<any>(comic.id,owner)!;
    expect(store.reserveTextOperation(comic.id,owner,record.revision)).toBe(true);
    const png=await sharp({create:{width:4,height:4,channels:3,background:'#abc'}}).png().toBuffer();
    const form=new FormData();form.set('image',new File([Uint8Array.from(png)],'pip.png',{type:'image/png'}));form.set('appearance','Hair');form.set('outfit','Coat');form.set('expectedReferenceId','');form.set('expectedCardVersion',character.cardVersion);
    const path=`comics/${comic.id}/characters/${character.id}/reference/upload`;
    const response=await handleApi(new NextRequest(`http://localhost:3000/api/${path}`,{method:'POST',headers:{cookie},body:form}),path.split('/'));
    expect(response.status).toBe(409);expect(store.getOwned<any>(comic.id,owner)!.revision).toBe(record.revision);expect((await readdir(dir)).length).toBe(0);
    store.finishTextOperation(comic.id,owner,false);
  } finally {if(prior===undefined)delete process.env.COMEX_ASSET_PATH;else process.env.COMEX_ASSET_PATH=prior;await rm(dir,{recursive:true,force:true});}
});

test('an unused character cannot receive an uploaded reference after pages are planned', async () => {
  const created=await post('comics',{title:'Planned upload',plot:'A lighthouse',style:'ink-manga'});
  const {comic}=await created.json(),cookie=created.headers.get('set-cookie')!.split(';')[0],owner=cookie.split('=')[1];
  const added=await post(`comics/${comic.id}/characters`,{name:'Pip',role:'Keeper',appearance:'Hair',outfit:'Coat'},cookie);
  const character=(await added.json()).comic.characters[0];
  const store=(globalThis as typeof globalThis & {__comexLocalStore:LocalStore}).__comexLocalStore,record=store.getOwned<any>(comic.id,owner)!;
  const storyboard={bible:{premise:'A light',setting:'Lighthouse',rules:[],character_ids:[]},pages:[]};
  expect(store.update(comic.id,owner,record.revision,{...record.data,storyboard,pages:[{id:'planned',panels:[]}]})).toBe(true);
  const viewed=await handleApi(request(`comics/${comic.id}`,'GET',undefined,cookie),['comics',comic.id]);
  expect((await viewed.json()).comic.characters[0].lockedByStory).toBe(false);
  const form=new FormData();form.set('image',new File([new Uint8Array([1])],'pip.png',{type:'image/png'}));form.set('appearance','Hair');form.set('outfit','Coat');form.set('expectedReferenceId','');form.set('expectedCardVersion',character.cardVersion);
  const path=`comics/${comic.id}/characters/${character.id}/reference/upload`;
  const response=await handleApi(new NextRequest(`http://localhost:3000/api/${path}`,{method:'POST',headers:{cookie},body:form}),path.split('/'));
  expect(response.status).toBe(409);expect((await response.json()).error).toContain('before pages are planned');
  expect(store.getOwned<any>(comic.id,owner)!.data.characters[0].referenceAssetId).toBeUndefined();
});
