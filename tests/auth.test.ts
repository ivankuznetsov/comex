import {afterEach,describe,expect,test} from 'bun:test';
import {NextRequest} from 'next/server';
import {LocalStore} from '../src/lib/local-store';
import {handleApi} from '../src/lib/local-api';
import {createBlankComic} from '../src/lib/domain/comic';

const oldFetch=globalThis.fetch;
const state=globalThis as typeof globalThis & {__comexLocalStore?:LocalStore};
const oldStore=state.__comexLocalStore;
const oldEnv={...process.env};
afterEach(()=>{globalThis.fetch=oldFetch;state.__comexLocalStore=oldStore;for(const k of ['COMEX_APP_URL','RESEND_API_KEY','COMEX_EMAIL_FROM','COMEX_AUTH_SECRET']) {if(oldEnv[k]===undefined) delete process.env[k];else process.env[k]=oldEnv[k];}});
const req=(path:string,body?:unknown,cookies='',origin='http://localhost:3000')=>new NextRequest(`http://localhost:3000/api/${path}`,{method:body===undefined?'GET':'POST',headers:{host:'localhost:3000',...(body===undefined?{}:{'content-type':'application/json',origin}),...(cookies?{cookie:cookies}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
const run=(path:string,body?:unknown,cookies='',origin?:string)=>handleApi(req(path,body,cookies,origin),path.split('/'));
const cookie=(response:Response,name:string)=>{const match=response.headers.get('set-cookie')?.match(new RegExp(`(?:^|,\\s*)${name}=([^;,]+)`));if(!match)throw new Error(`missing ${name}`);return `${name}=${match[1]}`;};
function configure(){process.env.COMEX_APP_URL='http://localhost:3000';process.env.RESEND_API_KEY='test';process.env.COMEX_EMAIL_FROM='Comex <comex@example.test>';process.env.COMEX_AUTH_SECRET='test-secret-with-at-least-32-characters-long';}
const codeOf=(text:string)=>text.match(/code is (\d{8})/)![1];

describe('email code authentication',()=>{
 test('a new browser can create and later claim drafts without entering an email first',async()=>{
  const store=new LocalStore(':memory:');state.__comexLocalStore=store;configure();let text='';
  globalThis.fetch=(async(_u,init)=>{text=JSON.parse(String(init?.body)).text;return new Response('{}',{status:200});}) as typeof fetch;
  const made=await run('comics',{title:'Draft',plot:'A story',style:'ink-manga'});expect(made.status).toBe(201);
  const id=(await made.json()).comic.id,guest=cookie(made,'comex_session');
  expect((await run(`comics/${id}`,undefined,guest)).status).toBe(200);
  const issued=await run('auth/request',{email:'creator@example.test',claimGuest:true},guest);expect(issued.status).toBe(200);
  const verified=await run('auth/verify',{email:'creator@example.test',code:codeOf(text)},`${guest}; ${cookie(issued,'comex_login')}`);
  expect(verified.status).toBe(200);expect((await run(`comics/${id}`,undefined,cookie(verified,'comex_auth'))).status).toBe(200);store.close();
 });
 test('verified creator can claim legacy drafts, but cannot claim an internal account owner ID as a legacy cookie',async()=>{
  const store=new LocalStore(':memory:');state.__comexLocalStore=store;configure();let text='';
  globalThis.fetch=(async(_u,init)=>{text=JSON.parse(String(init?.body)).text;return new Response('{}',{status:200});}) as typeof fetch;
  const legacy='a'.repeat(64), legacyCookie=`comex_session=${legacy}`;
  store.create('legacy-draft',legacy,{...createBlankComic('legacy-draft',legacy),title:'Legacy',plot:'A story',styleId:'ink-manga',characters:[],questions:[],answers:{}});
  expect((await run('comics/legacy-draft',undefined,legacyCookie)).status).toBe(200);
  const issued=await run('auth/request',{email:'legacy@example.test'},legacyCookie);
  const browser=cookie(issued,'comex_login');
  const verified=await run('auth/verify',{email:'legacy@example.test',code:codeOf(text)},`${legacyCookie}; ${browser}`);
  expect(verified.status).toBe(200);
  expect((await run('comics/legacy-draft',undefined,cookie(verified,'comex_auth'))).status).toBe(200);
  expect((await run('comics/legacy-draft',undefined,legacyCookie)).status).toBe(404);

  const internal='b'.repeat(64), db=(store as unknown as {db:import('node:sqlite').DatabaseSync}).db;
  db.prepare('INSERT INTO auth_users VALUES (?,?)').run('victim@example.test',internal);
  store.create('victim-draft',internal,{...createBlankComic('victim-draft',internal),title:'Victim',plot:'A story',styleId:'ink-manga',characters:[],questions:[],answers:{}});
  const forged=`comex_session=${internal}`;
  expect((await run('comics/victim-draft',undefined,forged)).status).toBe(404);
  const request=await run('auth/request',{email:'attacker@example.test'},forged);
  const loggedIn=await run('auth/verify',{email:'attacker@example.test',code:codeOf(text)},`${forged}; ${cookie(request,'comex_login')}`);
  expect(loggedIn.status).toBe(200);
  expect((await run('comics/victim-draft',undefined,cookie(loggedIn,'comex_auth'))).status).toBe(404);
  expect(store.getOwned('victim-draft',internal)).not.toBeNull();store.close();
 });
 test('start a browser draft, verify email and claim it; codes cannot replay',async()=>{
  const store=new LocalStore(':memory:');state.__comexLocalStore=store;configure();let message:{to:string[];text:string}|undefined;
  globalThis.fetch=(async(_url,init)=>{message=JSON.parse(String(init?.body));return new Response('{}',{status:200});}) as typeof fetch;
  const made=await run('comics',{title:'Draft',plot:'A story',style:'ink-manga',email:'Creator@Example.test'});expect(made.status).toBe(201);
  const id=(await made.json()).comic.id,guest=cookie(made,'comex_session');
  expect((await run(`comics/${id}`,undefined,guest)).status).toBe(200);
  expect((await run(`comics/${id}`)).status).toBe(404);
  expect((await run('comics',{title:'Draft',plot:'A story',style:'ink-manga',email:'Creator@Example.test'})).status).toBe(201);
  const issued=await run('auth/request',{email:'Creator@Example.test'},guest);expect(issued.status).toBe(200);expect(message?.to).toEqual(['Creator@example.test']);
  const browser=cookie(issued,'comex_login'),code=codeOf(message!.text),db=(store as unknown as {db:import('node:sqlite').DatabaseSync}).db;
  expect(JSON.stringify(db.prepare('SELECT * FROM auth_codes').get())).not.toContain(code);
  expect((await run('auth/verify',{email:'Creator@example.test',code:code==='12345678'?'87654321':'12345678'},`${guest}; ${browser}`)).status).toBe(400);
  const verified=await run('auth/verify',{email:'Creator@example.test',code},`${guest}; ${browser}`);expect(verified.status).toBe(200);
  const session=cookie(verified,'comex_auth');expect((await (await run('auth/session',undefined,session)).json()).user.email).toBe('Creator@example.test');
  expect((await run(`comics/${id}`,undefined,session)).status).toBe(200);
  expect((await run(`comics/${id}`,undefined,guest)).status).toBe(404);
  expect((await run('auth/verify',{email:'Creator@example.test',code},`${guest}; ${browser}`)).status).toBe(400);
  expect((await run('auth/sign-out',{},session)).status).toBe(200);expect((await run(`comics/${id}`,undefined,session)).status).toBe(404);
  store.close();
 });
 test('cross-browser sign-in never claims another browser draft',async()=>{
  const store=new LocalStore(':memory:');state.__comexLocalStore=store;configure();let message='';globalThis.fetch=(async(_u,init)=>{message=JSON.parse(String(init?.body)).text;return new Response('{}',{status:200});}) as typeof fetch;
  const made=await run('comics',{title:'Draft',plot:'A story',style:'ink-manga',email:'a@example.test'});const id=(await made.json()).comic.id,guest=cookie(made,'comex_session');
  await run('auth/request',{email:'a@example.test'},guest);const code=codeOf(message);
  const verified=await run('auth/verify',{email:'a@example.test',code});expect(verified.status).toBe(200);const session=cookie(verified,'comex_auth');
  expect((await run(`comics/${id}`,undefined,session)).status).toBe(404);expect((await run(`comics/${id}`,undefined,guest)).status).toBe(200);store.close();
 });
 test('code expiry, brute-force rate limiting and no recovery from hashed database contents',()=>{
  const store=new LocalStore(':memory:'),secret='a'.repeat(40),browser='b'.repeat(64),email='a@example.test',now=1000000;
  expect(store.issueCode(email,'12345678',browser,secret,now)).toBeTruthy();
  const db=(store as unknown as {db:import('node:sqlite').DatabaseSync}).db;
  expect(JSON.stringify(db.prepare('SELECT * FROM auth_codes').get())).not.toContain('12345678');
  expect(store.consumeCode(email,'12345678',secret,browser,null,now+15*60*1000)).toBeNull();
  expect(store.issueCode(email,'12345678',browser,secret,now+1)).toBeTruthy();
  for(let i=0;i<10;i++) expect(store.consumeCode(email,'00000000',secret,browser,null,now+1)).toBeNull();
  expect(store.consumeCode(email,'12345678',secret,browser,null,now+1)).toBeNull();store.close();
 });
 test('guesses before issuance do not pre-lock an address, while resends do not reset failed attempts',()=>{
  const store=new LocalStore(':memory:'),secret='a'.repeat(40),browser='b'.repeat(64),now=1000000;
  const email='victim@example.test';
  for(let i=0;i<20;i++) expect(store.consumeCode(email,'00000000',secret,browser,null,now)).toBeNull();
  expect(store.issueCode(email,'12345678',browser,secret,now+1)).toBeTruthy();
  expect(store.consumeCode(email,'12345678',secret,browser,null,now+1)).not.toBeNull();
  const other='other@example.test';expect(store.issueCode(other,'12345678',browser,secret,now+1)).toBeTruthy();
  for(let i=0;i<10;i++) expect(store.consumeCode(other,'00000000',secret,browser,null,now+1)).toBeNull();
  expect(store.issueCode(other,'87654321',browser,secret,now+2)).toBeTruthy();
  expect(store.consumeCode(other,'87654321',secret,browser,null,now+2)).toBeNull();store.close();
 });
 test('guest sessions expire on the server without deleting draft data',()=>{
  const store=new LocalStore(':memory:'),now=1000000,guest=store.createGuest('a@example.test',now);
  store.create('draft',guest.owner,{...createBlankComic('draft',guest.owner)});
  expect(store.guestIdentity(guest.token,now+30*24*60*60*1000-1)?.owner).toBe(guest.owner);
  expect(store.guestIdentity(guest.token,now+30*24*60*60*1000)).toBeNull();
  expect(store.hasGuestToken(guest.token)).toBe(true);expect(store.getOwned('draft',guest.owner)).not.toBeNull();store.close();
 });
 test('old guest rows migrate once to a bounded server lifetime',async()=>{
  const {DatabaseSync}=await import('node:sqlite'),{createHash}=await import('node:crypto');
  const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
  const dir=await mkdtemp(join(tmpdir(),'comex-guest-migration-')),path=join(dir,'store.sqlite'),token='c'.repeat(64);
  try {
   const old=new DatabaseSync(path);old.exec('CREATE TABLE auth_guests(token_hash TEXT PRIMARY KEY, owner TEXT NOT NULL UNIQUE, email TEXT NOT NULL); CREATE TABLE auth_requests(email_hash TEXT NOT NULL, requested_at INTEGER NOT NULL)');
   old.prepare('INSERT INTO auth_guests VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'),'owner','a@example.test');old.close();
   const now=Date.now(),store=new LocalStore(path);expect(store.guestIdentity(token,now)?.owner).toBe('owner');
   const db=(store as unknown as {db:import('node:sqlite').DatabaseSync}).db;
   const expiry=(db.prepare('SELECT expires_at FROM auth_guests').get() as {expires_at:number}).expires_at;
   expect(expiry).toBeGreaterThanOrEqual(now+30*24*60*60*1000);store.close();
   const reopened=new LocalStore(path);expect(reopened.guestIdentity(token,expiry)).toBeNull();reopened.close();
  } finally {await rm(dir,{recursive:true,force:true});}
 });
 test('out-of-order email responses preserve same-browser draft claim',async()=>{
  const store=new LocalStore(':memory:');state.__comexLocalStore=store;configure();
  let release!:()=>void,started!:()=>void;const wait=new Promise<void>(resolve=>release=resolve),began=new Promise<void>(resolve=>started=resolve);const messages:string[]=[];
  globalThis.fetch=(async(_u,init)=>{messages.push(JSON.parse(String(init?.body)).text);if(messages.length===1){started();await wait;}return new Response('{}',{status:200});}) as typeof fetch;
  const made=await run('comics',{title:'Draft',plot:'A story',style:'ink-manga',email:'a@example.test'});const id=(await made.json()).comic.id,guest=cookie(made,'comex_session');
  const first=run('auth/request',{email:'a@example.test'},guest);await began;
  const second=await run('auth/request',{email:'a@example.test'},guest);expect(second.status).toBe(200);const code=codeOf(messages[1]);
  release();const delayed=await first;expect(delayed.status).toBe(200);const overwrittenBrowser=cookie(delayed,'comex_login');
  const verified=await run('auth/verify',{email:'a@example.test',code},`${guest}; ${overwrittenBrowser}`);expect(verified.status).toBe(200);
  expect((await run(`comics/${id}`,undefined,cookie(verified,'comex_auth'))).status).toBe(200);store.close();
 });
 test('verification of a different email never claims or clears the guest draft',async()=>{
  const store=new LocalStore(':memory:');state.__comexLocalStore=store;configure();let text='';
  globalThis.fetch=(async(_u,init)=>{text=JSON.parse(String(init?.body)).text;return new Response('{}',{status:200});}) as typeof fetch;
  const made=await run('comics',{title:'Draft',plot:'A story',style:'ink-manga',email:'a@example.test'});const id=(await made.json()).comic.id,guest=cookie(made,'comex_session');
  const issued=await run('auth/request',{email:'b@example.test'},guest),browser=cookie(issued,'comex_login');
  const verified=await run('auth/verify',{email:'b@example.test',code:codeOf(text)},`${guest}; ${browser}`);expect(verified.status).toBe(200);
  expect(verified.headers.get('set-cookie')).not.toContain('comex_session=');
  expect((await run(`comics/${id}`,undefined,cookie(verified,'comex_auth'))).status).toBe(404);
  expect((await run(`comics/${id}`,undefined,guest)).status).toBe(200);store.close();
 });
 test('the guest owner can explicitly correct an email and claim after verification',async()=>{
  const store=new LocalStore(':memory:');state.__comexLocalStore=store;configure();let text='';
  globalThis.fetch=(async(_u,init)=>{text=JSON.parse(String(init?.body)).text;return new Response('{}',{status:200});}) as typeof fetch;
  const made=await run('comics',{title:'Draft',plot:'A story',style:'ink-manga',email:'typo@example.test'});const id=(await made.json()).comic.id,guest=cookie(made,'comex_session');
  const issued=await run('auth/request',{email:'correct@example.test',claimGuest:true},guest),browser=cookie(issued,'comex_login');
  expect(store.guestIdentity(guest.split('=')[1])?.email).toBe('correct@example.test');
  const verified=await run('auth/verify',{email:'correct@example.test',code:codeOf(text)},`${guest}; ${browser}`);expect(verified.status).toBe(200);
  expect((await run(`comics/${id}`,undefined,cookie(verified,'comex_auth'))).status).toBe(200);store.close();
 });
 test('definite email rejections allow address recovery but ambiguous failures keep quota',async()=>{
  const store=new LocalStore(':memory:');state.__comexLocalStore=store;configure();
  globalThis.fetch=(async()=>new Response('{}',{status:422})) as unknown as typeof fetch;
  for(let i=0;i<6;i++) expect((await run('auth/request',{email:'a@example.test'})).status).toBe(502);
  globalThis.fetch=(async()=>new Response('{}',{status:200})) as unknown as typeof fetch;
  expect((await run('auth/request',{email:'a@example.test'})).status).toBe(200);
  globalThis.fetch=(async()=>new Response('{}',{status:502})) as unknown as typeof fetch;
  for(let i=0;i<5;i++) expect((await run('auth/request',{email:'b@example.test'})).status).toBe(502);
  globalThis.fetch=(async()=>new Response('{}',{status:200})) as unknown as typeof fetch;
  expect((await run('auth/request',{email:'b@example.test'})).status).toBe(429);
  const db=(store as unknown as {db:import('node:sqlite').DatabaseSync}).db;
  expect((db.prepare('SELECT COUNT(*) AS count FROM auth_requests').get() as {count:number}).count).toBe(12);store.close();
 });
 test('same-browser claim waits for active work without consuming the code',async()=>{
  const store=new LocalStore(':memory:');state.__comexLocalStore=store;configure();let text='';globalThis.fetch=(async(_u,init)=>{text=JSON.parse(String(init?.body)).text;return new Response('{}',{status:200});}) as typeof fetch;
  const made=await run('comics',{title:'Draft',plot:'A story',style:'ink-manga',email:'a@example.test'});const id=(await made.json()).comic.id,guest=cookie(made,'comex_session');
  const guestOwner=store.guestIdentity(guest.split('=')[1])!.owner;expect(store.reserveTextOperation(id,guestOwner,1)).toBe(true);
  const issued=await run('auth/request',{email:'a@example.test'},guest),browser=cookie(issued,'comex_login'),code=codeOf(text);
  expect((await run('auth/verify',{email:'a@example.test',code},`${guest}; ${browser}`)).status).toBe(409);
  store.finishTextOperation(id,guestOwner,false);
  expect((await run('auth/verify',{email:'a@example.test',code},`${guest}; ${browser}`)).status).toBe(200);store.close();
 });
 test('claim preserves published edition freshness and unresolved text operations',()=>{
  const store=new LocalStore(':memory:'),secret='s'.repeat(40),browser='a'.repeat(64),guest=store.createGuest('a@example.test');
  for(const id of ['fresh','stale']) {
   const draft={...createBlankComic(id,guest.owner),characters:[],answers:{},questions:[],title:id,plot:'Plot',styleId:'ink-manga'};
   store.create(id,guest.owner,draft);expect(store.publish(id,guest.owner,1,{id,title:id,creator:'A',editionId:'ed',sourceRevision:2,pages:[]})).toBe(true);
   if(id==='stale')expect(store.update(id,guest.owner,2,{...draft,title:'changed'})).toBe(true);
  }
  expect(store.reserveTextOperation('fresh',guest.owner,2)).toBe(true);store.finishTextOperation('fresh',guest.owner,true);
  store.issueCode('a@example.test','12345678',browser,secret);
  const session=store.consumeCode('a@example.test','12345678',secret,browser,guest.owner)!.session;
  const owner=store.authIdentity(session)!.owner, fresh=store.getOwned('fresh',owner)!, stale=store.getOwned('stale',owner)!;
  expect(store.getPublished<{sourceRevision:number}>('fresh')!.sourceRevision).toBe(fresh.revision);
  expect(store.getPublished<{sourceRevision:number}>('stale')!.sourceRevision).not.toBe(stale.revision);
  const db=(store as unknown as {db:import('node:sqlite').DatabaseSync}).db;
  expect(db.prepare('SELECT owner,state FROM comic_text_operations WHERE comic_id=?').get('fresh')).toMatchObject({owner,state:'unknown'});
  expect(store.guestIdentity(guest.token)).toBeNull();store.close();
 });
 test('rejects cross origin and missing secrets, preserves email local-part case',async()=>{
  const store=new LocalStore(':memory:');state.__comexLocalStore=store;configure();let text='';globalThis.fetch=(async(_u,init)=>{text=JSON.parse(String(init?.body)).text;return new Response('{}',{status:200});}) as typeof fetch;
  expect((await run('auth/request',{email:'a@example.test'},'','https://evil.example')).status).toBe(403);
  delete process.env.COMEX_AUTH_SECRET;expect((await run('auth/request',{email:'a@example.test'})).status).toBe(503);configure();
  await run('auth/request',{email:'Alice@example.test'});const one=codeOf(text),a=await run('auth/verify',{email:'Alice@example.test',code:one});
  await run('auth/request',{email:'alice@example.test'});const two=codeOf(text),b=await run('auth/verify',{email:'alice@example.test',code:two});
  expect(store.authIdentity(cookie(a,'comex_auth').split('=')[1])!.owner).not.toBe(store.authIdentity(cookie(b,'comex_auth').split('=')[1])!.owner);store.close();
 });
});
