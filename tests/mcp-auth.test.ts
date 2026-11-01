import {afterEach, describe, expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash, randomBytes} from 'node:crypto';
import {getMigrations} from 'better-auth/db/migration';
import {fetchClientMetadataResource} from '@better-auth/cimd/node';
import {validateClientIdUrl} from '@better-auth/cimd';
import {LocalStore} from '../src/lib/local-store';
import {createMcpAuth} from '../src/lib/auth/mcp';
import {mcpAllowedOrigins,withMcpCors} from '../src/lib/auth/cors';

const base='http://localhost:3127', resource=base+'/mcp', secret='test-only-secret-test-only-secret-test-only-secret';
const paths:string[]=[];
afterEach(()=>{for(const path of paths.splice(0))rmSync(path,{recursive:true,force:true});});

async function fixture(trustedOrigins:string[]=[]) {
  const dir=mkdtempSync(join(tmpdir(),'comex-oauth-'));paths.push(dir);
  const path=join(dir,'auth.sqlite'), store=new LocalStore(path), database=new DatabaseSync(path);
  const server=createMcpAuth({baseURL:base,resource,secret,database,identityStore:store,trustedOrigins});
  await (await getMigrations(server.options)).runMigrations();
  const call=(path:string, init:RequestInit={})=>server.auth.handler(new Request(base+'/api/mcp-auth'+path,init));
  const guest=store.createGuest('creator@example.test');
  store.create('draft',guest.owner,{ownerId:guest.owner,title:'Shared draft'});
  const cookie=`comex_session=${guest.token}`;
  async function register() {
    const res=await call('/oauth2/register',{method:'POST',headers:{'content-type':'application/json',origin:base},body:JSON.stringify({application_type:'native',client_name:'Test client',redirect_uris:['http://127.0.0.1:64321/callback'],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']})});
    expect(res.status).toBe(201);return (await res.json()).client_id as string;
  }
  async function authorize(client:string, scopes='comex:read comex:write offline_access') {
    const verifier=randomBytes(32).toString('base64url'),challenge=createHash('sha256').update(verifier).digest('base64url');
    const query=new URLSearchParams({client_id:client,redirect_uri:'http://127.0.0.1:64321/callback',response_type:'code',code_challenge:challenge,code_challenge_method:'S256',scope:scopes,resource,state:'expected-state'});
    const response=await call('/oauth2/authorize?'+query);
    expect(response.status).toBe(302);const location=new URL(response.headers.get('location')!,base);
    expect(location.pathname).toBe('/connect');
    return {verifier,query:location.search.slice(1)};
  }
  async function approve(query:string, browserCookie=cookie, origin=base) {
    return server.consent(new Request(base+'/api/mcp-auth/comex/consent',{method:'POST',headers:{'content-type':'application/json',origin,cookie:browserCookie},body:JSON.stringify({oauth_query:query,accept:true})}));
  }
  async function exchange(client:string,code:string,verifier:string,target=resource) {
    return call('/oauth2/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:client,code,redirect_uri:'http://127.0.0.1:64321/callback',code_verifier:verifier,resource:target})});
  }
  async function complete(client:string) {
    const auth=await authorize(client), approved=await approve(auth.query);expect(approved.status).toBe(200);
    const body=await approved.json(), url=new URL(body.redirect);expect(url.searchParams.get('state')).toBe('expected-state');
    const code=url.searchParams.get('code')!, token=await exchange(client,code,auth.verifier);expect(token.status).toBe(200);
    return {tokens:await token.json(),code,verifier:auth.verifier};
  }
  return {server,store,database,guest,cookie,call,register,authorize,approve,exchange,complete};
}

describe('browser-owned OAuth connections',()=>{
  test('allowed browser origins can discover, register and exchange a PKCE code while other origins are denied',async()=>{
    const clientOrigin='https://client.example',origins=mcpAllowedOrigins(base,clientOrigin),f=await fixture(origins);
    const send=(request:Request,methods:string[])=>withMcpCors(request,origins,methods,()=>f.server.auth.handler(request));
    try {
      const metadata=await send(new Request(base+'/.well-known/oauth-protected-resource/mcp',{headers:{origin:clientOrigin}}),['GET']);
      expect(metadata.status).toBe(200);expect(metadata.headers.get('access-control-allow-origin')).toBe(clientOrigin);
      const preflight=await send(new Request(base+'/api/mcp-auth/oauth2/register',{method:'OPTIONS',headers:{origin:clientOrigin,'access-control-request-method':'POST','access-control-request-headers':'content-type'}}),['POST']);
      expect(preflight.status).toBe(204);expect(preflight.headers.get('access-control-allow-methods')).toContain('POST');
      const registration=await send(new Request(base+'/api/mcp-auth/oauth2/register',{method:'POST',headers:{origin:clientOrigin,'content-type':'application/json'},body:JSON.stringify({application_type:'native',client_name:'Browser client',redirect_uris:['http://127.0.0.1:64321/callback'],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']})}),['POST']);
      expect(registration.status).toBe(201);expect(registration.headers.get('access-control-allow-origin')).toBe(clientOrigin);
      const client=(await registration.json()).client_id as string,pending=await f.authorize(client),approved=await f.approve(pending.query);
      const code=new URL((await approved.json()).redirect).searchParams.get('code')!;
      const token=await send(new Request(base+'/api/mcp-auth/oauth2/token',{method:'POST',headers:{origin:clientOrigin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:client,code,redirect_uri:'http://127.0.0.1:64321/callback',code_verifier:pending.verifier,resource})}),['POST']);
      expect(token.status).toBe(200);expect(token.headers.get('access-control-allow-origin')).toBe(clientOrigin);
      const denied=await send(new Request(base+'/.well-known/oauth-protected-resource/mcp',{headers:{origin:'https://untrusted.example'}}),['GET']);
      expect(denied.status).toBe(403);expect(denied.headers.get('access-control-allow-origin')).toBeNull();
      const challenge=await withMcpCors(new Request(resource,{headers:{origin:clientOrigin}}),origins,['POST'],async()=>new Response(null,{status:401,headers:{'WWW-Authenticate':'Bearer resource_metadata="https://comex.example/metadata"'}}));
      expect(challenge.headers.get('access-control-expose-headers')).toContain('WWW-Authenticate');
      const redirect=await withMcpCors(new Request(resource,{headers:{origin:clientOrigin}}),origins,['GET'],async()=>Response.redirect('https://client.example/callback'));
      expect(redirect.status).toBe(302);expect(redirect.headers.get('access-control-allow-origin')).toBe(clientOrigin);
    } finally {f.database.close();f.store.close();}
  });
  test('a fresh browser grant belongs to a new empty owner, not the existing browser',async()=>{
    const f=await fixture(),client=await f.register();
    try {
      const pending=await f.authorize(client);
      const response=await f.server.consent(new Request(base+'/api/mcp-auth/comex/consent',{method:'POST',headers:{'content-type':'application/json',origin:base},body:JSON.stringify({oauth_query:pending.query,accept:true,email:'fresh@example.test'})}));
      expect(response.status).toBe(200);
      const freshCookie=response.headers.getSetCookie().find(value=>value.startsWith('comex_session='));expect(freshCookie).toBeTruthy();
      const freshToken=freshCookie!.split(';')[0].split('=')[1],fresh=f.store.guestIdentity(freshToken);expect(fresh?.owner).toBeTruthy();expect(fresh!.owner).not.toBe(f.guest.owner);
      const code=new URL((await response.json()).redirect).searchParams.get('code')!,token=await f.exchange(client,code,pending.verifier);expect(token.status).toBe(200);
      const tokens=await token.json(),actor=await f.server.authenticate(new Request(resource,{headers:{authorization:`Bearer ${tokens.access_token}`}}),['comex:read']);
      expect(actor?.ownerId).toBe(fresh!.owner);expect(f.store.listOwned(fresh!.owner)).toEqual([]);expect(f.store.getOwned('draft',actor!.ownerId)).toBeNull();
      expect(f.store.getOwned('draft',f.guest.owner)?.data).toEqual({ownerId:f.guest.owner,title:'Shared draft'});
    } finally {f.database.close();f.store.close();}
  });
  test('PKCE, consent and signed bearer map to the existing browser owner and scope',async()=>{
    const f=await fixture(),client=await f.register(),{tokens,code,verifier}=await f.complete(client);
    const actor=await f.server.authenticate(new Request(resource,{headers:{authorization:`Bearer ${tokens.access_token}`}}),['comex:read']);
    expect(actor?.ownerId).toBe(f.guest.owner);
    expect(f.store.getOwned('draft',actor!.ownerId)?.data).toEqual({ownerId:f.guest.owner,title:'Shared draft'});
    expect(await f.server.authenticate(new Request(resource,{headers:{authorization:`Bearer ${tokens.access_token}`}}),['comex:publish'])).toBeNull();
    expect((await f.exchange(client,code,verifier)).ok).toBe(false);
    const pending=await f.authorize(client),consent=await f.approve(pending.query),code2=new URL((await consent.json()).redirect).searchParams.get('code')!;
    expect((await f.exchange(client,code2,randomBytes(32).toString('base64url'))).ok).toBe(false);
    f.database.close();f.store.close();
  });
  test('a DCR client omitting scope presents all registered capabilities for consent',async()=>{
    const f=await fixture(),client=await f.register(),verifier=randomBytes(32).toString('base64url');
    const query=new URLSearchParams({client_id:client,redirect_uri:'http://127.0.0.1:64321/callback',response_type:'code',code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',resource});
    const authorization=await f.call('/oauth2/authorize?'+query);expect(authorization.status).toBe(302);
    const signed=new URL(authorization.headers.get('location')!,base).search.slice(1),details=await f.server.describeConsent(signed);
    expect(details?.scopes).toEqual(['comex:read','comex:write','comex:generate','comex:publish','offline_access']);
    const consent=await f.approve(signed);expect(consent.status).toBe(200);const code=new URL((await consent.json()).redirect).searchParams.get('code')!;
    const token=await f.exchange(client,code,verifier);expect(token.status).toBe(200);const result=await token.json();expect(result.refresh_token).toBeTruthy();
    expect(await f.server.authenticate(new Request(resource,{headers:{authorization:`Bearer ${result.access_token}`}}),['comex:read','comex:write','comex:generate','comex:publish'])).not.toBeNull();
    f.database.close();f.store.close();
  });
  test('rejects forged consent, cross-origin approval and wrong resource',async()=>{
    const f=await fixture(),client=await f.register(),pending=await f.authorize(client);
    expect((await f.approve(pending.query+'&scope=comex:publish')).ok).toBe(false);
    expect((await f.approve(pending.query,f.cookie,'https://attacker.example')).ok).toBe(false);
    const approved=await f.approve(pending.query);const code=new URL((await approved.json()).redirect).searchParams.get('code')!;
    expect((await f.exchange(client,code,pending.verifier,'https://wrong.example/mcp')).ok).toBe(false);
    f.database.close();f.store.close();
  });
  test('unregistered or changed redirect URIs cannot create a grant or mutate drafts',async()=>{
    const f=await fixture(),client=await f.register();
    try {
      const clientsBefore=(f.database.prepare('SELECT count(*) AS count FROM "oauthClient"').get() as {count:number}).count;
      const badRegistration=await f.call('/oauth2/register',{method:'POST',headers:{'content-type':'application/json',origin:base},body:JSON.stringify({application_type:'native',client_name:'Unsafe client',redirect_uris:['javascript:alert(1)'],token_endpoint_auth_method:'none',grant_types:['authorization_code'],response_types:['code']})});
      expect(badRegistration.ok).toBe(false);
      expect((f.database.prepare('SELECT count(*) AS count FROM "oauthClient"').get() as {count:number}).count).toBe(clientsBefore);
      const verifier=randomBytes(32).toString('base64url');
      const substituted='http://127.0.0.1:64321/changed';
      const query=new URLSearchParams({client_id:client,redirect_uri:substituted,response_type:'code',code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',scope:'comex:read',resource});
      const authorization=await f.call('/oauth2/authorize?'+query);
      expect(authorization.ok).toBe(false);
      const location=authorization.headers.get('location');
      if(location) expect(new URL(location,base).href.startsWith(substituted)).toBe(false);
      const pending=await f.authorize(client);
      const changed=new URLSearchParams(pending.query);changed.set('redirect_uri',substituted);
      expect((await f.approve(changed.toString())).status).toBe(400);
      expect((f.database.prepare('SELECT count(*) AS count FROM mcp_grants').get() as {count:number}).count).toBe(0);
      expect((f.database.prepare('SELECT count(*) AS count FROM "session"').get() as {count:number}).count).toBe(0);
      expect(f.store.getOwned('draft',f.guest.owner)?.data).toEqual({ownerId:f.guest.owner,title:'Shared draft'});
      const approved=await f.approve(pending.query);expect(approved.status).toBe(200);
      const code=new URL((await approved.json()).redirect).searchParams.get('code')!;
      const exchange=await f.call('/oauth2/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:client,code,redirect_uri:substituted,code_verifier:pending.verifier,resource})});
      expect(exchange.ok).toBe(false);expect((await exchange.json()).access_token).toBeUndefined();
      expect((f.database.prepare('SELECT count(*) AS count FROM mcp_grants').get() as {count:number}).count).toBe(1);
      expect(f.store.getOwned('draft',f.guest.owner)?.data).toEqual({ownerId:f.guest.owner,title:'Shared draft'});
    } finally {f.database.close();f.store.close();}
  });
  test('revocation denies old access and refresh without disturbing another grant or the browser',async()=>{
    const f=await fixture(),c1=await f.register(),c2=await f.register(),g1=await f.complete(c1),g2=await f.complete(c2);
    const req=(token:string)=>new Request(resource,{headers:{authorization:`Bearer ${token}`}});
    const actor1=await f.server.authenticate(req(g1.tokens.access_token),['comex:read']), actor2=await f.server.authenticate(req(g2.tokens.access_token),['comex:read']);
    expect(actor1?.ownerId).toBe(f.guest.owner);expect(actor2?.ownerId).toBe(f.guest.owner);
    expect((await f.server.connections(f.cookie)).length).toBe(2);
    expect(await f.server.isGrantActive(actor1!)).toBe(true);
    expect(await f.server.revoke(f.cookie,actor1!.grantId)).toBe(true);
    expect(await f.server.authenticate(req(g1.tokens.access_token),['comex:read'])).toBeNull();
    expect(await f.server.isGrantActive(actor1!)).toBe(false);
    const refresh=await f.call('/oauth2/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:c1,refresh_token:g1.tokens.refresh_token,resource})});
    expect(refresh.ok).toBe(false);
    expect(await f.server.authenticate(req(g2.tokens.access_token),['comex:read'])).not.toBeNull();
    expect(f.store.guestIdentity(f.guest.token)?.owner).toBe(f.guest.owner);
    f.database.close();f.store.close();
  });
  test('signed claims still require the correct audience, issuer, client, session and expiry',async()=>{
    const f=await fixture(),client=await f.register(),grant=await f.complete(client);
    const original=JSON.parse(Buffer.from(grant.tokens.access_token.split('.')[1],'base64url').toString());
    const req=(token:string)=>new Request(resource,{headers:{authorization:`Bearer ${token}`}});
    for(const changes of [{aud:'https://wrong.example/mcp'},{iss:'https://wrong.example'},{sid:undefined},{cnf:{jkt:'unverified'}},{client_id:'another-client'},{sub:'another-user'},{exp:Math.floor(Date.now()/1000)-30}]) {
      const {token}=await f.server.auth.api.signJWT({body:{payload:{...original,...changes}}});
      expect(await f.server.authenticate(req(token),['comex:read'])).toBeNull();
    }
    f.database.prepare('UPDATE "session" SET "expiresAt"=0 WHERE id=?').run(original.sid);
    expect(await f.server.authenticate(req(grant.tokens.access_token),['comex:read'])).toBeNull();
    f.database.prepare('UPDATE "oauthRefreshToken" SET "expiresAt"=0 WHERE "sessionId"=?').run(original.sid);
    const refresh=await f.call('/oauth2/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:client,refresh_token:grant.tokens.refresh_token,resource})});
    expect(refresh.ok).toBe(false);
    f.database.close();f.store.close();
  });
  test('a legacy cookie is converted to a distinct stable owner before connection',async()=>{
    const f=await fixture(),client=await f.register(),legacy=randomBytes(32).toString('hex');
    f.store.create('legacy-draft',legacy,{ownerId:legacy,title:'old'});
    const pending=await f.authorize(client);
    const response=await f.server.consent(new Request(base+'/api/mcp-auth/comex/consent',{method:'POST',headers:{'content-type':'application/json',origin:base,cookie:`comex_session=${legacy}`},body:JSON.stringify({oauth_query:pending.query,accept:true,email:'legacy@example.test'})}));
    expect(response.status).toBe(200);const migrated=f.store.guestIdentity(legacy);expect(migrated?.owner).toBeTruthy();expect(migrated!.owner).not.toBe(legacy);
    const code=new URL((await response.json()).redirect).searchParams.get('code')!,token=await f.exchange(client,code,pending.verifier),tokens=await token.json();
    const actor=await f.server.authenticate(new Request(resource,{headers:{authorization:`Bearer ${tokens.access_token}`}}),['comex:read']);
    expect(actor?.ownerId).toBe(migrated!.owner);expect(f.store.getOwned('legacy-draft',legacy)).toBeNull();
    expect(f.store.getOwned('legacy-draft',migrated!.owner)?.data).toEqual({ownerId:migrated!.owner,title:'old'});
    f.database.close();f.store.close();
  });
  test('guest to account claim moves its grants with its drafts',async()=>{
    const f=await fixture(),client=await f.register(),grant=await f.complete(client);
    const email='creator@example.test',code='12345678';
    f.store.issueCode(email,code,f.guest.token,secret);
    const result=f.store.consumeCode(email,code,secret,f.guest.token,f.guest.owner)!;
    const owner=f.store.authIdentity(result.session)!.owner;
    const actor=await f.server.authenticate(new Request(resource,{headers:{authorization:`Bearer ${grant.tokens.access_token}`}}),['comex:read']);
    expect(actor?.ownerId).toBe(owner);expect(owner).not.toBe(f.guest.owner);
    expect(f.store.getOwned('draft',owner)?.data).toEqual({ownerId:owner,title:'Shared draft'});
    expect((await f.server.connections(`comex_auth=${result.session}`)).length).toBe(1);
    f.database.close();f.store.close();
  });
  test('discovery is canonical and CIMD rejects private network targets',async()=>{
    const f=await fixture();
    const protectedMetadata=await f.server.auth.handler(new Request(base+'/.well-known/oauth-protected-resource/mcp'));
    const protectedBody=await protectedMetadata.json();expect(protectedBody.resource).toBe(resource);expect(protectedBody.authorization_servers).toEqual([base+'/api/mcp-auth']);
    expect(protectedBody.scopes_supported).toContain('comex:read');
    const serverMetadata=await f.server.auth.handler(new Request(base+'/.well-known/oauth-authorization-server/api/mcp-auth'));
    const meta=await serverMetadata.json();expect(meta.issuer).toBe(base+'/api/mcp-auth');expect(meta.code_challenge_methods_supported).toContain('S256');
    expect(validateClientIdUrl('https://127.0.0.1/client.json')).not.toBeNull();
    await expect(fetchClientMetadataResource('https://127.0.0.1/client.json')).rejects.toThrow();
    f.database.close();f.store.close();
  });
  test('only the owner browser can inspect or revoke a grant',async()=>{
    const f=await fixture(),client=await f.register(),grant=await f.complete(client);
    const actor=await f.server.authenticate(new Request(resource,{headers:{authorization:`Bearer ${grant.tokens.access_token}`}}),['comex:read']);
    const other=f.store.createGuest('other@example.test'),otherCookie=`comex_session=${other.token}`;
    expect(await f.server.connections(otherCookie)).toEqual([]);
    expect(await f.server.revoke(otherCookie,actor!.grantId)).toBe(false);
    expect(await f.server.authenticate(new Request(resource,{headers:{authorization:`Bearer ${grant.tokens.access_token}`}}),['comex:read'])).not.toBeNull();
    f.database.close();f.store.close();
  });
});
