import { beforeAll, describe, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import {createHash, randomBytes} from 'node:crypto';
import {LocalStore} from '@/src/lib/local-store';

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
    const pages=Array.from({length:3},(_,i)=>({index:i+1,panels:Array.from({length:3},(_,j)=>({id:`p${i*3+j+1}`,index:j+1,character_ids:['mina'],action:'Deliver',framing:'wide',dialogue:[],state_before:state,state_after:state}))}));
    const inputs:Record<string,unknown>[]=[];
    globalThis.fetch=(async (_url:string|URL|Request,init?:RequestInit)=>{
      const body=JSON.parse(String(init?.body)); inputs.push({name:body.text.format.name, ...JSON.parse(body.input[1].content)});
      const value=body.text.format.name==='narrative_questions'?{questions:[{id:'q1',question:'What is the weather?',suggested_answer:'Sunny'}]}:body.text.format.name==='storyboard'?{bible:{premise:'Delivery',setting:'town',rules:[],character_ids:['mina']},pages}:{outcome:'inconclusive',findings:[]};
      return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]});
    }) as unknown as typeof fetch;
    const refreshed=await post(`comics/${comic.id}/questions`,{},cookie); expect(refreshed.status).toBe(200);
    const data=(await refreshed.json()).comic; expect(data.questions[0]).toEqual(questions[0]); expect(data.questions[1].id).not.toBe('q1'); expect(data.answers).toEqual({q1:'Her brother'});
    const planned=await post(`comics/${comic.id}/story/plan`,{},cookie); expect(planned.status).toBe(200);
    expect(inputs.map(input=>input.name)).toEqual(['narrative_questions','storyboard','narrative_judgment']);
    for (const input of inputs) expect(input.answers).toEqual({'Who is the recipient?':'Her brother'});
  } finally {globalThis.fetch=originalFetch;delete process.env.COMEX_BUDGET_DB_PATH;delete process.env.COMEX_MAX_PROVIDER_CALLS;delete process.env.OPENAI_API_KEY;await rm(dir,{recursive:true,force:true});}
});

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
    expect((await reopened.json()).comic.publication).toEqual({title:'Public comic',creator:'Mina'});
    const reader = await handleApi(request(`published/${comic.id}`),['published',comic.id]);
    const publicComic = (await reader.json()).comic;
    expect(publicComic.title).toBe('Public comic');
    expect(publicComic.pages.length).toBe(1);
    const url = new URL(publicComic.pages[0].imageUrl,'http://localhost:3000');
    const image = await handleApi(new NextRequest(url), ['published',comic.id,'assets',url.pathname.split('/').pop()!]);
    expect(image.status).toBe(200); expect(image.headers.get('content-type')).toBe('image/png');
    const imageBytes = Buffer.from(await image.arrayBuffer());
    const meta = await sharp(imageBytes).metadata(); expect(meta.height).toBeGreaterThan(700);
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
    const state={location:'town',time:'day',props:[],outfits:[],injuries:[],knowledge:[]};const spec=(id:string,action:string)=>({id,index:1,character_ids:['mina'],action,framing:'wide',dialogue:[],state_before:state,state_after:state});
    const original=[spec('p1','A'),spec('p2','B'),spec('p3','C')];const bible={premise:'Delivery',setting:'town',rules:[],character_ids:['mina']};
    const storyboard={bible,pages:original.map((p,i)=>({index:i+1,panels:[p]}))};
    expect(store.update(comic.id,owner,current.revision,{...current.data,...domain,storyboard,characters:[{id:'mina',name:'Mina',role:'courier',appearance:'hair',outfit:'coat',approved:true,referenceAssetId:ids[0]}]})).toBe(true);
    let images=0;globalThis.fetch=(async (url:string|URL|Request,init?:RequestInit)=>{
      if(String(url).includes('/images/')){images++;return Response.json({data:[{b64_json:png.toString('base64')}]});}
      const name=JSON.parse(String(init?.body)).text.format.name;
      const learned={...state,knowledge:[{key:'mina',value:'knows the recipient'},{key:'mina',value:'knows the recipient'}]};
      const value=name==='plot_revision'?{earliest_affected_panel_id:'p2',explanation:'The key changes hands earlier.',revised_bible:bible,revised_suffix:[{...spec('p2','New B'),state_after:learned},{...spec('p3','New C'),state_before:learned,state_after:learned}]}:{outcome:'inconclusive',findings:[]};
      return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]});
    }) as unknown as typeof fetch;
    const preview=await post(`comics/${comic.id}/revisions/preview`,{panelId:'p3',instruction:'Keep the key'},cookie);expect(preview.status).toBe(200);const {proposal}=await preview.json();
    expect(proposal.affectedPage).toBe(2);expect(proposal.earliestPanelId).toBe('p2');
    const savedProposal=store.getOwned<any>(comic.id,owner)!.data.pendingRevision;
    expect(savedProposal.result.revised_suffix[0].state_after.knowledge).toEqual([{key:'mina',value:'knows the recipient'}]);
    expect(savedProposal.result.revised_suffix[1].state_before.knowledge).toEqual([{key:'mina',value:'knows the recipient'}]);
    expect(store.getOwned<{storyRevision:number}>(comic.id,owner)!.data.storyRevision).toBe(1);
    const invalid=await post(`comics/${comic.id}/revisions`,{proposalId:'wrong'},cookie);expect(invalid.status).toBe(409);
    const apply=await post(`comics/${comic.id}/revisions`,{proposalId:proposal.id},cookie);expect(apply.status).toBe(200);
    expect(store.getOwned<any>(comic.id,owner)!.data.storyboard.pages[1].panels[0].state_after.knowledge).toEqual([{key:'mina',value:'knows the recipient'}]);
    const final=store.getOwned<{storyRevision:number,pages:{panels:{id:string,assetId:string,status:string}[]}[]}>(comic.id,owner)!.data;
    expect(final.storyRevision).toBe(2);expect(final.pages[0].panels[0].assetId).toBe(ids[1]);expect(final.pages[1].panels[0].assetId).not.toBe(ids[2]);expect(final.pages[2].panels[0].assetId).toBe(ids[3]);expect(final.pages[2].panels[0].status).toBe('outdated');expect(images).toBe(1);
  } finally {globalThis.fetch=originalFetch;delete process.env.COMEX_ASSET_PATH;delete process.env.COMEX_BUDGET_DB_PATH;delete process.env.COMEX_MAX_PROVIDER_CALLS;delete process.env.OPENAI_API_KEY;await rm(dir,{recursive:true,force:true});}
});

test('artwork edit is bound to the viewed panel before and after classification', async () => {
  const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const {createComic,commitPanelRender}=await import('@/src/lib/domain/comic');const sharp=(await import('sharp')).default;
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
    const png=await sharp({create:{width:8,height:8,channels:4,background:'#fff'}}).png().toBuffer();
    globalThis.fetch=(async (url:string|URL|Request)=>{if(String(url).includes('/images/')){imageCalls++;return Response.json({data:[{b64_json:png.toString('base64')}]});} textCalls++;started();await gate;return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({intent:'artwork',reason:'lighting'})}]}]});}) as unknown as typeof fetch;
    const path=`comics/${comic.id}/panels/p1/edit`;
    const unbound=post(path,{instruction:'Change lighting'},cookie);
    const first=await Promise.race([unbound.then(r=>r.status),began.then(()=>-1)]);
    expect(first).toBe(400);
    expect(textCalls).toBe(0);
    expect((await post(path,{instruction:'Change lighting',assetId:asset,storyRevision:1,panelRevision:1},cookie)).status).toBe(409);
    expect(textCalls).toBe(0);
    const pending=post(path,{instruction:'Change lighting',assetId:asset,storyRevision:1,panelRevision:2},cookie);await began;
    const latest=store.getOwned<any>(comic.id,owner)!;
    const pages=latest.data.pages.map((page:any)=>({...page,panels:page.panels.map((p:any)=>({...p,storyRevision:2}))}));
    expect(store.update(comic.id,owner,latest.revision,{...latest.data,storyRevision:2,pages})).toBe(true);
    release();expect((await pending).status).toBe(409);expect(imageCalls).toBe(0);expect(textCalls).toBe(1);
  } finally {release();globalThis.fetch=originalFetch;delete process.env.COMEX_ASSET_PATH;delete process.env.COMEX_BUDGET_DB_PATH;delete process.env.COMEX_MAX_PROVIDER_CALLS;delete process.env.OPENAI_API_KEY;await rm(dir,{recursive:true,force:true});}
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
    globalThis.fetch=(async (url:string|URL|Request,init?:RequestInit)=>{if(String(url).includes('/images/'))return Response.json({data:[{b64_json:png.toString('base64')}]});const name=JSON.parse(String(init?.body)).text.format.name;const value=name==='edit_intent'?{intent:'artwork',reason:'Change light only'}:{outcome:'inconclusive',findings:[]};return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]});}) as unknown as typeof fetch;
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

test('visual review must finish before acceptance or next-page generation', async () => {
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
    globalThis.fetch=(async (url:string|URL|Request,init?:RequestInit)=>{if(String(url).includes('/images/')){images++;expect(String((init?.body as FormData).get('prompt'))).not.toContain('Safe and dry.');return Response.json({data:[{b64_json:png.toString('base64')}]});}const payload=JSON.parse(String(init?.body));expect(payload.input[0].content).toContain('unlettered source images');expect(payload.input[1].content[0].text).not.toContain('Safe and dry.');started();await gate;return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({outcome:'findings',findings:[{severity:'blocker',dimension:'story',panel_id:'p1',character_id:null,reference_id:null,expected:'key',observed:'no key',repair:'fix'}]})}]}]});}) as unknown as typeof fetch;
    const pending=post(`comics/${comic.id}/pages/page1/generate`,{},cookie);await began;
    const checking=(await (await handleApi(request(`comics/${comic.id}`,'GET',undefined,cookie),['comics',comic.id])).json()).comic.pages[0].panels[0];
    const acceptance=await post(`comics/${comic.id}/panels/p1/accept`,checking.reviewVersion,cookie);release();await pending;
    expect(acceptance.status).toBe(409);
    const result=await (await handleApi(request(`comics/${comic.id}`,'GET',undefined,cookie),['comics',comic.id])).json();expect(result.comic.pages[0].status).not.toBe('current');expect(result.comic.pages[0].panels[0].evaluation).toBe('blocker');
    expect((await post(`comics/${comic.id}/pages/page2/generate`,{},cookie)).status).toBe(409);expect(images).toBe(1);
  } finally {release();globalThis.fetch=originalFetch;delete process.env.COMEX_ASSET_PATH;delete process.env.COMEX_BUDGET_DB_PATH;delete process.env.COMEX_MAX_PROVIDER_CALLS;delete process.env.OPENAI_API_KEY;await rm(dir,{recursive:true,force:true});}
});

test('a visual blocker pauses the page before later panels and resumes after repair', async () => {
  const {mkdtemp,writeFile,rm}=await import('node:fs/promises'); const {tmpdir}=await import('node:os'); const {join}=await import('node:path');
  const sharp=(await import('sharp')).default; const {createComic}=await import('@/src/lib/domain/comic');
  const dir=await mkdtemp(join(tmpdir(),'comex-blocked-page-')); process.env.COMEX_ASSET_PATH=dir;process.env.COMEX_BUDGET_DB_PATH=join(dir,'budget.sqlite');process.env.COMEX_MAX_PROVIDER_CALLS='20';process.env.OPENAI_API_KEY='test';
  const originalFetch=globalThis.fetch; let images=0, reviews=0;
  try {
    const png=await sharp({create:{width:8,height:8,channels:4,background:'#fff'}}).png().toBuffer(); const ref='11111111-1111-4111-8111-111111111111';await writeFile(join(dir,`${ref}.png`),png);
    for (const mode of ['repair','accept'] as const) {
    images=0;reviews=0;
    const created=await post('comics',{title:'Blocker',plot:'Deliver',style:'ink-manga'});const {comic}=await created.json();const cookie=created.headers.get('set-cookie')!.split(';')[0],owner=cookie.split('=')[1];
    const store=(globalThis as typeof globalThis & {__comexLocalStore:import('@/src/lib/local-store').LocalStore}).__comexLocalStore;const original=store.getOwned<Record<string,unknown>>(comic.id,owner)!;
    const domain=createComic({id:comic.id,ownerId:owner,title:'Blocker',creatorName:'',plot:'Deliver',styleId:'ink-manga',pages:[{id:'page1',panels:[{id:'p1',beat:'First'},{id:'p2',beat:'Second'},{id:'p3',beat:'Third'}]}]});
    const state={location:'town',time:'day',props:[],outfits:[],injuries:[],knowledge:[]};const spec=(id:string,index:number)=>({id,index,character_ids:['mina'],action:id,framing:'wide',dialogue:[],state_before:state,state_after:state});
    const storyboard={bible:{premise:'Deliver',setting:'town',rules:[],character_ids:['mina']},pages:[{index:1,panels:[spec('p1',1),spec('p2',2),spec('p3',3)]}]};
    expect(store.update(comic.id,owner,original.revision,{...original.data,...domain,storyboard,characters:[{id:'mina',name:'Mina',role:'courier',appearance:'hair',outfit:'coat',approved:true,referenceAssetId:ref}]})).toBe(true);
    globalThis.fetch=(async (url:string|URL|Request,init?:RequestInit)=>{
      if(String(url).includes('/images/')){images++;return Response.json({data:[{b64_json:png.toString('base64')}]});}
      const name=JSON.parse(String(init?.body)).text.format.name;
      const value=name==='edit_intent' ? {intent:'artwork',reason:'Visual correction'} : ++reviews===1 ? {outcome:'findings',findings:[{severity:'blocker',dimension:'identity',panel_id:'p1',character_id:'mina',reference_id:'mina',expected:'coat',observed:'wrong coat',repair:'fix coat'}]} : {outcome:'inconclusive',findings:[]};
      return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]});
    }) as unknown as typeof fetch;
    const first=await post(`comics/${comic.id}/pages/page1/generate`,{},cookie); expect(first.status).toBe(200); const paused=await first.json();
    expect(paused.comic.pages[0].panels[0].evaluation).toBe('blocker');expect(images).toBe(1);
    expect(paused.comic.pages[0].panels[1].imageUrl).toBeNull();
    await post(`comics/${comic.id}/pages/page1/generate`,{},cookie);expect(images).toBe(1);
    if (mode === 'repair') {
      const repair=await post(`comics/${comic.id}/panels/p1/edit`,{instruction:'Correct the coat',...paused.comic.pages[0].panels[0].reviewVersion},cookie);expect(repair.status).toBe(200);expect(images).toBe(2);
    } else {
      const acceptance=await post(`comics/${comic.id}/panels/p1/accept`,paused.comic.pages[0].panels[0].reviewVersion,cookie);expect(acceptance.status).toBe(200);const accepted=await acceptance.json();expect(accepted.comic.pages[0].panels[0].accepted).toBe(true);expect(accepted.comic.pages[0].panels[0].evaluation).toBe('blocker');expect(images).toBe(1);
    }
    const resumed=await post(`comics/${comic.id}/pages/page1/generate`,{},cookie);expect(resumed.status).toBe(200);expect(images).toBe(mode === 'repair' ? 4 : 3);
    const result=await resumed.json();expect(result.comic.pages[0].panels.every((panel:{imageUrl:string|null})=>!!panel.imageUrl)).toBe(true);
    }
  } finally {globalThis.fetch=originalFetch;delete process.env.COMEX_ASSET_PATH;delete process.env.COMEX_BUDGET_DB_PATH;delete process.env.COMEX_MAX_PROVIDER_CALLS;delete process.env.OPENAI_API_KEY;await rm(dir,{recursive:true,force:true});}
});

test('narrative blocker stops page generation and artwork edits before provider dispatch', async () => {
  const {mkdtemp,writeFile,rm}=await import('node:fs/promises'); const {tmpdir}=await import('node:os'); const {join}=await import('node:path');const sharp=(await import('sharp')).default;const {createComic,commitPanelRender}=await import('@/src/lib/domain/comic');
  const dir=await mkdtemp(join(tmpdir(),'comex-story-block-'));process.env.COMEX_ASSET_PATH=dir;process.env.COMEX_BUDGET_DB_PATH=join(dir,'budget.sqlite');process.env.COMEX_MAX_PROVIDER_CALLS='10';process.env.OPENAI_API_KEY='test';const originalFetch=globalThis.fetch;let calls=0;
  try {
    const png=await sharp({create:{width:8,height:8,channels:4,background:'#fff'}}).png().toBuffer();const ref='11111111-1111-4111-8111-111111111111';await writeFile(join(dir,`${ref}.png`),png);
    const created=await post('comics',{title:'Block',plot:'A story',style:'ink-manga'});const {comic}=await created.json();const cookie=created.headers.get('set-cookie')!.split(';')[0],owner=cookie.split('=')[1];const store=(globalThis as typeof globalThis & {__comexLocalStore:import('@/src/lib/local-store').LocalStore}).__comexLocalStore;const original=store.getOwned<Record<string,unknown>>(comic.id,owner)!;
    let domain=createComic({id:comic.id,ownerId:owner,title:'Block',creatorName:'',plot:'A story',styleId:'ink-manga',pages:[{id:'page1',panels:[{id:'p1',beat:'First'}]}]});domain=commitPanelRender(domain,owner,'p1',{storyRevision:1,panelRevision:1},ref,'pass');
    const state={location:'town',time:'day',props:[],outfits:[],injuries:[],knowledge:[]};const spec={id:'p1',index:1,character_ids:['mina'],action:'First',framing:'wide',dialogue:[],state_before:state,state_after:state};const storyboard={bible:{premise:'A story',setting:'town',rules:[],character_ids:['mina']},pages:[{index:1,panels:[spec]}]};
    expect(store.update(comic.id,owner,original.revision,{...original.data,...domain,storyboard,storyReview:{outcome:'findings',findings:[{severity:'blocker',dimension:'story',observed:'impossible ending'}]},characters:[{id:'mina',name:'Mina',role:'courier',appearance:'hair',outfit:'coat',approved:true,referenceAssetId:ref}]})).toBe(true);
    globalThis.fetch=(async (url:string|URL|Request,init?:RequestInit)=>{calls++;if(String(url).includes('/images/'))return Response.json({data:[{b64_json:png.toString('base64')}]});const name=JSON.parse(String(init?.body)).text.format.name;const value=name==='edit_intent'?{intent:'artwork',reason:'Lighting'}:{outcome:'inconclusive',findings:[]};return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]});}) as unknown as typeof fetch;
    const generate=await post(`comics/${comic.id}/pages/page1/generate`,{},cookie);const edit=await post(`comics/${comic.id}/panels/p1/edit`,{instruction:'Change lighting',assetId:ref,storyRevision:1,panelRevision:2},cookie);expect(generate.status).toBe(409);expect(edit.status).toBe(409);expect(calls).toBe(0);
    const review=await (await handleApi(request(`comics/${comic.id}`,'GET',undefined,cookie),['comics',comic.id])).json();
    const acceptance=await post(`comics/${comic.id}/story/accept`,{fingerprint:review.comic.storyReview.fingerprint},cookie);expect(acceptance.status).toBe(200);
    const continued=await post(`comics/${comic.id}/pages/page1/generate`,{},cookie);expect(continued.status).toBe(200);expect(calls).toBe(2);
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
  expect(store.update(comic.id,owner,original.revision,{...original.data,...domain,storyboard,storyReview:{outcome:'findings',findings:[finding]}})).toBe(true);
  const get=async ()=>(await (await handleApi(request(`comics/${comic.id}`,'GET',undefined,cookie),['comics',comic.id])).json()).comic;
  const before=await get();expect(before.storyReview.accepted).toBe(false);
  expect((await post(`comics/${comic.id}/story/accept`,{fingerprint:'0'.repeat(64)},cookie)).status).toBe(409);
  const accepted=await post(`comics/${comic.id}/story/accept`,{fingerprint:before.storyReview.fingerprint},cookie);expect(accepted.status).toBe(200);expect((await accepted.json()).comic.storyReview.accepted).toBe(true);
  const current=store.getOwned<Record<string,unknown>>(comic.id,owner)!;
  expect(store.update(comic.id,owner,current.revision,{...current.data,storyRevision:2,storyboard:{...storyboard,bible:{...storyboard.bible,premise:'Changed'}}})).toBe(true);
  const changed=await get();expect(changed.storyReview.accepted).toBe(false);
  expect((await post(`comics/${comic.id}/story/accept`,{fingerprint:before.storyReview.fingerprint},cookie)).status).toBe(409);
  const latest=store.getOwned<Record<string,unknown>>(comic.id,owner)!;
  expect(store.update(comic.id,owner,latest.revision,{...latest.data,storyReview:{outcome:'inconclusive',findings:[finding]}})).toBe(true);
  const incomplete=await get();expect((await post(`comics/${comic.id}/story/accept`,{fingerprint:incomplete.storyReview.fingerprint},cookie)).status).toBe(409);
});

test('applying a blocked story revision saves it without drawing', async () => {
  const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {createComic}=await import('@/src/lib/domain/comic');
  const dir=await mkdtemp(join(tmpdir(),'comex-revision-block-'));process.env.COMEX_BUDGET_DB_PATH=join(dir,'budget.sqlite');process.env.COMEX_MAX_PROVIDER_CALLS='5';process.env.OPENAI_API_KEY='test';const originalFetch=globalThis.fetch;let images=0;
  try {
    const created=await post('comics',{title:'Revise',plot:'Deliver',style:'ink-manga'});const {comic}=await created.json();const cookie=created.headers.get('set-cookie')!.split(';')[0],owner=cookie.split('=')[1];const store=(globalThis as typeof globalThis & {__comexLocalStore:import('@/src/lib/local-store').LocalStore}).__comexLocalStore;const original=store.getOwned<Record<string,unknown>>(comic.id,owner)!;
    const domain=createComic({id:comic.id,ownerId:owner,title:'Revise',creatorName:'',plot:'Deliver',styleId:'ink-manga',pages:[{id:'page1',panels:[{id:'p1',beat:'First'}]}]});const state={location:'town',time:'day',props:[],outfits:[],injuries:[],knowledge:[]};const spec={id:'p1',index:1,character_ids:[],action:'Revised',framing:'wide',dialogue:[],state_before:state,state_after:state};const bible={premise:'Deliver',setting:'town',rules:[],character_ids:[]};const storyboard={bible,pages:[{index:1,panels:[spec]}]};
    const pendingRevision={id:'proposal',baseRevision:original.revision+1,result:{earliest_affected_panel_id:'p1',explanation:'Revise',revised_bible:bible,revised_suffix:[spec]}};
    expect(store.update(comic.id,owner,original.revision,{...original.data,...domain,storyboard,pendingRevision,characters:[],pageOperations:{page1:{storyRevision:1,baseline:{p1:1}}}})).toBe(true);
    globalThis.fetch=(async (url:string|URL|Request)=>{if(String(url).includes('/images/')){images++;throw new Error('must not render');}return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({outcome:'findings',findings:[{severity:'blocker',dimension:'story',panel_id:'p1',character_id:null,reference_id:null,expected:'key',observed:'no key',repair:'fix'}]})}]}]});}) as unknown as typeof fetch;
    const response=await post(`comics/${comic.id}/revisions`,{proposalId:'proposal'},cookie);expect(response.status).toBe(200);const body=await response.json();expect(body.notice).toContain('blockers');expect(body.comic.storyReview.findings[0].severity).toBe('blocker');expect(body.comic.pages[0].panels[0].status).toBe('outdated');expect(images).toBe(0);expect(store.getOwned<{storyRevision:number}>(comic.id,owner)!.data.storyRevision).toBe(2);expect(store.getOwned<{pageOperations?:Record<string,unknown>}>(comic.id,owner)!.data.pageOperations?.page1).toBeUndefined();
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
    globalThis.fetch=(async (url:string|URL|Request)=>{if(String(url).includes('/images/'))return Response.json({data:[{b64_json:png.toString('base64')}]});throw new Error('judge unavailable');}) as unknown as typeof fetch;
    const response=await post(`comics/${comic.id}/pages/page1/generate`,{},cookie);expect(response.status).toBe(200);const body=await response.json();expect(body.comic.pages[0].panels[0].status).toBe('needs_review');expect(body.comic.pages[0].panels[0].evaluation).toBe('uncertain');expect(body.comic.pages[0].panels[0].reviewOutcome).toBe('failed');expect(body.comic.pages[0].panels[0].imageUrl).toBeTruthy();expect((await post(`comics/${comic.id}/panels/p1/accept`,body.comic.pages[0].panels[0].reviewVersion,cookie)).status).toBe(200);
  } finally {globalThis.fetch=originalFetch;delete process.env.COMEX_ASSET_PATH;delete process.env.COMEX_BUDGET_DB_PATH;delete process.env.COMEX_MAX_PROVIDER_CALLS;delete process.env.OPENAI_API_KEY;await rm(dir,{recursive:true,force:true});}
});

test('a successful empty visual review is distinguishable from failure and remains manually reviewable', async () => {
  const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const sharp=(await import('sharp')).default;const {createComic}=await import('@/src/lib/domain/comic');
  const dir=await mkdtemp(join(tmpdir(),'comex-judge-pass-'));process.env.COMEX_ASSET_PATH=dir;process.env.COMEX_BUDGET_DB_PATH=join(dir,'budget.sqlite');process.env.COMEX_MAX_PROVIDER_CALLS='5';process.env.OPENAI_API_KEY='test';const originalFetch=globalThis.fetch;
  try {
    const png=await sharp({create:{width:8,height:8,channels:4,background:'#fff'}}).png().toBuffer();const ref='11111111-1111-4111-8111-111111111111';await writeFile(join(dir,`${ref}.png`),png);const created=await post('comics',{title:'Judge',plot:'Deliver',style:'ink-manga'});const {comic}=await created.json();const cookie=created.headers.get('set-cookie')!.split(';')[0],owner=cookie.split('=')[1];const store=(globalThis as typeof globalThis & {__comexLocalStore:import('@/src/lib/local-store').LocalStore}).__comexLocalStore;const original=store.getOwned<Record<string,unknown>>(comic.id,owner)!;
    const domain=createComic({id:comic.id,ownerId:owner,title:'Judge',creatorName:'',plot:'Deliver',styleId:'ink-manga',pages:[{id:'page1',panels:[{id:'p1',beat:'First'}]}]});const state={location:'town',time:'day',props:[],outfits:[],injuries:[],knowledge:[]};const spec={id:'p1',index:1,character_ids:['mina'],action:'First',framing:'wide',dialogue:[],state_before:state,state_after:state};const storyboard={bible:{premise:'Deliver',setting:'town',rules:[],character_ids:['mina']},pages:[{index:1,panels:[spec]}]};
    expect(store.update(comic.id,owner,original.revision,{...original.data,...domain,storyboard,characters:[{id:'mina',name:'Mina',role:'courier',appearance:'hair',outfit:'coat',approved:true,referenceAssetId:ref}]})).toBe(true);
    let judgeOutcome='pass';
    globalThis.fetch=(async (url:string|URL|Request)=>String(url).includes('/images/') ? Response.json({data:[{b64_json:png.toString('base64')}]}) : Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({outcome:judgeOutcome,findings:[]})}]}]})) as unknown as typeof fetch;
    const response=await post(`comics/${comic.id}/pages/page1/generate`,{},cookie);expect(response.status).toBe(200);const panel=(await response.json()).comic.pages[0].panels[0];
    expect(panel.reviewOutcome).toBe('pass');expect(panel.evaluation).toBe('uncertain');expect(panel.status).toBe('needs_review');expect(panel.accepted).toBe(false);
    expect((await post(`comics/${comic.id}/panels/p1/accept`,panel.reviewVersion,cookie)).status).toBe(200);
    judgeOutcome='inconclusive';
    const redraw=await post(`comics/${comic.id}/pages/page1/generate`,{},cookie);expect(redraw.status).toBe(200);expect((await redraw.json()).comic.pages[0].panels[0].reviewOutcome).toBe('inconclusive');
    const current=store.getOwned<any>(comic.id,owner)!;const stale={...current.data,pages:current.data.pages.map((page:any)=>({...page,panels:page.panels.map((item:any)=>({...item,revision:item.revision+1}))}))};
    expect(store.update(comic.id,owner,current.revision,stale)).toBe(true);
    const fresh=await handleApi(request(`comics/${comic.id}`,'GET',undefined,cookie),['comics',comic.id]);expect((await fresh.json()).comic.pages[0].panels[0].reviewOutcome).toBeNull();
  } finally {globalThis.fetch=originalFetch;delete process.env.COMEX_ASSET_PATH;delete process.env.COMEX_BUDGET_DB_PATH;delete process.env.COMEX_MAX_PROVIDER_CALLS;delete process.env.OPENAI_API_KEY;await rm(dir,{recursive:true,force:true});}
});
