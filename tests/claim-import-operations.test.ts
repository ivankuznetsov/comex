import {afterAll,beforeAll,describe,expect,test} from 'bun:test';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {ProviderBudget} from '../src/lib/budget';
import {LocalStore} from '../src/lib/local-store';
import {PostgresAuth} from '../src/lib/storage/auth';
import {applyMigrations} from '../src/lib/storage/postgres';
import {importSqlite} from '../src/lib/storage/import';
import {attestImport,issueImportChallenge,redeemImport,registerImportBatch} from '../src/lib/auth/claim';
import {SqliteOperationRepository,initializeSqliteOperations} from '../src/lib/operations/sqlite';
import {PostgresOperationRepository} from '../src/lib/operations/postgres';
import type {PrivateObjects} from '../src/lib/storage/assets';

class MemoryObjects implements PrivateObjects {data=new Map<string,Buffer>();async put(path:string,data:Uint8Array){this.data.set(path,Buffer.from(data));return path;}async read(path:string){return this.data.get(path)!;}async delete(path:string){this.data.delete(path);}}
const origin='https://comex.example',secret='test-handoff-secret-test-handoff-secret-test-handoff-secret';
const pgDescribe=process.env.TEST_DATABASE_URL?describe:describe.skip;
pgDescribe('imported operation ownership',()=>{
  const schema='comex_claim_import_'+randomUUID().replaceAll('-','');let admin:Pool,pool:Pool,dir:string;
  beforeAll(async()=>{admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});await admin.query(`CREATE SCHEMA "${schema}"`);pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});await applyMigrations(pool);dir=mkdtempSync(join(tmpdir(),'comex-import-ops-'));});
  afterAll(async()=>{if(dir)rmSync(dir,{recursive:true,force:true});await pool?.end();if(admin){await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}});
  async function source() {
    const id=randomUUID(),path=join(dir,id+'.sqlite'),assetPath=join(dir,id);mkdirSync(assetPath);const store=new LocalStore(path),budget=new ProviderBudget(path,{maxCalls:100,maxConcurrent:10});budget.close();const db=new DatabaseSync(path);initializeSqliteOperations(db);const repo=new SqliteOperationRepository(db,{maxCalls:100,maxConcurrent:10});
    return {path,assetPath,store,db,repo,objects:new MemoryObjects()};
  }
  async function terminal(s:Awaited<ReturnType<typeof source>>,owner:string,target:string,requestKey:string,grantId:string|null=null) {
    const {operation}=await s.repo.start({owner,targetId:target,action:'render',requestKey,grantId,expectedVersions:{revision:1},input:{page:1}},()=>{}),lease=(await s.repo.claimOperation(operation.id,60_000))!;
    const step=await s.repo.claimPaidStep(lease,{id:'image',input:{page:1}},()=>{});await s.repo.completePaidStep(lease,'image','completed',{asset:'saved'});await s.repo.commitCheckpoint(lease,'saved',{revision:2},()=>{});await s.repo.finishOperation(lease,'succeeded',{done:true});return {operation,step};
  }
  async function proof(s:Awaited<ReturnType<typeof source>>,batchId:string,sourceCookie:string,targetCookie:string) {
    const hosted=new PostgresAuth(pool);await registerImportBatch(pool,batchId);
    const challenge=await issueImportChallenge({pool,identityStore:hosted,cookie:targetCookie,batchId,origin,secret});
    return (await attestImport({identityStore:s.store,cookie:sourceCookie,challenge:challenge!,origin,secret}))!;
  }
  test('import stages terminal history, reservations and disconnected grant until the verified owner redeems it',async()=>{
    const s=await source();try {
      const guest=s.store.createGuest('source@example.test'),other=s.store.createGuest('other@example.test');
      s.store.create('source-draft',guest.owner,{ownerId:guest.owner});s.store.create('other-draft',other.owner,{ownerId:other.owner});
      const grant=randomUUID();s.db.prepare('INSERT INTO mcp_grants(id,owner,client_id,session_id,user_id,client_name,created_at) VALUES (?,?,?,?,?,?,?)').run(grant,guest.owner,'client',randomUUID(),randomUUID(),'source client',Date.now());
      const first=await terminal(s,guest.owner,'source-draft','source-key',grant),second=await terminal(s,other.owner,'other-draft','other-key');
      const batch='operations-batch',args={pool,objects:s.objects,databasePath:s.path,assetPath:s.assetPath,batchId:batch};await importSqlite(args);await importSqlite(args);
      const hosted=new PostgresAuth(pool),target=await hosted.createGuest('target@example.test'),targetCookie=`comex_session=${target.token}`,repo=new PostgresOperationRepository(pool,{maxCalls:100,maxConcurrent:10});
      expect(await repo.getOwned(guest.owner,first.operation.id)).toBeNull();expect(await repo.getOwned(target.owner,first.operation.id)).toBeNull();
      const transferred=await proof(s,batch,`comex_session=${guest.token}`,targetCookie);
      expect(await redeemImport({pool,identityStore:hosted,cookie:targetCookie,proof:transferred,origin,secret})).toBe(true);
      expect(await repo.getOwned(target.owner,first.operation.id)).toMatchObject({id:first.operation.id,owner:target.owner,grantId:grant,status:'succeeded'});
      expect(await repo.getOwned(target.owner,second.operation.id)).toBeNull();expect(await repo.getOwned(other.owner,second.operation.id)).toBeNull();
      expect(await repo.getStep(target.owner,first.operation.id,'image')).toMatchObject({state:'completed',result:{asset:'saved'},reservationId:first.step.reservationId});
      expect(await repo.getCheckpoint(target.owner,first.operation.id,'saved')).toEqual({revision:2});
      expect((await pool.query('SELECT state FROM provider_reservations WHERE id=$1',[first.step.reservationId])).rows[0].state).toBe('completed');
      expect((await pool.query('SELECT state FROM operation_dispatch_intents WHERE operation_id=$1',[first.operation.id])).rows[0].state).toBe('pending');
      const importedGrant=(await pool.query('SELECT owner,revoked_at FROM mcp_grants WHERE id=$1',[grant])).rows[0];expect(importedGrant.owner).toBe(target.owner);expect(importedGrant.revoked_at).not.toBeNull();
      expect((await pool.query('SELECT import_batch_id FROM comics WHERE id=$1',['other-draft'])).rows[0].import_batch_id).toBe(batch);
    }finally{s.db.close();s.store.close();}
  });
  for(const state of ['queued','running','unknown_outcome'] as const) test(`${state} source operations fail before importing any data`,async()=>{
    const s=await source();try {
      const guest=s.store.createGuest('queued@example.test');s.store.create('queued-draft',guest.owner,{ownerId:guest.owner});
      const op=(await s.repo.start({owner:guest.owner,targetId:'queued-draft',action:'render',requestKey:'queued',grantId:null,expectedVersions:{},input:{}},()=>{})).operation;
      if(state!=='queued'){const lease=(await s.repo.claimOperation(op.id,60_000))!;if(state==='unknown_outcome'){await s.repo.claimPaidStep(lease,{id:'image',input:{}},()=>{});await s.repo.completePaidStep(lease,'image','unknown',null);}}
      const batch='blocked-'+state;await expect(importSqlite({pool,objects:s.objects,databasePath:s.path,assetPath:s.assetPath,batchId:batch})).rejects.toThrow('active operations');
      expect((await pool.query('SELECT id FROM import_batches WHERE id=$1',[batch])).rowCount).toBe(0);expect(s.objects.data.size).toBe(0);
    }finally{s.db.close();s.store.close();}
  });
  test('a terminal operation with an unresolved reservation is not imported',async()=>{
    const s=await source();try {
      const guest=s.store.createGuest('uncertain@example.test');s.store.create('uncertain-import',guest.owner,{ownerId:guest.owner});const item=await terminal(s,guest.owner,'uncertain-import','uncertain');
      s.db.prepare("UPDATE provider_reservations SET state='unknown' WHERE id=?").run(item.step.reservationId);
      await expect(importSqlite({pool,objects:s.objects,databasePath:s.path,assetPath:s.assetPath,batchId:'uncertain-batch'})).rejects.toThrow('active operations');
      expect((await pool.query('SELECT id FROM import_batches WHERE id=$1',['uncertain-batch'])).rowCount).toBe(0);
    }finally{s.db.close();s.store.close();}
  });
  test('a separate budget database cannot silently replace operation reservations',async()=>{
    const s=await source();try {
      const guest=s.store.createGuest('split@example.test');s.store.create('split-draft',guest.owner,{ownerId:guest.owner});await terminal(s,guest.owner,'split-draft','split');
      const alternate=join(dir,randomUUID()+'.sqlite'),budget=new ProviderBudget(alternate,{maxCalls:10,maxConcurrent:2});budget.close();
      await expect(importSqlite({pool,objects:s.objects,databasePath:s.path,budgetPath:alternate,assetPath:s.assetPath,batchId:'split-batch'})).rejects.toThrow('same SQLite snapshot');
      expect((await pool.query('SELECT id FROM import_batches WHERE id=$1',['split-batch'])).rowCount).toBe(0);
    }finally{s.db.close();s.store.close();}
  });
  test('operation history in a separately selected budget database is not discarded',async()=>{
    const s=await source(),plainPath=join(dir,randomUUID()+'.sqlite'),plain=new LocalStore(plainPath);try {
      const guest=s.store.createGuest('other-budget@example.test');s.store.create('budget-history',guest.owner,{ownerId:guest.owner});await terminal(s,guest.owner,'budget-history','history');
      await expect(importSqlite({pool,objects:s.objects,databasePath:plainPath,budgetPath:s.path,assetPath:s.assetPath,batchId:'budget-history-batch'})).rejects.toThrow('same SQLite snapshot');
      expect((await pool.query('SELECT id FROM import_batches WHERE id=$1',['budget-history-batch'])).rowCount).toBe(0);
    }finally{plain.close();s.db.close();s.store.close();}
  });
  test('an empty source workspace can claim its imported connection history',async()=>{
    const s=await source();try {
      const guest=s.store.createGuest('empty@example.test'),grant=randomUUID();
      s.db.prepare('INSERT INTO mcp_grants(id,owner,client_id,session_id,user_id,client_name,created_at) VALUES (?,?,?,?,?,?,?)').run(grant,guest.owner,'client',randomUUID(),randomUUID(),'old connection',Date.now());
      const batch='empty-batch';await importSqlite({pool,objects:s.objects,databasePath:s.path,assetPath:s.assetPath,batchId:batch});
      const hosted=new PostgresAuth(pool),target=await hosted.createGuest('empty-target@example.test'),cookie=`comex_session=${target.token}`;
      const token=await proof(s,batch,`comex_session=${guest.token}`,cookie);expect(await redeemImport({pool,identityStore:hosted,cookie,proof:token,origin,secret})).toBe(true);
      const row=(await pool.query('SELECT owner,revoked_at FROM mcp_grants WHERE id=$1',[grant])).rows[0];expect(row.owner).toBe(target.owner);expect(row.revoked_at).not.toBeNull();
    }finally{s.db.close();s.store.close();}
  });
  test('an operation cannot import another owner’s known draft',async()=>{
    const s=await source();try {
      const guest=s.store.createGuest('operation-owner@example.test'),other=s.store.createGuest('draft-owner@example.test');s.store.create('other-private-draft',other.owner,{ownerId:other.owner});
      await terminal(s,guest.owner,'other-private-draft','wrong-draft');
      await expect(importSqlite({pool,objects:s.objects,databasePath:s.path,assetPath:s.assetPath,batchId:'wrong-owner-batch'})).rejects.toThrow('another owner');
      expect((await pool.query('SELECT id FROM import_batches WHERE id=$1',['wrong-owner-batch'])).rowCount).toBe(0);
    }finally{s.db.close();s.store.close();}
  });
  test('an operation cannot import another owner’s connection reference',async()=>{
    const s=await source();try {
      const guest=s.store.createGuest('source-owner@example.test'),other=s.store.createGuest('grant-owner@example.test'),grant=randomUUID();s.store.create('mismatched-grant',guest.owner,{ownerId:guest.owner});
      s.db.prepare('INSERT INTO mcp_grants(id,owner,client_id,session_id,user_id,client_name,created_at) VALUES (?,?,?,?,?,?,?)').run(grant,other.owner,'client',randomUUID(),randomUUID(),'other',Date.now());
      await terminal(s,guest.owner,'mismatched-grant','grant-mismatch',grant);
      await expect(importSqlite({pool,objects:s.objects,databasePath:s.path,assetPath:s.assetPath,batchId:'mismatch-batch'})).rejects.toThrow('mismatched connection');
      expect((await pool.query('SELECT id FROM import_batches WHERE id=$1',['mismatch-batch'])).rowCount).toBe(0);
    }finally{s.db.close();s.store.close();}
  });
  test('a destination request-key collision leaves imported records and proof unclaimed',async()=>{
    const s=await source();try {
      const guest=s.store.createGuest('collision@example.test');s.store.create('import-collision',guest.owner,{ownerId:guest.owner});const imported=await terminal(s,guest.owner,'import-collision','collision-key');
      const batch='collision-batch';await importSqlite({pool,objects:s.objects,databasePath:s.path,assetPath:s.assetPath,batchId:batch});
      const hosted=new PostgresAuth(pool),target=await hosted.createGuest('target2@example.test'),cookie=`comex_session=${target.token}`,repo=new PostgresOperationRepository(pool,{maxCalls:100,maxConcurrent:10});
      const existing=await repo.start({owner:target.owner,targetId:'existing',action:'render',requestKey:'collision-key',grantId:null,expectedVersions:{},input:{}},()=>{});
      const token=await proof(s,batch,`comex_session=${guest.token}`,cookie);
      expect(await redeemImport({pool,identityStore:hosted,cookie,proof:token,origin,secret})).toBe(false);
      expect(await repo.getOwned(target.owner,imported.operation.id)).toBeNull();expect(await repo.getOwned(target.owner,existing.operation.id)).not.toBeNull();
      expect((await pool.query('SELECT import_batch_id FROM comics WHERE id=$1',['import-collision'])).rows[0].import_batch_id).toBe(batch);
      expect((await pool.query('SELECT claimed_at FROM mcp_import_owners WHERE batch_id=$1 AND source_owner=$2',[batch,guest.owner])).rows[0].claimed_at).toBeNull();
      expect((await pool.query('SELECT count(*)::int AS n FROM operation_checkpoints WHERE operation_id=$1',[imported.operation.id])).rows[0].n).toBe(1);
    }finally{s.db.close();s.store.close();}
  });
});
