import {afterAll,beforeAll,describe,expect,test} from 'bun:test';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {ProviderBudget} from '../src/lib/budget';
import {LocalStore} from '../src/lib/local-store';
import {PostgresAuth} from '../src/lib/storage/auth';
import {applyMigrations,PostgresRepository} from '../src/lib/storage/postgres';
import type {PrivateObjects} from '../src/lib/storage/assets';
class MemoryObjects implements PrivateObjects { async put(path:string) {return path;} async read() {return Buffer.alloc(0);} async delete() {} }
import {SqliteOperationRepository,initializeSqliteOperations} from '../src/lib/operations/sqlite';
import {PostgresOperationRepository} from '../src/lib/operations/postgres';

type Fixture={store:any;repo:any;comic:any;query:(sql:string,...values:any[])=>Promise<any[]>;policy:(tx:any,context:any)=>any;close:()=>Promise<void>};
const secret='claim-test-secret',email='owner@example.test',code='12345678';
const input=(owner:string,targetId:string,key:string,grantId:string|null=null)=>({owner,targetId,requestKey:key,action:'render',grantId,expectedVersions:{revision:1},input:{page:1}});
async function account(f:Fixture) {
  await f.store.issueCode(email,code,'account-browser',secret);const signed=await f.store.consumeCode(email,code,secret,'account-browser',null);return (await f.store.authIdentity(signed.session)).owner as string;
}
async function guestDraft(f:Fixture,id:string) {
  const guest=await f.store.createGuest(email);await f.comic.create(id,guest.owner,{ownerId:guest.owner,title:'private'});return guest;
}
async function terminal(f:Fixture,owner:string,target:string,key:string,grantId:string|null=null) {
  const {operation}=await f.repo.start(input(owner,target,key,grantId),f.policy),lease=await f.repo.claimOperation(operation.id,60_000);
  await f.repo.claimPaidStep(lease,{id:'image',input:{page:1}},f.policy);await f.repo.completePaidStep(lease,'image','completed',{asset:'one'});
  await f.repo.commitCheckpoint(lease,'applied',{revision:2},f.policy);await f.repo.finishOperation(lease,'succeeded',{done:true});return operation.id as string;
}
async function beginClaim(f:Fixture,guest:{token:string;owner:string}) {await f.store.issueCode(email,code,guest.token,secret);return ()=>f.store.consumeCode(email,code,secret,guest.token,guest.owner);}
function contract(make:()=>Promise<Fixture>) {
  test('guest account claim moves terminal operation history and grants with the draft',async()=>{
    const f=await make();try {
      const target=await account(f),guest=await guestDraft(f,'guest-draft'),other=await guestDraft(f,'other-draft'),grant=randomUUID();
      await f.query('INSERT INTO mcp_grants(id,owner,client_id,session_id,user_id,client_name,created_at) VALUES (?,?,?,?,?,?,?)',grant,guest.owner,'client',randomUUID(),randomUUID(),'client',Date.now());
      const id=await terminal(f,guest.owner,'guest-draft','terminal',grant),otherId=await terminal(f,other.owner,'other-draft','other');
      const run=await beginClaim(f,guest);await run();
      expect(await f.repo.getOwned(target,id)).toMatchObject({id,owner:target,grantId:grant,status:'succeeded'});
      expect(await f.repo.getOwned(guest.owner,id)).toBeNull();expect(await f.repo.getOwned(target,otherId)).toBeNull();
      expect(await f.repo.getStep(target,id,'image')).toMatchObject({state:'completed',result:{asset:'one'}});
      expect(await f.repo.getCheckpoint(target,id,'applied')).toEqual({revision:2});
      expect((await f.query('SELECT owner FROM mcp_grants WHERE id=?',grant))[0].owner).toBe(target);
      expect((await f.query('SELECT state FROM operation_dispatch_intents WHERE operation_id=?',id))[0].state).toBe('pending');
      expect((await f.comic.getOwned('guest-draft',target)).data.ownerId).toBe(target);
      expect(await f.comic.getOwned('other-draft',other.owner)).not.toBeNull();
    }finally{await f.close();}
  });
  for(const status of ['queued','running','unknown_outcome'] as const) test(`${status} operation blocks claim without consuming the code or moving data`,async()=>{
    const f=await make();try {
      const target=await account(f),guest=await guestDraft(f,'active-draft'),op=(await f.repo.start(input(guest.owner,'active-draft',status),f.policy)).operation;
      if(status!=='queued') {const lease=await f.repo.claimOperation(op.id,60_000);if(status==='unknown_outcome'){await f.repo.claimPaidStep(lease,{id:'image',input:{}},f.policy);await f.repo.completePaidStep(lease,'image','unknown',null);}}
      const run=await beginClaim(f,guest);await expect(Promise.resolve().then(run)).rejects.toThrow('Wait for your existing draft');
      expect(await f.comic.getOwned('active-draft',guest.owner)).not.toBeNull();expect(await f.comic.getOwned('active-draft',target)).toBeNull();
      expect(await f.repo.getOwned(guest.owner,op.id)).toMatchObject({status});expect((await f.query('SELECT email FROM auth_codes WHERE email=?',email))).toHaveLength(1);
    }finally{await f.close();}
  });
  test('a terminal operation with an unresolved reservation cannot be transferred',async()=>{
    const f=await make();try {
      const guest=await guestDraft(f,'uncertain-draft'),id=await terminal(f,guest.owner,'uncertain-draft','uncertain');
      const reservation=(await f.query('SELECT reservation_id FROM operation_steps WHERE operation_id=?',id))[0].reservation_id;
      await f.query("UPDATE provider_reservations SET state='unknown' WHERE id=?",reservation);
      const run=await beginClaim(f,guest);await expect(Promise.resolve().then(run)).rejects.toThrow('Wait for your existing draft');
      expect(await f.comic.getOwned('uncertain-draft',guest.owner)).not.toBeNull();expect(await f.repo.getOwned(guest.owner,id)).not.toBeNull();
    }finally{await f.close();}
  });
  test('a claim cannot transfer an operation linked to another owner’s grant',async()=>{
    const f=await make();try {
      const guest=await guestDraft(f,'source-draft'),other=await guestDraft(f,'private-draft'),grant=randomUUID();
      await f.query('INSERT INTO mcp_grants(id,owner,client_id,session_id,user_id,client_name,created_at) VALUES (?,?,?,?,?,?,?)',grant,other.owner,'client',randomUUID(),randomUUID(),'other',Date.now());
      const id=await terminal(f,guest.owner,'source-draft','wrong-grant',grant),run=await beginClaim(f,guest);
      await expect(Promise.resolve().then(run)).rejects.toThrow('another connection');
      expect(await f.repo.getOwned(guest.owner,id)).not.toBeNull();expect((await f.query('SELECT owner FROM mcp_grants WHERE id=?',grant))[0].owner).toBe(other.owner);
      expect(await f.comic.getOwned('source-draft',guest.owner)).not.toBeNull();
    }finally{await f.close();}
  });
  test('request-key collision rolls back the draft, operation, grant and sign-in code',async()=>{
    const f=await make();try {
      const target=await account(f),guest=await guestDraft(f,'collision-draft'),grant=randomUUID();
      await f.query('INSERT INTO mcp_grants(id,owner,client_id,session_id,user_id,client_name,created_at) VALUES (?,?,?,?,?,?,?)',grant,guest.owner,'client',randomUUID(),randomUUID(),'client',Date.now());
      const source=await terminal(f,guest.owner,'collision-draft','same-key',grant);
      await f.comic.create('account-draft',target,{ownerId:target});const existing=await terminal(f,target,'account-draft','same-key');
      const run=await beginClaim(f,guest);await expect(Promise.resolve().then(run)).rejects.toThrow();
      expect(await f.comic.getOwned('collision-draft',guest.owner)).not.toBeNull();expect(await f.comic.getOwned('collision-draft',target)).toBeNull();
      expect(await f.repo.getOwned(guest.owner,source)).not.toBeNull();expect(await f.repo.getOwned(target,existing)).not.toBeNull();
      expect((await f.query('SELECT owner FROM mcp_grants WHERE id=?',grant))[0].owner).toBe(guest.owner);expect((await f.query('SELECT email FROM auth_codes WHERE email=?',email))).toHaveLength(1);
    }finally{await f.close();}
  });
  test('legacy cookie claim transfers terminal history to its new stable owner',async()=>{
    const f=await make();try {
      const legacy=randomBytes(32).toString('hex');await f.comic.create('legacy-draft',legacy,{ownerId:legacy});
      const op=await terminal(f,legacy,'legacy-draft','legacy');const owner=(await f.store.claimLegacyOwner(legacy,email)).owner;
      expect(owner).not.toBe(legacy);expect(await f.repo.getOwned(owner,op)).toMatchObject({owner,status:'succeeded'});
      expect(await f.repo.getCheckpoint(owner,op,'applied')).toEqual({revision:2});expect(await f.repo.getOwned(legacy,op)).toBeNull();
    }finally{await f.close();}
  });
}

describe('SQLite claim and operation ownership',()=>{
  contract(async()=>{
    const dir=mkdtempSync(join(tmpdir(),'comex-claim-ops-')),path=join(dir,'db.sqlite');const store=new LocalStore(path),budget=new ProviderBudget(path,{maxCalls:100,maxConcurrent:10});budget.close();
    const db=new DatabaseSync(path);initializeSqliteOperations(db);const repo=new SqliteOperationRepository(db,{maxCalls:100,maxConcurrent:10});
    return {store,comic:store,repo,policy:()=>{},query:async(sql,...values)=>{const stmt=db.prepare(sql);if(/^\s*SELECT/i.test(sql))return stmt.all(...values);stmt.run(...values);return [];},close:async()=>{db.close();store.close();rmSync(dir,{recursive:true,force:true});}};
  });
  test('a concurrent operation start commits before claim and prevents transfer',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'comex-claim-race-')),path=join(dir,'db.sqlite'),store=new LocalStore(path),budget=new ProviderBudget(path,{maxCalls:10,maxConcurrent:2});budget.close();
    const db=new DatabaseSync(path);initializeSqliteOperations(db);db.close();const guest=store.createGuest(email);store.create('race',guest.owner,{ownerId:guest.owner});store.issueCode(email,code,guest.token,secret);
    const script=`import {DatabaseSync} from 'node:sqlite';import {SqliteOperationRepository} from './src/lib/operations/sqlite';const d=new DatabaseSync(process.env.CLAIM_TEST_PATH);const r=new SqliteOperationRepository(d,{maxCalls:10,maxConcurrent:2});r.start({owner:process.env.CLAIM_TEST_OWNER,targetId:'race',action:'render',requestKey:'racing',grantId:null,expectedVersions:{},input:{}},()=>{process.stdout.write('locked\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,500);});d.close();`;
    const child=Bun.spawn(['bun','-e',script],{cwd:process.cwd(),env:{...process.env,CLAIM_TEST_PATH:path,CLAIM_TEST_OWNER:guest.owner},stdout:'pipe',stderr:'pipe'});
    try {
      const reader=child.stdout.getReader(),ready=await reader.read();expect(new TextDecoder().decode(ready.value)).toContain('locked');
      expect(()=>store.consumeCode(email,code,secret,guest.token,guest.owner)).toThrow('Wait for your existing draft');expect(await child.exited).toBe(0);
      expect(store.getOwned('race',guest.owner)).not.toBeNull();expect(store.guestIdentity(guest.token)?.owner).toBe(guest.owner);
    }finally{child.kill();await child.exited;store.close();rmSync(dir,{recursive:true,force:true});}
  });
});
const pgDescribe=process.env.TEST_DATABASE_URL?describe:describe.skip;
pgDescribe('Postgres claim and operation ownership',()=>{
  const schema=`comex_claim_ops_${randomUUID().replaceAll('-','')}`;let admin:Pool,pool:Pool;
  beforeAll(async()=>{admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});await admin.query(`CREATE SCHEMA "${schema}"`);pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});await applyMigrations(pool);});
  afterAll(async()=>{await pool?.end();if(admin){await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}});
  contract(async()=>{
    await pool.query('TRUNCATE operation_checkpoints,operation_steps,operation_dispatch_intents,operations,provider_reservations,comic_text_operations,comics,mcp_grants,auth_codes,auth_code_attempts,auth_requests,auth_guests,auth_sessions,auth_users CASCADE');
    const store=new PostgresAuth(pool),repo=new PostgresOperationRepository(pool,{maxCalls:100,maxConcurrent:10}),comic=new PostgresRepository(pool,new MemoryObjects());
    return {store,comic,repo,policy:async(tx,context)=>{if(context.phase==='create'){const row=await tx.query('SELECT id FROM comics WHERE id=$1 AND owner=$2 AND import_batch_id IS NULL FOR UPDATE',[context.operation.targetId,context.operation.owner]);if(!row.rowCount)throw new Error('not authorized');}},query:async(sql,...values)=>{let i=0;return (await pool.query(sql.replace(/\?/g,()=>`$${++i}`),values)).rows;},close:async()=>{}};
  });
  test('a concurrent operation start holding the draft lock prevents claim after it commits',async()=>{
    const store=new PostgresAuth(pool),repo=new PostgresOperationRepository(pool,{maxCalls:100,maxConcurrent:10}),guest=await store.createGuest('race@example.test');
    await pool.query('INSERT INTO comics(id,owner,revision,draft) VALUES ($1,$2,1,$3)',['pg-race',guest.owner,JSON.stringify({ownerId:guest.owner})]);await store.issueCode('race@example.test',code,guest.token,secret);
    let ready!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>{ready=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
    const start=repo.start(input(guest.owner,'pg-race','race'),async(tx)=>{const row=await tx.query('SELECT id FROM comics WHERE id=$1 AND owner=$2 AND import_batch_id IS NULL FOR UPDATE',['pg-race',guest.owner]);if(!row.rowCount)throw new Error('not authorized');ready();await gate;});
    await entered;const claim=store.consumeCode('race@example.test',code,secret,guest.token,guest.owner);const waiting=await Promise.race([claim.then(()=>false,()=>false),new Promise<boolean>(resolve=>setTimeout(()=>resolve(true),30))]);
    expect(waiting).toBe(true);release();const started=await start;await expect(claim).rejects.toThrow('Wait for your existing draft');
    expect(await repo.getOwned(guest.owner,started.operation.id)).toMatchObject({status:'queued'});expect((await pool.query('SELECT owner FROM comics WHERE id=$1',['pg-race'])).rows[0].owner).toBe(guest.owner);
  });
});
