import {afterAll,beforeAll,beforeEach,describe,expect,test} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {Pool} from 'pg';
import {PostgresOperationRepository} from '../src/lib/operations/postgres';
import {runReconciliation} from '../scripts/reconcile-operation';
import {PostgresAuth} from '../src/lib/storage/auth';

const databaseUrl=process.env.TEST_DATABASE_URL;
const suite=databaseUrl?describe:describe.skip;
suite('operator reconciliation (Postgres)',()=>{
  const schema=`comex_reconcile_${randomUUID().replaceAll('-','')}`;
  let admin:Pool,pool:Pool,repo:PostgresOperationRepository;
  const owner='private-owner-identifier',prompt='private provider prompt',token='private-worker-token';
  beforeAll(async()=>{
    admin=new Pool({connectionString:databaseUrl});await admin.query(`CREATE SCHEMA "${schema}"`);
    pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,application_name:schema,max:8});
    // This private schema needs no global migration advisory lock, which would
    // serialize unrelated test schemas. Apply the actual migration files in order.
    for(const file of (await readdir('db/migrations')).filter(name=>/^\d+_[a-z0-9_]+\.sql$/.test(name)).sort())await pool.query(await readFile(`db/migrations/${file}`,'utf8'));
    repo=new PostgresOperationRepository(pool,{maxCalls:10,maxConcurrent:10});
  },30000);
  beforeEach(async()=>{
    await pool.query('TRUNCATE operation_checkpoints,operation_steps,operation_dispatch_intents,operations,comic_text_operations,comics,provider_reservations CASCADE');
  });
  afterAll(async()=>{
    await pool?.end();if(admin){await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
  },30000);
  async function unknown(stepId='panel/p1/image',release=true) {
    const comicId=randomUUID();await pool.query('INSERT INTO comics(id,owner,revision,draft) VALUES($1,$2,1,$3)',[comicId,owner,JSON.stringify({private:prompt})]);
    const operation=(await repo.start({owner,action:'generatePage',requestKey:randomUUID(),targetId:comicId,grantId:null,expectedVersions:1,input:{prompt}},async()=>{})).operation;
    const lease=(await repo.claimOperation(operation.id,300_000))!;
    await repo.claimPaidStep(lease,{id:stepId,input:{prompt}},async()=>{});
    await repo.completePaidStep(lease,stepId,'unknown',null);
    if(release)await repo.releaseUnknown(lease);
    return {operation,lease,comicId,stepId};
  }
  async function cli(...args:string[]) {
    const child=Bun.spawn([process.execPath,'scripts/reconcile-operation.ts',...args],{env:{...process.env,DATABASE_URL:databaseUrl,PGOPTIONS:`-c search_path=${schema}`},stdout:'pipe',stderr:'pipe'});
    const output=await new Response(child.stdout).text(),error=await new Response(child.stderr).text(),code=await child.exited;
    return {output,error,code};
  }
  async function state(operationId:string) {
    const op=(await pool.query('SELECT status FROM operations WHERE id=$1',[operationId])).rows[0];
    const steps=(await pool.query('SELECT s.step_id,s.state,r.state AS reservation FROM operation_steps s JOIN provider_reservations r ON r.id=s.reservation_id WHERE s.operation_id=$1 ORDER BY s.step_id',[operationId])).rows;
    const intent=(await pool.query('SELECT state FROM operation_dispatch_intents WHERE operation_id=$1',[operationId])).rows[0];
    const counts=(await pool.query("SELECT count(*)::int AS used,count(*) FILTER(WHERE state IN ('unknown','running'))::int AS active FROM provider_reservations")).rows[0];
    return {op,steps,intent,counts};
  }
  test('abandoning an unknown suggestion preserves uncertainty while allowing safe account handoff',async()=>{
    const auth=new PostgresAuth(pool),email=`${randomUUID()}@example.test`,guest=await auth.createGuest(email),comicId=randomUUID();
    await pool.query('INSERT INTO comics(id,owner,revision,draft) VALUES ($1,$2,1,$3)',[comicId,guest.owner,JSON.stringify({ownerId:guest.owner,initialSuggestions:'unknown',pages:[]})]);
    await pool.query("UPDATE comics SET edition=jsonb_build_object('editionId','original','sourceRevision',1),published_at=now() WHERE id=$1",[comicId]);
    const operation=(await repo.start({owner:guest.owner,action:'suggestCharacters',requestKey:randomUUID(),targetId:comicId,grantId:null,expectedVersions:1,input:{}},async()=>{})).operation;
    const lease=(await repo.claimOperation(operation.id,60_000))!;
    await repo.claimPaidStep(lease,{id:'suggestions',input:{}},async()=>{});await repo.completePaidStep(lease,'suggestions','unknown',null);await repo.releaseUnknown(lease);
    await pool.query("UPDATE operation_dispatch_intents SET state='delivered' WHERE operation_id=$1",[operation.id]);
    await pool.query("INSERT INTO comic_text_operations(comic_id,owner,state,operation_id) VALUES ($1,$2,'unknown',$3)",[comicId,guest.owner,operation.id]);
    const before=(await pool.query('SELECT revision,draft,edition,published_at FROM comics WHERE id=$1',[comicId])).rows[0];
    await runReconciliation(pool,['abandon-suggestions',operation.id,'--confirm']);
    expect((await pool.query('SELECT revision,draft,edition,published_at FROM comics WHERE id=$1',[comicId])).rows[0]).toEqual(before);
    expect((await pool.query('SELECT 1 FROM comic_text_operations WHERE comic_id=$1',[comicId])).rowCount).toBe(0);
    expect(await state(operation.id)).toMatchObject({op:{status:'unknown_outcome'},steps:[{state:'unknown',reservation:'unknown'}],intent:{state:'delivered'},counts:{used:1,active:1}});
    expect((await pool.query("SELECT 1 FROM operation_checkpoints WHERE operation_id=$1 AND checkpoint_key='operator/abandoned-unknown-suggestions'",[operation.id])).rowCount).toBe(1);
    await expect(repo.reconcileUnknown(operation.id,'suggestions','failed',null,async()=>{})).rejects.toThrow();
    expect(await repo.claimOperation(operation.id,1000)).toBeNull();
    expect(await repo.requeueIntent(operation.id)).toBe(false);
    await expect(repo.completePaidStep(lease,'suggestions','completed',{format:'json',value:{}})).rejects.toThrow();
    // Even an erroneous future status change must not redispatch abandoned work.
    await pool.query("UPDATE operations SET status='queued' WHERE id=$1",[operation.id]);
    expect(await repo.requeueIntent(operation.id)).toBe(false);
    expect(await repo.claimOperation(operation.id,1000)).toBeNull();
    expect(await repo.recoverStalled(10)).toEqual({requeued:0,unknown:0});
    await pool.query("UPDATE operations SET status='unknown_outcome' WHERE id=$1",[operation.id]);
    await auth.issueCode(email,'12345678',guest.token,'test-secret');
    const otherComic=randomUUID();await pool.query('INSERT INTO comics(id,owner,revision,draft) VALUES ($1,$2,1,$3)',[otherComic,guest.owner,JSON.stringify({ownerId:guest.owner,pages:[]})]);
    const other=(await repo.start({owner:guest.owner,action:'initialQuestions',requestKey:randomUUID(),targetId:otherComic,grantId:null,expectedVersions:1,input:{}},async()=>{})).operation;
    const otherLease=(await repo.claimOperation(other.id,60_000))!;
    await repo.claimPaidStep(otherLease,{id:'initial/questions',input:{}},async()=>{});await repo.completePaidStep(otherLease,'initial/questions','unknown',null);await repo.releaseUnknown(otherLease);
    await expect(auth.consumeCode(email,'12345678','test-secret',guest.token,guest.owner)).rejects.toThrow();
    await pool.query("UPDATE provider_reservations SET state='completed' WHERE id=(SELECT reservation_id FROM operation_steps WHERE operation_id=$1)",[other.id]);
    await pool.query("UPDATE operation_steps SET state='failed' WHERE operation_id=$1",[other.id]);
    await pool.query("UPDATE operations SET status='failed' WHERE id=$1",[other.id]);
    await pool.query("UPDATE comics SET draft=jsonb_set(draft,'{operations}', '{\"panel:old\":\"unknown_outcome\"}'::jsonb) WHERE id=$1",[otherComic]);
    await expect(auth.consumeCode(email,'12345678','test-secret',guest.token,guest.owner)).rejects.toThrow();
    await pool.query("UPDATE comics SET draft=jsonb_set(draft,'{operations}', '{}'::jsonb) WHERE id=$1",[otherComic]);
    const signed=await auth.consumeCode(email,'12345678','test-secret',guest.token,guest.owner);
    expect(signed).not.toBeNull();
    const account=await auth.authIdentity(signed!.session);expect(account).not.toBeNull();
    expect((await pool.query('SELECT owner FROM comics WHERE id=$1',[comicId])).rows[0].owner).toBe(account!.owner);
    expect((await pool.query('SELECT owner FROM operations WHERE id=$1',[operation.id])).rows[0].owner).toBe(account!.owner);
    expect(await state(operation.id)).toMatchObject({op:{status:'unknown_outcome'},steps:[{state:'unknown',reservation:'unknown'}]});
  },30_000);
  test('abandonment refuses mismatched or active state without changing the draft lock',async()=>{
    const comicId=randomUUID(),subject=randomUUID();
    await pool.query('INSERT INTO comics(id,owner,revision,draft) VALUES ($1,$2,1,$3)',[comicId,subject,JSON.stringify({ownerId:subject,initialSuggestions:'unknown',pages:[]})]);
    const op=(await repo.start({owner:subject,action:'suggestCharacters',requestKey:randomUUID(),targetId:comicId,grantId:null,expectedVersions:1,input:{}},async()=>{})).operation;
    const lease=(await repo.claimOperation(op.id,60_000))!;
    await repo.claimPaidStep(lease,{id:'suggestions',input:{}},async()=>{});await repo.completePaidStep(lease,'suggestions','unknown',null);await repo.releaseUnknown(lease);
    await pool.query("UPDATE operation_dispatch_intents SET state='delivered' WHERE operation_id=$1",[op.id]);
    await pool.query("INSERT INTO comic_text_operations(comic_id,owner,state,operation_id) VALUES ($1,$2,'unknown',$3)",[comicId,subject,op.id]);
    const attempt=()=>runReconciliation(pool,['abandon-suggestions',op.id,'--confirm']);
    const reject=async()=>{await expect(attempt()).rejects.toThrow();expect((await pool.query('SELECT 1 FROM comic_text_operations WHERE comic_id=$1',[comicId])).rowCount).toBe(1);expect((await pool.query('SELECT 1 FROM operation_checkpoints WHERE operation_id=$1',[op.id])).rowCount).toBe(0);};
    await pool.query("UPDATE operations SET lease_token='active',lease_until=$2 WHERE id=$1",[op.id,Date.now()+60000]);await reject();
    await pool.query('UPDATE operations SET lease_token=NULL,lease_until=NULL WHERE id=$1',[op.id]);
    await pool.query("UPDATE operation_dispatch_intents SET lease_token='active',lease_until=$2 WHERE operation_id=$1",[op.id,Date.now()+60000]);await reject();
    await pool.query('UPDATE operation_dispatch_intents SET lease_token=NULL,lease_until=NULL WHERE operation_id=$1',[op.id]);
    await pool.query("UPDATE operations SET action='initialQuestions' WHERE id=$1",[op.id]);await reject();
    await pool.query("UPDATE operations SET action='suggestCharacters' WHERE id=$1",[op.id]);
    await pool.query("UPDATE comics SET draft=jsonb_set(draft,'{initialSuggestions}',to_jsonb('complete'::text)) WHERE id=$1",[comicId]);await reject();
    await pool.query("UPDATE comics SET draft=jsonb_set(draft,'{initialSuggestions}',to_jsonb('unknown'::text)) WHERE id=$1",[comicId]);
    await pool.query("UPDATE comics SET owner='other-owner' WHERE id=$1",[comicId]);await reject();
    await pool.query('UPDATE comics SET owner=$2 WHERE id=$1',[comicId,subject]);
    await pool.query("UPDATE comic_text_operations SET operation_id=NULL WHERE comic_id=$1",[comicId]);await reject();
    await pool.query('UPDATE comic_text_operations SET operation_id=$2 WHERE comic_id=$1',[comicId,op.id]);
    await pool.query("UPDATE provider_reservations SET state='completed' WHERE id=(SELECT reservation_id FROM operation_steps WHERE operation_id=$1)",[op.id]);await reject();
    await pool.query("UPDATE provider_reservations SET state='unknown' WHERE id=(SELECT reservation_id FROM operation_steps WHERE operation_id=$1)",[op.id]);
    await pool.query("UPDATE operation_steps SET result_json='{\"retained\":true}' WHERE operation_id=$1",[op.id]);await reject();
    await pool.query("UPDATE operation_steps SET result_json='null' WHERE operation_id=$1",[op.id]);
    const extraReservation=randomUUID();await pool.query("INSERT INTO provider_reservations(id,state,created_at,updated_at) VALUES($1,'unknown','now','now')",[extraReservation]);
    await pool.query("INSERT INTO operation_steps(operation_id,step_id,input_digest,state,reservation_id) VALUES($1,'extra','digest','unknown',$2)",[op.id,extraReservation]);await reject();
    await pool.query("DELETE FROM operation_steps WHERE operation_id=$1 AND step_id='extra'",[op.id]);await pool.query('DELETE FROM provider_reservations WHERE id=$1',[extraReservation]);
    const other=(await repo.start({owner:subject,action:'update',requestKey:randomUUID(),targetId:comicId,grantId:null,expectedVersions:1,input:{}},async()=>{})).operation;
    await reject();await pool.query('DELETE FROM operation_dispatch_intents WHERE operation_id=$1',[other.id]);await pool.query('DELETE FROM operations WHERE id=$1',[other.id]);
    const attempts=await Promise.allSettled([attempt(),attempt()]);
    expect(attempts.filter(item=>item.status==='fulfilled')).toHaveLength(1);
    expect(attempts.filter(item=>item.status==='rejected')).toHaveLength(1);
    expect(await state(op.id)).toMatchObject({op:{status:'unknown_outcome'},steps:[{state:'unknown',reservation:'unknown'}]});
  },60_000);
  test('inspect reports unknown semantic kinds and reservation states without identifiers or prompt data',async()=>{
    const stepId=`panel/${owner}-${token}/image`,f=await unknown(stepId);
    const before=await state(f.operation.id),output=await runReconciliation(pool,['inspect',f.operation.id]),report=JSON.parse(output);
    expect(report.status).toBe('unknown_outcome');expect(report.activeWorker).toBe(false);
    expect(report.steps).toHaveLength(1);expect(report.steps[0]).toMatchObject({semanticStep:'panel/<id>/image',state:'unknown',reservationState:'unknown'});
    expect(report.steps[0].stepId).toMatch(/^step-[a-f0-9]{64}$/);
    for(const secret of [owner,token,prompt,stepId,f.operation.id])expect(output).not.toContain(secret);
    expect(await state(f.operation.id)).toEqual(before);
  });
  test('explicit confirmed failure retains the charge, queues the intent, and replays as failed without dispatch',async()=>{
    const f=await unknown(),inspection=await cli('inspect',f.operation.id);expect(inspection.code).toBe(0);expect(inspection.error).toBe('');const report=JSON.parse(inspection.output);
    await expect(runReconciliation(pool,['resolve-failed',f.operation.id,report.steps[0].stepId])).rejects.toThrow();
    const resolution=await cli('resolve-failed',f.operation.id,report.steps[0].stepId,'--confirm');expect(resolution.code).toBe(0);expect(resolution.error).toBe('');
    for(const secret of [owner,prompt,token,f.operation.id])expect(inspection.output+resolution.output).not.toContain(secret);
    expect(await state(f.operation.id)).toMatchObject({op:{status:'queued'},steps:[{state:'failed',reservation:'completed'}],intent:{state:'pending'},counts:{used:1,active:0}});
    const lease=(await repo.claimOperation(f.operation.id,300_000))!;
    expect(await repo.claimPaidStep(lease,{id:f.stepId,input:{prompt}},async()=>{throw new Error('must not dispatch');})).toMatchObject({kind:'failed'});
    expect((await state(f.operation.id)).counts).toEqual({used:1,active:0});
  });
  test('refuses a still active worker and a wrong or absent unknown step',async()=>{
    const f=await unknown('initial/questions',false),selector=JSON.parse(await runReconciliation(pool,['inspect',f.operation.id])).steps[0].stepId;
    await expect(runReconciliation(pool,['resolve-failed',f.operation.id,selector,'--confirm'])).rejects.toThrow();
    expect(await state(f.operation.id)).toMatchObject({op:{status:'unknown_outcome'},steps:[{state:'unknown',reservation:'unknown'}],counts:{used:1,active:1}});
    await repo.releaseUnknown(f.lease);
    await expect(runReconciliation(pool,['resolve-failed',f.operation.id,'missing/step','--confirm'])).rejects.toThrow();
    await pool.query("UPDATE operations SET status='failed' WHERE id=$1",[f.operation.id]);
    await expect(runReconciliation(pool,['resolve-failed',f.operation.id,selector,'--confirm'])).rejects.toThrow();
    expect((await state(f.operation.id)).steps[0].state).toBe('unknown');
  });
  test('concurrent resolutions commit once and preserve the single charge',async()=>{
    const f=await unknown(),selector=JSON.parse(await runReconciliation(pool,['inspect',f.operation.id])).steps[0].stepId;
    const attempts=await Promise.allSettled([runReconciliation(pool,['resolve-failed',f.operation.id,selector,'--confirm']),runReconciliation(pool,['resolve-failed',f.operation.id,selector,'--confirm'])]);
    expect(attempts.filter(item=>item.status==='fulfilled')).toHaveLength(1);expect(attempts.filter(item=>item.status==='rejected')).toHaveLength(1);
    expect(await state(f.operation.id)).toMatchObject({op:{status:'queued'},steps:[{state:'failed',reservation:'completed'}],counts:{used:1,active:0}});
  });
  test('an operation with no unknown step stays blocked without fabricated evidence',async()=>{
    const f=await unknown();await pool.query("UPDATE operation_steps SET state='failed' WHERE operation_id=$1",[f.operation.id]);
    const report=JSON.parse(await runReconciliation(pool,['inspect',f.operation.id]));expect(report.steps).toEqual([]);expect(report.status).toBe('unknown_outcome');
    await expect(runReconciliation(pool,['resolve-failed',f.operation.id,f.stepId,'--confirm'])).rejects.toThrow();
    expect(await state(f.operation.id)).toMatchObject({op:{status:'unknown_outcome'},counts:{used:1,active:1}});
  });
  test('the operation remains blocked until every unknown step has been resolved',async()=>{
    const comicId=randomUUID();await pool.query('INSERT INTO comics(id,owner,revision,draft) VALUES($1,$2,1,$3)',[comicId,owner,JSON.stringify({private:prompt})]);
    const operation=(await repo.start({owner,action:'generatePage',requestKey:randomUUID(),targetId:comicId,grantId:null,expectedVersions:1,input:{prompt}},async()=>{})).operation;
    const lease=(await repo.claimOperation(operation.id,300_000))!,f={operation};
    await repo.claimPaidStep(lease,{id:'panel/p1/image',input:{prompt}},async()=>{});
    await repo.claimPaidStep(lease,{id:'panel/p2/image',input:{prompt}},async()=>{});
    await repo.completePaidStep(lease,'panel/p1/image','unknown',null);await repo.releaseUnknown(lease);
    const report=JSON.parse(await runReconciliation(pool,['inspect',f.operation.id]));expect(report.steps).toHaveLength(2);
    await runReconciliation(pool,['resolve-failed',f.operation.id,report.steps[0].stepId,'--confirm']);
    expect((await state(f.operation.id)).op.status).toBe('unknown_outcome');expect(await repo.claimOperation(f.operation.id,1000)).toBeNull();
    await runReconciliation(pool,['resolve-failed',f.operation.id,report.steps[1].stepId,'--confirm']);
    expect(await state(f.operation.id)).toMatchObject({op:{status:'queued'},counts:{used:2,active:0}});
  });
  test('owner mismatch and inconsistent reservation roll back without changing the operation',async()=>{
    const f=await unknown(),selector=JSON.parse(await runReconciliation(pool,['inspect',f.operation.id])).steps[0].stepId;
    await pool.query('UPDATE comics SET owner=$2 WHERE id=$1',[f.comicId,'other-owner']);
    await expect(runReconciliation(pool,['resolve-failed',f.operation.id,selector,'--confirm'])).rejects.toThrow();
    expect((await state(f.operation.id)).steps[0]).toMatchObject({state:'unknown',reservation:'unknown'});
    await pool.query('UPDATE comics SET owner=$2 WHERE id=$1',[f.comicId,owner]);
    await pool.query("UPDATE provider_reservations SET state='completed' WHERE id=(SELECT reservation_id FROM operation_steps WHERE operation_id=$1)",[f.operation.id]);
    await expect(runReconciliation(pool,['resolve-failed',f.operation.id,selector,'--confirm'])).rejects.toThrow();
    expect(await state(f.operation.id)).toMatchObject({op:{status:'unknown_outcome'},steps:[{state:'unknown',reservation:'completed'}],counts:{used:1,active:0}});
  });
  test('locks the comic before the operation so ownership handoff cannot deadlock',async()=>{
    const f=await unknown(),selector=JSON.parse(await runReconciliation(pool,['inspect',f.operation.id])).steps[0].stepId;
    const first=await pool.connect(),probe=await pool.connect();
    try{
      await first.query('BEGIN');await first.query('SELECT id FROM comics WHERE id=$1 FOR UPDATE',[f.comicId]);
      const pending=runReconciliation(pool,['resolve-failed',f.operation.id,selector,'--confirm']);
      let blocked=false;
      for(let n=0;n<100&&!blocked;n++){
        const waiting=await probe.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE '%comics%FOR UPDATE%'",[schema]);
        blocked=!!waiting.rowCount;if(!blocked)await new Promise(resolve=>setTimeout(resolve,10));
      }
      expect(blocked).toBe(true);
      await probe.query('BEGIN');await probe.query('SELECT id FROM operations WHERE id=$1 FOR UPDATE NOWAIT',[f.operation.id]);await probe.query('COMMIT');
      await first.query('COMMIT');await pending;expect((await state(f.operation.id)).op.status).toBe('queued');
    }finally{await first.query('ROLLBACK').catch(()=>{});await probe.query('ROLLBACK').catch(()=>{});first.release();probe.release();}
  });
  test('CLI errors do not disclose credentials or supplied identifiers',async()=>{
    const child=Bun.spawn([process.execPath,'scripts/reconcile-operation.ts','inspect',token],{env:{...process.env,DATABASE_URL:'postgresql://secret-user:secret-password@127.0.0.1:1/secret-db'},stdout:'pipe',stderr:'pipe'});
    const out=await new Response(child.stdout).text(),err=await new Response(child.stderr).text();expect(await child.exited).not.toBe(0);
    for(const secret of ['secret-user','secret-password','secret-db',token])expect(out+err).not.toContain(secret);
  });
});
