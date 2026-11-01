import {afterAll,beforeAll,describe,expect,test} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Pool} from 'pg';
import {ProviderBudget} from '../src/lib/budget';
import {applyMigrations,PostgresProviderBudget} from '../src/lib/storage/postgres';
import {SqliteOperationRepository,initializeSqliteOperations} from '../src/lib/operations/sqlite';
import {PostgresOperationRepository} from '../src/lib/operations/postgres';
import type {OperationRepository} from '../src/lib/operations/contracts';

type Harness={repo:OperationRepository<any>;other:OperationRepository<any>;allow:(tx:any, context:any)=>any;deny:(tx:any, context:any)=>any;expire:(table:'operation'|'intent',id:string)=>Promise<void>;counts:()=>Promise<{used:number;active:number;unknown:number}>;apply:(tx:any, context:any)=>any;readApplied:()=>Promise<number>;guardActive:(tx:any,context:any)=>any;revoke:()=>Promise<void>;reserveLegacy:()=>Promise<string>;finishLegacy:(id:string)=>Promise<void>;close:()=>Promise<void>};
const input=(key:string,owner='alice')=>({owner,action:'generate_page',requestKey:key,targetId:'comic',grantId:'grant',expectedVersions:{revision:1},input:{page:'page-1'}});

function contracts(make:(maxCalls?:number,maxConcurrent?:number)=>Promise<Harness>) {
  test('concurrent duplicate starts return one operation and one durable dispatch intent',async()=>{
    const h=await make();try {
      let creates=0;const guard=(tx:any,context:any)=>{if(context.phase==='create')creates++;return h.allow(tx,context);};
      const starts=await Promise.all(Array.from({length:12},(_,i)=>(i%2?h.repo:h.other).start(input('same'),guard)));
      expect(creates).toBe(1);
      expect(new Set(starts.map(x=>x.operation.id)).size).toBe(1);
      expect(starts.filter(x=>x.created)).toHaveLength(1);
      const id=starts[0].operation.id;
      expect(await h.repo.getOwned('bob',id)).toBeNull();
      expect(await h.repo.getOwned('alice',id)).toMatchObject({id,owner:'alice',status:'queued'});
      await expect(Promise.resolve().then(()=>h.repo.start({...input('same'),input:{page:'page-2'}},h.allow))).rejects.toMatchObject({code:'idempotency_conflict'});
      const different=await h.repo.start(input('same','bob'),h.allow);expect(different.operation.id).not.toBe(id);
      const first=await h.repo.claimIntent(300_000);const second=await h.other.claimIntent(300_000);
      expect(new Set([first!.operationId,second!.operationId])).toEqual(new Set([id,different.operation.id]));
      expect(await h.repo.claimIntent(300_000)).toBeNull();
    } finally {await h.close();}
  });
  test('policy rejection rolls back operation and dispatch intent; checks also run on idempotent reads',async()=>{
    const h=await make();try {
      await expect(Promise.resolve().then(()=>h.repo.start(input('denied'),h.deny))).rejects.toThrow('policy denied');
      expect(await h.repo.claimIntent(300_000)).toBeNull();
      const started=await h.repo.start(input('denied'),h.allow);expect(started.created).toBe(true);
      await expect(Promise.resolve().then(()=>h.other.start(input('denied'),h.deny))).rejects.toThrow('policy denied');
    } finally {await h.close();}
  });
  test('policy callbacks cannot mutate the input that an idempotency digest binds',async()=>{
    const h=await make();try {
      const request=input('immutable');
      const operation=(await h.repo.start(request,(_tx:any,context:any)=>{context.operation.input.page='changed';})).operation;
      expect(request.input.page).toBe('page-1');
      expect((await h.repo.getOwned('alice',operation.id))?.input).toEqual({page:'page-1'});
      expect((await h.repo.start(input('immutable'),h.allow)).created).toBe(false);
      const lease=(await h.repo.claimOperation(operation.id,300_000))!,step={id:'question',input:{prompt:'A'}};
      await h.repo.claimPaidStep(lease,step,(_tx:any,context:any)=>{context.stepInput.prompt='B';});
      expect(step.input.prompt).toBe('A');
      expect((await h.repo.claimPaidStep(lease,{id:'question',input:{prompt:'A'}},h.allow)).kind).toBe('running');
    } finally {await h.close();}
  });
  test('intent leases are redeliverable and stale acknowledgements cannot fence a newer delivery',async()=>{
    const h=await make();try {
      const {operation}=await h.repo.start(input('intent'),h.allow);
      const a=(await h.repo.claimIntent(300_000))!;expect(a.operationId).toBe(operation.id);
      await h.expire('intent',operation.id);
      const b=(await h.other.claimIntent(300_000))!;expect(b.token).not.toBe(a.token);
      expect(await h.repo.ackIntent(a,'lost-run')).toBe(false);
      expect(await h.other.releaseIntent(b)).toBe(true);
      const c=(await h.repo.claimIntent(300_000))!;
      expect(await h.repo.ackIntent(c,'run-1')).toBe(true);
      expect(await h.repo.claimIntent(300_000)).toBeNull();
      expect(await h.repo.requeueIntent(operation.id)).toBe(true);
      expect((await h.other.claimIntent(300_000))?.operationId).toBe(operation.id);
    } finally {await h.close();}
  });
  test('expired workers are fenced, and replay of a possibly dispatched step becomes unknown',async()=>{
    const h=await make();try {
      const {operation}=await h.repo.start(input('lost'),h.allow);
      const first=(await h.repo.claimOperation(operation.id,300_000))!;
      const step=await h.repo.claimPaidStep(first,{id:'panel/p1/image',input:{prompt:'one'}},h.allow);
      expect(step.kind).toBe('claimed');
      expect((await h.repo.claimPaidStep(first,{id:'panel/p1/image',input:{prompt:'one'}},h.allow)).kind).toBe('running');
      await h.expire('operation',operation.id);
      expect(await h.other.claimOperation(operation.id,300_000)).toBeNull();
      expect(await h.repo.getOwned('alice',operation.id)).toMatchObject({status:'unknown_outcome'});
      expect(await h.repo.getStep('alice',operation.id,'panel/p1/image')).toMatchObject({state:'unknown'});
      expect(await h.repo.getStep('bob',operation.id,'panel/p1/image')).toBeNull();
      expect(await h.counts()).toEqual({used:1,active:1,unknown:1});
      await expect(Promise.resolve().then(()=>h.repo.completePaidStep(first,'panel/p1/image','completed',{asset:'late'}))).rejects.toMatchObject({code:'lease_lost'});
      expect(await h.other.claimOperation(operation.id,300_000)).toBeNull();
    } finally {await h.close();}
  });
  test('an expired worker without a dispatched step can resume but cannot write with the old fence',async()=>{
    const h=await make();try {
      const {operation}=await h.repo.start(input('lease'),h.allow),a=(await h.repo.claimOperation(operation.id,300_000))!;
      await h.expire('operation',operation.id);
      const b=(await h.other.claimOperation(operation.id,300_000))!;
      expect(b.fence).toBeGreaterThan(a.fence);
      await expect(Promise.resolve().then(()=>h.repo.claimPaidStep(a,{id:'question',input:{}},h.allow))).rejects.toMatchObject({code:'lease_lost'});
      expect((await h.other.claimPaidStep(b,{id:'question',input:{}},h.allow)).kind).toBe('claimed');
    } finally {await h.close();}
  });
  test('completed semantic steps and checkpoints survive replay and changed step input conflicts',async()=>{
    const h=await make();try {
      const {operation}=await h.repo.start(input('checkpoint'),h.allow),a=(await h.repo.claimOperation(operation.id,300_000))!;
      expect((await h.repo.claimPaidStep(a,{id:'story/plan',input:{plot:'A'}},h.allow)).kind).toBe('claimed');
      await h.repo.completePaidStep(a,'story/plan','completed',{story:'saved'});
      await h.repo.commitCheckpoint(a,'story/applied',{revision:2},h.allow);
      await h.expire('operation',operation.id);const b=(await h.other.claimOperation(operation.id,300_000))!;
      expect(await h.other.claimPaidStep(b,{id:'story/plan',input:{plot:'A'}},h.allow)).toMatchObject({kind:'completed',result:{story:'saved'}});
      await expect(Promise.resolve().then(()=>h.other.claimPaidStep(b,{id:'story/plan',input:{plot:'B'}},h.allow))).rejects.toMatchObject({code:'step_conflict'});
      expect(await h.other.getCheckpoint('alice',operation.id,'story/applied')).toEqual({revision:2});
      expect(await h.other.getCheckpoint('bob',operation.id,'story/applied')).toBeNull();
      expect(await h.counts()).toEqual({used:1,active:0,unknown:0});
    } finally {await h.close();}
  });
  test('checkpoint application and its marker commit or roll back together',async()=>{
    const h=await make();try {
      const {operation}=await h.repo.start(input('atomic-checkpoint'),h.allow),lease=(await h.repo.claimOperation(operation.id,300_000))!;
      await expect(Promise.resolve().then(()=>h.repo.commitCheckpoint(lease,'apply',{revision:2},(tx:any,context:any)=>{
        const result=h.apply(tx,context);
        if(result && typeof result.then==='function') return result.then(()=>{throw new Error('failure after mutation');});
        throw new Error('failure after mutation');
      }))).rejects.toThrow('failure after mutation');
      expect(await h.readApplied()).toBe(0);expect(await h.repo.getCheckpoint('alice',operation.id,'apply')).toBeNull();
      await h.repo.commitCheckpoint(lease,'apply',{revision:2},h.apply);
      await h.other.commitCheckpoint(lease,'apply',{revision:2},h.apply);
      expect(await h.readApplied()).toBe(1);expect(await h.other.getCheckpoint('alice',operation.id,'apply')).toEqual({revision:2});
      await expect(Promise.resolve().then(()=>h.repo.commitCheckpoint(lease,'apply',{revision:3},h.apply))).rejects.toMatchObject({code:'checkpoint_conflict'});
      expect(await h.readApplied()).toBe(1);
    } finally {await h.close();}
  });
  test('independent workers cannot exceed a shared cumulative cap',async()=>{
    const h=await make();try {
      const operations=await Promise.all(Array.from({length:8},(_,i)=>h.repo.start(input(`parallel-${i}`),h.allow)));
      const leases=await Promise.all(operations.map(x=>h.repo.claimOperation(x.operation.id,300_000)));
      const attempts=await Promise.allSettled(leases.map((lease,i)=>Promise.resolve().then(()=>(i%2?h.repo:h.other).claimPaidStep(lease!,{id:'image',input:{i}},h.allow))));
      expect(attempts.filter(x=>x.status==='fulfilled')).toHaveLength(1);
      expect(attempts.filter(x=>x.status==='rejected'&&(x.reason as {code:string}).code==='budget_exhausted')).toHaveLength(7);
      expect(await h.counts()).toEqual({used:1,active:1,unknown:0});
    } finally {await h.close();}
  });
  test('an explicitly investigated unknown can be checkpointed without repeating the paid step',async()=>{
    const h=await make();try {
      const {operation}=await h.repo.start(input('recover'),h.allow),lease=(await h.repo.claimOperation(operation.id,300_000))!;
      await h.repo.claimPaidStep(lease,{id:'image',input:{page:1}},h.allow);
      await h.repo.completePaidStep(lease,'image','unknown',null);
      expect(await h.repo.getOwned('alice',operation.id)).toMatchObject({status:'unknown_outcome'});
      await expect(Promise.resolve().then(()=>h.repo.reconcileUnknown(operation.id,'image','completed',{asset:'found'},h.deny))).rejects.toThrow('policy denied');
      expect(await h.counts()).toEqual({used:1,active:1,unknown:1});
      await h.repo.reconcileUnknown(operation.id,'image','completed',{asset:'found'},h.allow);
      expect(await h.counts()).toEqual({used:1,active:0,unknown:0});
      const next=(await h.repo.claimOperation(operation.id,300_000))!;
      expect(await h.repo.claimPaidStep(next,{id:'image',input:{page:1}},h.allow)).toMatchObject({kind:'completed',result:{asset:'found'}});
      expect((await h.repo.claimIntent(300_000))?.operationId).toBe(operation.id);
    } finally {await h.close();}
  });
  test('grant policy is rechecked before each new paid step',async()=>{
    const h=await make(2);try {
      const {operation}=await h.repo.start(input('revoked'),h.allow),lease=(await h.repo.claimOperation(operation.id,300_000))!;
      await h.repo.claimPaidStep(lease,{id:'first',input:{}},h.guardActive);
      await h.repo.completePaidStep(lease,'first','completed',{text:'kept'});
      await h.revoke();
      await expect(Promise.resolve().then(()=>h.repo.claimPaidStep(lease,{id:'second',input:{}},h.guardActive))).rejects.toThrow('grant revoked');
      expect(await h.repo.getStep('alice',operation.id,'first')).toMatchObject({state:'completed',result:{text:'kept'}});
      expect(await h.repo.getStep('alice',operation.id,'second')).toBeNull();expect(await h.counts()).toEqual({used:1,active:0,unknown:0});
    } finally {await h.close();}
  });
  test('existing provider reservations share the same concurrency cap',async()=>{
    const h=await make(3,1);try {
      const existing=await h.reserveLegacy();
      const {operation}=await h.repo.start(input('legacy-budget'),h.allow),lease=(await h.repo.claimOperation(operation.id,300_000))!;
      await expect(Promise.resolve().then(()=>h.repo.claimPaidStep(lease,{id:'step',input:{}},h.allow))).rejects.toMatchObject({code:'concurrency_limit'});
      expect(await h.repo.getStep('alice',operation.id,'step')).toBeNull();
      await h.finishLegacy(existing);
      expect((await h.repo.claimPaidStep(lease,{id:'step',input:{}},h.allow)).kind).toBe('claimed');
      expect(await h.counts()).toEqual({used:2,active:1,unknown:0});
    } finally {await h.close();}
  });
  test('an unknown step fences every other in-flight step and all must be reconciled',async()=>{
    const h=await make(3);try {
      const {operation}=await h.repo.start(input('parallel-unknown'),h.allow),lease=(await h.repo.claimOperation(operation.id,300_000))!;
      await h.repo.claimPaidStep(lease,{id:'first',input:{}},h.allow);
      await h.repo.claimPaidStep(lease,{id:'second',input:{}},h.allow);
      await h.repo.completePaidStep(lease,'first','unknown',null);
      expect(await h.counts()).toEqual({used:2,active:2,unknown:2});
      expect(await h.repo.getStep('alice',operation.id,'second')).toMatchObject({state:'unknown'});
      await h.repo.reconcileUnknown(operation.id,'first','completed',{found:1},h.allow);
      expect(await h.repo.getOwned('alice',operation.id)).toMatchObject({status:'unknown_outcome'});
      expect(await h.repo.claimOperation(operation.id,300_000)).toBeNull();
      await h.repo.reconcileUnknown(operation.id,'second','completed',{found:2},h.allow);
      expect(await h.repo.getOwned('alice',operation.id)).toMatchObject({status:'queued'});
      expect(await h.counts()).toEqual({used:2,active:0,unknown:0});
    } finally {await h.close();}
  });
  test('budget cap and policy checks roll back the entire step claim',async()=>{
    const h=await make();try {
      const {operation}=await h.repo.start(input('cap'),h.allow),a=(await h.repo.claimOperation(operation.id,300_000))!;
      await expect(Promise.resolve().then(()=>h.repo.claimPaidStep(a,{id:'denied',input:{}},h.deny))).rejects.toThrow('policy denied');
      expect(await h.repo.getStep('alice',operation.id,'denied')).toBeNull();expect(await h.counts()).toEqual({used:0,active:0,unknown:0});
      expect((await h.repo.claimPaidStep(a,{id:'first',input:{}},h.allow)).kind).toBe('claimed');
      await expect(Promise.resolve().then(()=>h.repo.claimPaidStep(a,{id:'second',input:{}},h.allow))).rejects.toMatchObject({code:'budget_exhausted'});
      expect(await h.repo.getStep('alice',operation.id,'second')).toBeNull();
      expect(await h.counts()).toEqual({used:1,active:1,unknown:0});
    } finally {await h.close();}
  });
}

describe('SQLite operations contract',()=>{
  contracts(async(maxCalls=1,maxConcurrent=maxCalls)=>{
    const dir=mkdtempSync(join(tmpdir(),'comex-operations-')),path=join(dir,'test.sqlite');
    const budget=new ProviderBudget(path,{maxCalls:1,maxConcurrent:1});budget.close();
    const a=new DatabaseSync(path),b=new DatabaseSync(path);a.exec('PRAGMA busy_timeout=5000');b.exec('PRAGMA busy_timeout=5000');
    initializeSqliteOperations(a);a.exec('CREATE TABLE test_application (value INTEGER NOT NULL); INSERT INTO test_application VALUES (0)');
    const repo=new SqliteOperationRepository(a,{maxCalls,maxConcurrent}),other=new SqliteOperationRepository(b,{maxCalls,maxConcurrent});
    return {repo,other,allow:()=>{},deny:()=>{throw new Error('policy denied');},
      apply:(tx:DatabaseSync)=>{tx.exec('UPDATE test_application SET value=value+1');},readApplied:async()=>Number((a.prepare('SELECT value FROM test_application').get() as {value:number}).value),
      guardActive:(tx:DatabaseSync)=>{if(Number((tx.prepare('SELECT value FROM test_application').get() as {value:number}).value))throw new Error('grant revoked');},revoke:async()=>{a.exec('UPDATE test_application SET value=1');},
      reserveLegacy:async()=>{const x=new ProviderBudget(path,{maxCalls,maxConcurrent});try{return x.reserve();}finally{x.close();}},finishLegacy:async(id:string)=>{const x=new ProviderBudget(path,{maxCalls,maxConcurrent});try{x.finish(id,'completed');}finally{x.close();}},
      expire:async(table,id)=>{a.prepare(`UPDATE ${table==='operation'?'operations':'operation_dispatch_intents'} SET lease_until=0 WHERE ${table==='operation'?'id':'operation_id'}=?`).run(id);},
      counts:async()=>{const x=new ProviderBudget(path,{maxCalls:1,maxConcurrent:1});try{return x.summary();}finally{x.close();}},
      close:async()=>{a.close();b.close();rmSync(dir,{recursive:true,force:true});}};
  });
  test('rejects asynchronous SQLite transaction policies before their body can escape rollback',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'comex-ops-policy-')),path=join(dir,'test.sqlite');
    const budget=new ProviderBudget(path,{maxCalls:1,maxConcurrent:1});budget.close();
    const db=new DatabaseSync(path);initializeSqliteOperations(db);db.exec('CREATE TABLE policy_test (n INTEGER);INSERT INTO policy_test VALUES (0)');
    let entered=false;
    try {
      const repo=new SqliteOperationRepository(db,{maxCalls:1,maxConcurrent:1});
      await expect(Promise.resolve().then(()=>repo.start(input('async-policy'),async tx=>{entered=true;await Promise.resolve();tx.exec('UPDATE policy_test SET n=1');}))).rejects.toThrow('must be synchronous');
      await Promise.resolve();
      expect(entered).toBe(false);expect((db.prepare('SELECT n FROM policy_test').get() as {n:number}).n).toBe(0);
      const hiddenAsync=async(tx:DatabaseSync)=>{await Promise.resolve();tx.exec('UPDATE policy_test SET n=1');};
      await expect(Promise.resolve().then(()=>repo.start(input('wrapped-async-policy'),tx=>hiddenAsync(tx)))).rejects.toThrow('must be synchronous');
      await Promise.resolve();expect((db.prepare('SELECT n FROM policy_test').get() as {n:number}).n).toBe(0);
    } finally {db.close();rmSync(dir,{recursive:true,force:true});}
  });

});

const postgresDescribe=process.env.TEST_DATABASE_URL?describe:describe.skip;
postgresDescribe('Postgres operations contract',()=>{
  const schema=`comex_ops_${randomUUID().replaceAll('-','')}`;let admin:Pool,pool:Pool,other:Pool;
  beforeAll(async()=>{admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});await admin.query(`CREATE SCHEMA "${schema}"`);pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});other=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});await applyMigrations(pool);});
  afterAll(async()=>{await pool?.end();await other?.end();if(admin){await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}});
  contracts(async(maxCalls=1,maxConcurrent=maxCalls)=>{
    await pool.query('TRUNCATE operation_checkpoints,operation_steps,operation_dispatch_intents,operations,provider_reservations');
    await pool.query('CREATE TABLE IF NOT EXISTS test_application (value integer NOT NULL)');await pool.query('TRUNCATE test_application');await pool.query('INSERT INTO test_application VALUES (0)');
    const repo=new PostgresOperationRepository(pool,{maxCalls,maxConcurrent}),second=new PostgresOperationRepository(other,{maxCalls,maxConcurrent});
    return {repo,other:second,allow:async()=>{},deny:async()=>{throw new Error('policy denied');},
      apply:async(tx:any)=>{await tx.query('UPDATE test_application SET value=value+1');},readApplied:async()=>(await pool.query('SELECT value FROM test_application')).rows[0].value,
      guardActive:async(tx:any)=>{if((await tx.query('SELECT value FROM test_application FOR UPDATE')).rows[0].value)throw new Error('grant revoked');},revoke:async()=>{await pool.query('UPDATE test_application SET value=1');},
      reserveLegacy:async()=>new PostgresProviderBudget(pool,{maxCalls,maxConcurrent}).reserve(),finishLegacy:async(id:string)=>new PostgresProviderBudget(pool,{maxCalls,maxConcurrent}).finish(id,'completed'),
      expire:async(table,id)=>{await pool.query(`UPDATE ${table==='operation'?'operations':'operation_dispatch_intents'} SET lease_until=0 WHERE ${table==='operation'?'id':'operation_id'}=$1`,[id]);},
      counts:async()=>{const r=(await pool.query("SELECT count(*)::int used,count(*) FILTER (WHERE state IN ('running','unknown'))::int active,count(*) FILTER (WHERE state='unknown')::int unknown FROM provider_reservations")).rows[0];return r;},
      close:async()=>{}};
  });
  test('Postgres grant row lock is held through the reservation transaction',async()=>{
    await pool.query('TRUNCATE operation_checkpoints,operation_steps,operation_dispatch_intents,operations,provider_reservations');
    await pool.query('CREATE TABLE IF NOT EXISTS test_grant_lock (revoked integer NOT NULL)');
    await pool.query('TRUNCATE test_grant_lock');await pool.query('INSERT INTO test_grant_lock VALUES (0)');
    const repo=new PostgresOperationRepository(pool,{maxCalls:3,maxConcurrent:1});
    const {operation}=await repo.start(input('grant-lock'),async()=>{}),lease=(await repo.claimOperation(operation.id,300_000))!;
    let ready!:()=>void, release!:()=>void;
    const locked=new Promise<void>(resolve=>{ready=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
    const claim=repo.claimPaidStep(lease,{id:'first',input:{}},async tx=>{
      const row=(await tx.query('SELECT revoked FROM test_grant_lock FOR UPDATE')).rows[0];
      if(row.revoked)throw new Error('grant revoked');ready();await gate;
    });
    await locked;
    let revoked=false;
    const revoke=other.query('UPDATE test_grant_lock SET revoked=1').then(()=>{revoked=true;});
    try {await new Promise(resolve=>setTimeout(resolve,50));expect(revoked).toBe(false);} finally {release();}
    expect((await claim).kind).toBe('claimed');await revoke;expect(revoked).toBe(true);
    expect((await pool.query('SELECT count(*)::int AS count FROM provider_reservations')).rows[0].count).toBe(1);
  },120000);

});
