import {expect,test} from '@playwright/test';
import {createHash,randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {LocalStore} from '../src/lib/local-store';
import {createBlankComic} from '../src/lib/domain/comic';

const base=process.env.COMEX_TEST_URL!,path=process.env.COMEX_DB_PATH!,resource=base+'/mcp';
test('a fresh browser consents to a new empty workspace without another browser’s draft',async({browser,request})=>{
  test.setTimeout(180000);
  const store=new LocalStore(path),database=new DatabaseSync(path);
  const other=store.createGuest('other-browser@example.test'),draftId='other-draft-'+randomBytes(8).toString('hex');
  store.create(draftId,other.owner,{...createBlankComic(draftId,other.owner),title:'Other browser draft',plot:'A courier',styleId:'ink-manga',characters:[],questions:[],answers:{}});
  const fresh=await browser.newContext(),existing=await browser.newContext();
  try {
    await existing.addCookies([{name:'comex_session',value:other.token,url:base,httpOnly:true,sameSite:'Strict'}]);
    const page=await fresh.newPage();
    await page.route('http://127.0.0.1:64321/callback**',route=>route.fulfill({status:200,body:'Connected'}));
    const registration=await request.post(base+'/api/mcp-auth/oauth2/register',{data:{application_type:'native',client_name:'Fresh browser client',redirect_uris:['http://127.0.0.1:64321/callback'],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']}});
    expect(registration.status()).toBe(201);const client=(await registration.json()).client_id;
    const verifier=randomBytes(32).toString('base64url'),challenge=createHash('sha256').update(verifier).digest('base64url');
    const params=new URLSearchParams({client_id:client,redirect_uri:'http://127.0.0.1:64321/callback',response_type:'code',code_challenge:challenge,code_challenge_method:'S256',scope:'comex:read offline_access',resource});
    await page.goto(base+'/api/mcp-auth/oauth2/authorize?'+params);
    await expect(page.getByRole('heading',{name:'Connect Fresh browser client'})).toBeVisible({timeout:45000});
    await expect(page.getByText(/new, empty workspace; existing drafts in another browser will not be included/)).toBeVisible({timeout:45000});
    await page.getByLabel('Your email address').fill('fresh-browser@example.test');
    await page.getByRole('button',{name:'Allow connection'}).click();
    await page.waitForURL('http://127.0.0.1:64321/callback**');
    const code=new URL(page.url()).searchParams.get('code');expect(code).toBeTruthy();
    const token=await request.post(base+'/api/mcp-auth/oauth2/token',{form:{grant_type:'authorization_code',client_id:client,code:code!,redirect_uri:'http://127.0.0.1:64321/callback',code_verifier:verifier,resource}});
    expect(token.status()).toBe(200);expect((await token.json()).access_token).toBeTruthy();
    const guestCookie=(await fresh.cookies(base)).find(cookie=>cookie.name==='comex_session');expect(guestCookie).toBeTruthy();
    const freshOwner=store.guestIdentity(guestCookie!.value)?.owner;expect(freshOwner).toBeTruthy();expect(freshOwner).not.toBe(other.owner);
    const grant=database.prepare('SELECT owner FROM mcp_grants WHERE client_id=?').get(client) as {owner:string};expect(grant.owner).toBe(freshOwner);
    const list=await fresh.request.get(base+'/api/comics');expect(list.status()).toBe(200);expect((await list.json()).comics).toEqual([]);
    expect((await fresh.request.get(base+'/api/comics/'+draftId)).status()).toBe(404);
    expect((await existing.request.get(base+'/api/comics/'+draftId)).status()).toBe(200);
    expect(store.getOwned(draftId,other.owner)?.data).toMatchObject({title:'Other browser draft'});
  } finally {database.close();store.close();await fresh.close();await existing.close();}
});
test('browser consent, owner binding and one-connection revocation',async({browser,request})=>{
  test.setTimeout(90000);
  const store=new LocalStore(path),guest=store.createGuest('browser@example.test');
  store.create('browser-auth-fixture-'+randomBytes(8).toString('hex'),guest.owner,{ownerId:guest.owner,title:'Existing draft'});
  const context=await browser.newContext(),page=await context.newPage();
  await context.addCookies([{name:'comex_session',value:guest.token,url:base,httpOnly:true,sameSite:'Strict'}]);
  await page.route('http://127.0.0.1:64321/callback**',route=>route.fulfill({status:200,body:'Connected'}));
  async function connect(name:string) {
    const registered=await request.post(base+'/api/mcp-auth/oauth2/register',{data:{application_type:'native',client_name:name,redirect_uris:['http://127.0.0.1:64321/callback'],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']}});
    expect(registered.status()).toBe(201);const client=(await registered.json()).client_id;
    const verifier=randomBytes(32).toString('base64url'),challenge=createHash('sha256').update(verifier).digest('base64url');
    const params=new URLSearchParams({client_id:client,redirect_uri:'http://127.0.0.1:64321/callback',response_type:'code',code_challenge:challenge,code_challenge_method:'S256',scope:'comex:read offline_access',resource});
    // Cross-site entry suppresses Strict guest cookies during navigation; the
    // consent page must recover the workspace through its same-origin request.
    await page.goto(base.replace('127.0.0.1','localhost')+'/');
    await page.goto(base+'/api/mcp-auth/oauth2/authorize?'+params);
    await expect(page.getByRole('heading',{name:`Connect ${name}`})).toBeVisible();
    await expect(page.getByText('This browser has no workspace yet.')).toHaveCount(0);
    await page.getByRole('button',{name:'Allow connection'}).click();
    await page.waitForURL('http://127.0.0.1:64321/callback**');
    const code=new URL(page.url()).searchParams.get('code')!;
    const token=await request.post(base+'/api/mcp-auth/oauth2/token',{form:{grant_type:'authorization_code',client_id:client,code,redirect_uri:'http://127.0.0.1:64321/callback',code_verifier:verifier,resource}});
    expect(token.status()).toBe(200);return {client,tokens:await token.json()};
  }
  const first=await connect('First client'),second=await connect('Second client');
  const database=new DatabaseSync(path);const owners=database.prepare('SELECT owner FROM mcp_grants WHERE client_id IN (?,?)').all(first.client,second.client) as {owner:string}[];
  expect(owners).toHaveLength(2);expect(owners.every(row=>row.owner===guest.owner)).toBe(true);
  await page.setViewportSize({width:375,height:812});
  await page.goto(base+'/connections');
  await expect(page).toHaveURL(base+'/#connect-agent');
  await expect(page.getByRole('button',{name:'Copy prompt'})).toBeVisible();
  // Revocation remains an auth capability, not a user-facing management screen.
  const connections=await page.request.get(base+'/api/mcp-auth/comex/connections');
  const firstGrant=(await connections.json()).connections.find((item:{name:string})=>item.name==='First client');
  expect(firstGrant).toBeTruthy();
  const revoked=await page.request.post(base+'/api/mcp-auth/comex/connections',{headers:{origin:base},data:{id:firstGrant.id}});
  expect(revoked.ok()).toBe(true);
  const refresh=async(client:string,token:string)=>request.post(base+'/api/mcp-auth/oauth2/token',{form:{grant_type:'refresh_token',client_id:client,refresh_token:token,resource}});
  expect((await refresh(first.client,first.tokens.refresh_token)).ok()).toBe(false);expect((await refresh(second.client,second.tokens.refresh_token)).ok()).toBe(true);
  const browserSession=await page.request.get(base+'/api/auth/session');expect((await browserSession.json()).guest.email).toBe('browser@example.test');
  database.close();store.close();await context.close();
});
