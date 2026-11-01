import {afterAll,beforeAll,describe,expect,test} from 'bun:test';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {getMigrations} from 'better-auth/db/migration';
import {applyMigrations} from '../src/lib/storage/postgres';
import {PostgresAuth} from '../src/lib/storage/auth';
import {createMcpAuth} from '../src/lib/auth/mcp';

const base='http://localhost:3127',resource=base+'/mcp',secret='test-only-secret-test-only-secret-test-only-secret';
const pgDescribe=process.env.TEST_DATABASE_URL?describe:describe.skip;
pgDescribe('Postgres OAuth grants',()=>{
  const schema='comex_oauth_test_'+randomUUID().replaceAll('-','');
  let admin:Pool,pool:Pool;
  beforeAll(async()=>{
    const config={connectionString:process.env.TEST_DATABASE_URL};
    admin=new Pool(config);await admin.query(`CREATE SCHEMA "${schema}"`);pool=new Pool({...config,options:`-c search_path=${schema}`});await applyMigrations(pool);await applyMigrations(pool);
  });
  afterAll(async()=>{await pool?.end();if(admin){await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}});
  test('real PKCE grant follows guest claim and revokes its refresh independently',async()=>{
    const store=new PostgresAuth(pool),server=createMcpAuth({baseURL:base,resource,secret,database:pool,identityStore:store});
    const migration=await getMigrations(server.options);expect(migration.toBeCreated).toEqual([]);expect(migration.toBeAdded).toEqual([]);expect(migration.toBeAddedIndexes).toEqual([]);
    const guest=await store.createGuest('creator@example.test');
    await pool.query('INSERT INTO comics(id,owner,revision,draft) VALUES ($1,$2,1,$3)',['draft',guest.owner,JSON.stringify({ownerId:guest.owner,title:'shared'})]);
    const cookie=`comex_session=${guest.token}`,call=(path:string,init:RequestInit={})=>server.auth.handler(new Request(base+'/api/mcp-auth'+path,init));
    const registration=await call('/oauth2/register',{method:'POST',headers:{'content-type':'application/json',origin:base},body:JSON.stringify({application_type:'native',client_name:'Postgres test',redirect_uris:['http://127.0.0.1:64321/callback'],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']})});
    expect(registration.status).toBe(201);const client=(await registration.json()).client_id;
    const verifier=randomBytes(32).toString('base64url'),challenge=createHash('sha256').update(verifier).digest('base64url');
    const query=new URLSearchParams({client_id:client,redirect_uri:'http://127.0.0.1:64321/callback',response_type:'code',code_challenge:challenge,code_challenge_method:'S256',scope:'comex:read offline_access',resource});
    const auth=await call('/oauth2/authorize?'+query),signedQuery=new URL(auth.headers.get('location')!,base).search.slice(1);
    const consent=await server.consent(new Request(base+'/api/mcp-auth/comex/consent',{method:'POST',headers:{'content-type':'application/json',origin:base,cookie},body:JSON.stringify({oauth_query:signedQuery,accept:true})}));
    expect(consent.status).toBe(200);const code=new URL((await consent.json()).redirect).searchParams.get('code')!;
    const tokenResponse=await call('/oauth2/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:client,code,redirect_uri:'http://127.0.0.1:64321/callback',code_verifier:verifier,resource})});
    expect(tokenResponse.status).toBe(200);const tokens=await tokenResponse.json();const req=new Request(resource,{headers:{authorization:`Bearer ${tokens.access_token}`}});
    const actor=await server.authenticate(req,['comex:read']);expect(actor?.ownerId).toBe(guest.owner);
    await store.issueCode('creator@example.test','12345678',guest.token,secret);const signedIn=(await store.consumeCode('creator@example.test','12345678',secret,guest.token,guest.owner))!;
    const owner=(await store.authIdentity(signedIn.session))!.owner;expect((await server.authenticate(req,['comex:read']))?.ownerId).toBe(owner);
    expect((await pool.query('SELECT draft FROM comics WHERE id=$1 AND owner=$2',['draft',owner])).rows[0].draft.ownerId).toBe(owner);
    expect(await server.revoke(`comex_auth=${signedIn.session}`,actor!.grantId)).toBe(true);expect(await server.authenticate(req,['comex:read'])).toBeNull();
    const refresh=await call('/oauth2/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:client,refresh_token:tokens.refresh_token,resource})});expect(refresh.ok).toBe(false);
    expect(await store.authIdentity(signedIn.session)).not.toBeNull();
  });
});
