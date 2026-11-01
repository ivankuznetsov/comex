import {afterEach, describe, expect, test} from 'bun:test';
import {NextRequest} from 'next/server';
import {LocalStore} from '../src/lib/local-store';
import {handleApi} from '../src/lib/local-api';
import {createBlankComic} from '../src/lib/domain/comic';

const oldFetch = globalThis.fetch;
const state = globalThis as typeof globalThis & {__comexLocalStore?:LocalStore};
const oldStore = state.__comexLocalStore;
const originalEnv = {...process.env};
afterEach(() => {globalThis.fetch=oldFetch; state.__comexLocalStore=oldStore; process.env.COMEX_APP_URL=originalEnv.COMEX_APP_URL; process.env.RESEND_API_KEY=originalEnv.RESEND_API_KEY; process.env.COMEX_EMAIL_FROM=originalEnv.COMEX_EMAIL_FROM;});

const request = (path:string, body?:unknown, cookies='', origin='http://localhost:3000') => new NextRequest(`http://localhost:3000/api/${path}`, {method:body === undefined ? 'GET' : 'POST', headers:{host:'localhost:3000', ...(body === undefined ? {} : {'content-type':'application/json',origin}), ...(cookies ? {cookie:cookies} : {})}, ...(body === undefined ? {} : {body:JSON.stringify(body)})});
const run = (path:string, body?:unknown, cookies='', origin?:string) => handleApi(request(path,body,cookies,origin),path.split('/'));
const cookie = (response:Response,name:string) => {const match=response.headers.get('set-cookie')?.match(new RegExp(`(?:^|,\\s*)${name}=([^;,]+)`)); if (!match) throw new Error(`missing ${name}`); return `${name}=${match[1]}`;};

describe('magic link authentication', () => {
  test('email delivery, verified identity, draft claiming, revocation and replay prevention', async () => {
    const store=new LocalStore(':memory:'); state.__comexLocalStore=store;
    process.env.COMEX_APP_URL='http://localhost:3000'; process.env.RESEND_API_KEY='test'; process.env.COMEX_EMAIL_FROM='Comex <comex@example.test>';
    let message: {to:string[];text:string} | undefined;
    globalThis.fetch = (async (_url,init) => {message=JSON.parse(String(init?.body)); return new Response('{}',{status:200});}) as typeof fetch;
    const anonOwner='c'.repeat(64), comic={id:'legacy-draft'}, anonymous=`comex_session=${anonOwner}`;
    store.create(comic.id,anonOwner,{...createBlankComic(comic.id,anonOwner),title:'Draft',plot:'A plot',styleId:'ink-manga',characters:[],answers:{},questions:[]});
    for (const id of ['fresh','stale']) {
      const draft={...createBlankComic(id,anonOwner),title:id,plot:'A plot',styleId:'ink-manga',characters:[],answers:{},questions:[]};
      store.create(id,anonOwner,draft);
      expect(store.publish(id,anonOwner,1,{id,title:id,creator:'A',editionId:'ed',sourceRevision:2,pages:[]})).toBe(true);
      if (id === 'stale') expect(store.update(id,anonOwner,2,{...draft,title:'changed'})).toBe(true);
    }
    expect(store.reserveTextOperation(comic.id,anonOwner,1)).toBe(true);
    store.finishTextOperation(comic.id,anonOwner,true);
    expect((await run('comics',{title:'New',plot:'Plot',style:'ink-manga'})).status).toBe(401);
    expect((await run(`comics/${comic.id}`,undefined,anonymous)).status).toBe(404);
    const issued=await run('auth/request',{email:'Creator@Example.test'},anonymous); expect(issued.status).toBe(200); expect(message?.to).toEqual(['Creator@example.test']);
    const link=message!.text.match(/http:\/\/localhost:3000\/sign-in\/verify#([a-f0-9]{64})/)![1]; const browser=cookie(issued,'comex_login');
    const inspected=await run('auth/inspect',{token:link}); expect((await inspected.json()).email).toBe('Creator@example.test');
    const inspectedAgain=await run('auth/inspect',{token:link}); expect(inspectedAgain.status).toBe(200);
    const verified=await run('auth/verify',{token:link},`${anonymous}; ${browser}`); expect(verified.status).toBe(200); const session=cookie(verified,'comex_auth');
    expect((await (await run('auth/session',undefined,session)).json()).user.email).toBe('Creator@example.test');
    expect((await run('comics',{title:'New comic',plot:'A story',style:'ink-manga'},session)).status).toBe(201);
    expect((await run('published')).status).toBe(200);
    expect((await run(`comics/${comic.id}`,undefined,session)).status).toBe(200);
    const owner = store.authIdentity(session.split('=')[1])!.owner;
    const db=(store as unknown as {db:import('node:sqlite').DatabaseSync}).db;
    expect(db.prepare('SELECT owner,state FROM comic_text_operations WHERE comic_id=?').get(comic.id)).toMatchObject({owner,state:'unknown'});
    expect((await (await run('comics/fresh',undefined,session)).json()).comic.unpublishedChanges).toBe(false);
    expect((await (await run('comics/stale',undefined,session)).json()).comic.unpublishedChanges).toBe(true);
    expect((await run(`comics/${comic.id}`,undefined,anonymous)).status).toBe(404);
    expect((await run('auth/verify',{token:link},`${anonymous}; ${browser}`)).status).toBe(400);
    expect((await run('auth/sign-out',{},session)).status).toBe(200);
    expect((await (await run('auth/session',undefined,session)).json()).user).toBeNull();
    expect((await run(`comics/${comic.id}`,undefined,session)).status).toBe(404);
    const secondIssue=await run('auth/request',{email:'Creator@example.test'}); const secondToken=message!.text.match(/#([a-f0-9]{64})/)![1];
    const otherOwner='d'.repeat(64), otherComic={id:'other-draft'};
    store.create(otherComic.id,otherOwner,{...createBlankComic(otherComic.id,otherOwner),title:'Other',plot:'A plot',styleId:'ink-manga',characters:[],answers:{},questions:[]});
    const secondVerify=await run('auth/verify',{token:secondToken},`comex_session=${otherOwner}`);
    const secondSession=cookie(secondVerify,'comex_auth'); expect((await run(`comics/${comic.id}`,undefined,secondSession)).status).toBe(200);
    expect(secondVerify.headers.get('set-cookie')).not.toContain('comex_session=');
    expect((await run(`comics/${otherComic.id}`,undefined,secondSession)).status).toBe(404);
    expect(store.getOwned(otherComic.id,otherOwner)).not.toBeNull();
    store.close();
  });
  test('rejects cross-origin authentication and unconfigured delivery',async () => {
    const store=new LocalStore(':memory:'); state.__comexLocalStore=store;
    expect((await run('auth/request',{email:'a@example.test'},'', 'https://evil.example')).status).toBe(403);
    delete process.env.RESEND_API_KEY;
    expect((await run('auth/request',{email:'a@example.test'})).status).toBe(503);
    const ipRequest = new NextRequest('http://localhost:3000/api/auth/request',{method:'POST',headers:{host:'127.0.0.1:3000',origin:'http://127.0.0.1:3000','content-type':'application/json'},body:JSON.stringify({email:'a@example.test'})});
    expect((await handleApi(ipRequest,['auth','request'])).status).toBe(503);
    store.close();
  });
  test('multiple and rate-limited requests preserve proof for an earlier link', async () => {
    const store=new LocalStore(':memory:'); state.__comexLocalStore=store;
    process.env.COMEX_APP_URL='http://localhost:3000'; process.env.RESEND_API_KEY='test'; process.env.COMEX_EMAIL_FROM='Comex <comex@example.test>';
    const messages:{text:string}[]=[];
    globalThis.fetch=(async (_url,init) => {messages.push(JSON.parse(String(init?.body))); return new Response('{}',{status:200});}) as typeof fetch;
    const anonymousOwner='e'.repeat(64), anonymous=`comex_session=${anonymousOwner}`;
    store.create('legacy',anonymousOwner,{...createBlankComic('legacy',anonymousOwner),title:'Legacy',plot:'A story',styleId:'ink-manga',characters:[],answers:{},questions:[]});
    const first=await run('auth/request',{email:'creator@example.test'},anonymous); const browser=cookie(first,'comex_login');
    const firstToken=messages[0].text.match(/#([a-f0-9]{64})/)![1];
    for (let i=0;i<4;i++) {const later=await run('auth/request',{email:'creator@example.test'},`${anonymous}; ${browser}`); expect(cookie(later,'comex_login')).toBe(browser);}
    const limited=await run('auth/request',{email:'creator@example.test'},`${anonymous}; ${browser}`);
    expect(limited.status).toBe(429); expect(limited.headers.get('set-cookie')).toBeNull(); expect(messages).toHaveLength(5);
    const verified=await run('auth/verify',{token:firstToken},`${anonymous}; ${browser}`); expect(verified.status).toBe(200);
    expect((await run('comics/legacy',undefined,cookie(verified,'comex_auth'))).status).toBe(200);
    store.close();
  });
  test('expiration, rate limits and hashed tokens', () => {
    const store=new LocalStore(':memory:'); const email='a@example.test', browser='a'.repeat(64), token='b'.repeat(64), now=1000000;
    expect(store.issueLink(email,token,browser,now)).toBe(true);
    const db=(store as unknown as {db:import('node:sqlite').DatabaseSync}).db;
    expect(db.prepare('SELECT token_hash,browser_hash FROM auth_links').get()).not.toEqual({token_hash:token,browser_hash:browser});
    expect(store.consumeLink(token,browser,null,now+15*60*1000)).toBeNull();
    for (let i=0;i<4;i++) expect(store.issueLink(email,String(i).repeat(64),browser,now+1)).toBe(true);
    expect(store.issueLink(email,'f'.repeat(64),browser,now+1)).toBe(false);
    store.close();
  });
  test('email local-part case does not merge distinct identities', () => {
    const store=new LocalStore(':memory:'); const browser='a'.repeat(64);
    store.issueLink('Alice@example.test','b'.repeat(64),browser);
    store.issueLink('alice@example.test','c'.repeat(64),browser);
    const a=store.consumeLink('b'.repeat(64),browser,null)!;
    const b=store.consumeLink('c'.repeat(64),browser,null)!;
    expect(store.authIdentity(a.session)!.owner).not.toBe(store.authIdentity(b.session)!.owner);
    store.close();
  });
  test('global rate limit reports failure without sending mail or replacing the claim cookie', async () => {
    const store=new LocalStore(':memory:'); state.__comexLocalStore=store;
    process.env.COMEX_APP_URL='http://localhost:3000'; process.env.RESEND_API_KEY='test'; process.env.COMEX_EMAIL_FROM='Comex <comex@example.test>';
    let sent=0; globalThis.fetch=(async () => {sent++; return new Response('{}',{status:200});}) as unknown as typeof fetch;
    for (let i=0;i<50;i++) expect(store.issueLink(`user${i}@example.test`,i.toString(16).padStart(64,'0'),'a'.repeat(64))).toBe(true);
    const result=await run('auth/request',{email:'new@example.test'},`comex_login=${'f'.repeat(64)}`);
    expect(result.status).toBe(429); expect(result.headers.get('set-cookie')).toBeNull(); expect(sent).toBe(0);
    store.close();
  });
  test('claim waits for active work without consuming the link', async () => {
    const store=new LocalStore(':memory:'); state.__comexLocalStore=store;
    const anonymousOwner='e'.repeat(64), browser='a'.repeat(64), token='b'.repeat(64);
    store.create('legacy',anonymousOwner,{...createBlankComic('legacy',anonymousOwner),characters:[],answers:{},questions:[]});
    expect(store.reserveTextOperation('legacy',anonymousOwner,1)).toBe(true);
    expect(store.issueLink('creator@example.test',token,browser)).toBe(true);
    const cookies=`comex_session=${anonymousOwner}; comex_login=${browser}`;
    const busy=await run('auth/verify',{token},cookies); expect(busy.status).toBe(409);
    expect((await run('auth/inspect',{token})).status).toBe(200);
    store.finishTextOperation('legacy',anonymousOwner,false);
    const verified=await run('auth/verify',{token},cookies); expect(verified.status).toBe(200);
    expect((await run('comics/legacy',undefined,cookie(verified,'comex_auth'))).status).toBe(200);
    store.close();
  });
});
