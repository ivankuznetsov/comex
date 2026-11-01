import {afterAll,beforeAll,describe,expect,test} from 'bun:test';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Pool} from 'pg';
import {NextRequest} from 'next/server';
import {createHostedBackend} from '../src/lib/hosted-api';
import {handleApi} from '../src/lib/local-api';
import {LocalStore} from '../src/lib/local-store';
import {PostgresAuth} from '../src/lib/storage/auth';
import {applyMigrations} from '../src/lib/storage/postgres';
import {importSqlite,importStagedOwner} from '../src/lib/storage/import';
import {recoverSameOriginImport,registerImportBatch} from '../src/lib/auth/claim';
import type {PrivateObjects} from '../src/lib/storage/assets';

class MemoryObjects implements PrivateObjects {async put(path:string,_data:Uint8Array){return path;}async read(_path:string){return Buffer.alloc(0);}async delete(_path:string){}}
const token=()=>randomBytes(32).toString('hex');
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const pgDescribe=process.env.TEST_DATABASE_URL?describe:describe.skip;
pgDescribe('same-origin imported identity recovery',()=>{
  const schema='comex_recovery_'+randomUUID().replaceAll('-','');let admin:Pool,pool:Pool,dir:string;
  beforeAll(async()=>{admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});await admin.query(`CREATE SCHEMA "${schema}"`);pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});await applyMigrations(pool);dir=mkdtempSync(join(tmpdir(),'comex-recovery-'));});
  afterAll(async()=>{if(dir)rmSync(dir,{recursive:true,force:true});await pool?.end();if(admin){await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}});
  async function fixture(kind:'guest'|'auth'|'legacy'='guest',draft:Record<string,unknown>={}) {
    const id=randomUUID(),path=join(dir,id+'.sqlite'),assets=join(dir,id);mkdirSync(assets);const store=new LocalStore(path),db=new DatabaseSync(path);
    let source:string,cookie:string;
    if(kind==='guest'){const guest=store.createGuest(`${id}@example.test`);source=guest.owner;cookie=`comex_session=${guest.token}`;}
    else if(kind==='auth'){source=token();const t=token();db.prepare('INSERT INTO auth_users(email,owner) VALUES (?,?)').run(`${id}@example.test`,source);db.prepare('INSERT INTO auth_sessions(token_hash,owner,expires_at) VALUES (?,?,?)').run(hash(t),source,Date.now()+60_000);cookie=`comex_auth=${t}`;}
    else {source=token();cookie=`comex_session=${source}`;}
    store.create(id,source,{ownerId:source,pages:[],...draft});db.close();store.close();
    await importSqlite({pool,objects:new MemoryObjects(),databasePath:path,assetPath:assets,batchId:id});await registerImportBatch(pool,id);
    return {id,source,cookie};
  }
  async function row(id:string){return (await pool.query('SELECT owner,import_batch_id,draft FROM comics WHERE id=$1',[id])).rows[0];}
  test('an original guest cookie recovers only its own staged drafts and replay is harmless',async()=>{
    const a=await fixture(),b=await fixture();expect(await recoverSameOriginImport(pool,a.cookie)).toBe('recovered');
    expect(await row(a.id)).toMatchObject({owner:a.source,import_batch_id:null});expect((await row(b.id)).import_batch_id).toBe(b.id);
    expect(await recoverSameOriginImport(pool,a.cookie)).toBe('none');
  });
  test('fresh and forged credentials cannot release an imported guest draft',async()=>{
    const a=await fixture(),auth=new PostgresAuth(pool),fresh=await auth.createGuest('fresh@example.test');
    expect(await recoverSameOriginImport(pool,`comex_session=${fresh.token}`)).toBe('none');
    expect(await recoverSameOriginImport(pool,`comex_session=${a.source}`)).toBe('none');
    expect((await row(a.id)).import_batch_id).toBe(a.id);
    // A later account session for the same owner also lacks snapshot provenance.
    const account=await fixture('auth'),other=token();
    await pool.query('INSERT INTO auth_sessions(token_hash,owner,expires_at) VALUES ($1,$2,$3)',[hash(other),account.source,Date.now()+60_000]);
    expect(await recoverSameOriginImport(pool,`comex_auth=${other}`)).toBe('none');
    expect((await row(account.id)).import_batch_id).toBe(account.id);
  });
  test('expired and revoked source guest credentials are rejected',async()=>{
    const a=await fixture(),b=await fixture();
    await pool.query('UPDATE auth_guests SET expires_at=0 WHERE owner=$1',[a.source]);await pool.query('DELETE FROM auth_guests WHERE owner=$1',[b.source]);
    expect(await recoverSameOriginImport(pool,a.cookie)).toBe('none');expect(await recoverSameOriginImport(pool,b.cookie)).toBe('none');
    expect((await row(a.id)).import_batch_id).toBe(a.id);expect((await row(b.id)).import_batch_id).toBe(b.id);
  });
  test('valid auth cookie takes precedence over another imported guest',async()=>{
    const a=await fixture(),b=await fixture('auth');
    expect(await recoverSameOriginImport(pool,`${b.cookie}; ${a.cookie}`)).toBe('recovered');
    expect((await row(b.id)).import_batch_id).toBeNull();expect((await row(a.id)).import_batch_id).toBe(a.id);
  });
  test('a legacy browser token gets a new internal guest owner without exposing other drafts',async()=>{
    const a=await fixture('legacy'),b=await fixture('legacy');expect(await recoverSameOriginImport(pool,a.cookie)).toBe('recovered');
    const restored=await row(a.id),identity=await new PostgresAuth(pool).guestIdentity(a.source);
    expect(restored.import_batch_id).toBeNull();expect(restored.owner).not.toBe(a.source);expect(identity?.owner).toBe(restored.owner);expect(restored.draft.ownerId).toBe(restored.owner);
    expect((await row(b.id)).import_batch_id).toBe(b.id);expect(await recoverSameOriginImport(pool,a.cookie)).toBe('none');
  });
  test.each(['running','unknown','unknown_outcome'])('unresolved %s draft operation blocks recovery atomically',async state=>{
    const a=await fixture('guest',{operations:{'panel:test':state}});expect(await recoverSameOriginImport(pool,a.cookie)).toBe('blocked');expect((await row(a.id)).import_batch_id).toBe(a.id);
  });
  test('a checking panel blocks recovery and leaves legacy identity untouched',async()=>{
    const a=await fixture('legacy',{pages:[{panels:[{status:'checking'}]}]});expect(await recoverSameOriginImport(pool,a.cookie)).toBe('blocked');
    expect((await row(a.id)).import_batch_id).toBe(a.id);expect(await new PostgresAuth(pool).guestIdentity(a.source)).toBeNull();
  });
  test('an unresolved text operation blocks recovery',async()=>{
    const a=await fixture();await pool.query("INSERT INTO comic_text_operations(comic_id,owner,state) VALUES ($1,$2,'unknown')",[a.id,a.source]);
    expect(await recoverSameOriginImport(pool,a.cookie)).toBe('blocked');expect((await row(a.id)).import_batch_id).toBe(a.id);
  });
  test('browser session detects recovery and its POST requires the same origin',async()=>{
    const a=await fixture('legacy'),backend=createHostedBackend({pool,objects:new MemoryObjects(),origin:'https://comex.example',workspaceSecret:'test-workspace-secret-32-characters-long',budgetFetch:async()=>{throw new Error('unused');}});
    const session=()=>new NextRequest('https://comex.example/api/auth/session',{headers:{host:'comex.example',cookie:a.cookie}});
    expect((await (await handleApi(session(),['auth','session'],backend)).json()).importRecoveryAvailable).toBe(true);
    const post=(origin:string)=>new NextRequest('https://comex.example/api/auth/recover-import',{method:'POST',headers:{host:'comex.example',origin,'content-type':'application/json',cookie:a.cookie},body:'{}'});
    expect((await handleApi(post('https://evil.example'),['auth','recover-import'],backend)).status).toBe(403);
    expect((await row(a.id)).import_batch_id).toBe(a.id);
    expect((await handleApi(post('https://comex.example'),['auth','recover-import'],backend)).status).toBe(200);
    const current=await (await handleApi(session(),['auth','session'],backend)).json();expect(current.importRecoveryAvailable).toBe(false);expect(current.workspaceId).toBeTruthy();
  });

  test('releases terminal operations and revoked grants with the imported owner',async()=>{
    const a=await fixture(),staged=importStagedOwner(a.id,a.source),grant=randomUUID(),op=randomUUID();
    await pool.query("INSERT INTO mcp_grants(id,owner,client_id,session_id,user_id,client_name,created_at,revoked_at) VALUES ($1,$2,'client',$3,$4,'test',1,2)",[grant,staged,randomUUID(),randomUUID()]);
    await pool.query("INSERT INTO operations(id,owner,action,request_key,input_digest,target_id,grant_id,expected_versions,input_json,status,created_at,updated_at) VALUES ($1,$2,'render','key','digest',$3,$4,'{}','{}','succeeded','1','1')",[op,staged,a.id,grant]);
    expect(await recoverSameOriginImport(pool,a.cookie)).toBe('recovered');
    expect((await pool.query('SELECT owner FROM operations WHERE id=$1',[op])).rows[0].owner).toBe(a.source);
    expect((await pool.query('SELECT owner,revoked_at FROM mcp_grants WHERE id=$1',[grant])).rows[0]).toEqual({owner:a.source,revoked_at:'2'});
  });
  test('request-key collisions and unrevoked imported grants prevent any release',async()=>{
    const a=await fixture(),staged=importStagedOwner(a.id,a.source);
    for(const [id,owner] of [[randomUUID(),staged],[randomUUID(),a.source]])await pool.query("INSERT INTO operations(id,owner,action,request_key,input_digest,target_id,expected_versions,input_json,status,created_at,updated_at) VALUES ($1,$2,'render','key','digest',$3,'{}','{}','succeeded','1','1')",[id,owner,a.id]);
    expect(await recoverSameOriginImport(pool,a.cookie)).toBe('blocked');expect((await row(a.id)).import_batch_id).toBe(a.id);
    const b=await fixture(),grant=randomUUID();await pool.query("INSERT INTO mcp_grants(id,owner,client_id,session_id,user_id,client_name,created_at) VALUES ($1,$2,'client',$3,$4,'test',1)",[grant,importStagedOwner(b.id,b.source),randomUUID(),randomUUID()]);
    expect(await recoverSameOriginImport(pool,b.cookie)).toBe('blocked');expect((await row(b.id)).import_batch_id).toBe(b.id);
  });

  test.each(['running','unknown'])('the importer rejects a source %s page job before creating a batch',async state=>{
    const id=randomUUID(),path=join(dir,id+'.sqlite'),assets=join(dir,id);mkdirSync(assets);const store=new LocalStore(path),guest=store.createGuest('job@example.test');
    store.create(id,guest.owner,{ownerId:guest.owner,pages:[]});const db=new DatabaseSync(path);
    db.prepare('INSERT INTO page_jobs(id,comic_id,page_id,owner,state,message,created_at) VALUES (?,?,?,?,?,NULL,?)').run(randomUUID(),id,'page',guest.owner,state,Date.now());
    db.close();store.close();
    await expect(importSqlite({pool,objects:new MemoryObjects(),databasePath:path,assetPath:assets,batchId:id})).rejects.toThrow('active page jobs');
    expect((await pool.query('SELECT 1 FROM import_batches WHERE id=$1',[id])).rowCount).toBe(0);
  });

  test('expired snapshot proofs and revoked account sessions cannot restore drafts',async()=>{
    const a=await fixture('auth'),b=await fixture('auth');
    await pool.query('UPDATE mcp_import_identity_proofs SET expires_at=0 WHERE batch_id=$1',[a.id]);
    await pool.query('DELETE FROM auth_sessions WHERE owner=$1',[b.source]);
    expect(await recoverSameOriginImport(pool,a.cookie)).toBe('none');expect(await recoverSameOriginImport(pool,b.cookie)).toBe('none');
    expect((await row(a.id)).import_batch_id).toBe(a.id);expect((await row(b.id)).import_batch_id).toBe(b.id);
  });
  test('concurrent recovery requests release a batch exactly once',async()=>{
    const a=await fixture('legacy');
    expect((await Promise.all([recoverSameOriginImport(pool,a.cookie),recoverSameOriginImport(pool,a.cookie)])).sort()).toEqual(['none','recovered']);
    const restored=await row(a.id);expect(restored.import_batch_id).toBeNull();expect(restored.owner).toBe((await new PostgresAuth(pool).guestIdentity(a.source))?.owner);
  });

});
