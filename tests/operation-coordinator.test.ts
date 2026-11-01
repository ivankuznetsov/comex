import {afterAll,beforeAll,expect,test} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {applyMigrations} from '../src/lib/storage/postgres';
import {PostgresOperationRepository} from '../src/lib/operations/postgres';
import {PostgresOperationCoordinator} from '../src/lib/operations/coordinator';
import {redeliverPending} from '../src/lib/operations/redelivery';

const pgTest=process.env.TEST_DATABASE_URL?test:test.skip;
const schema=`comex_exec_${randomUUID().replaceAll('-','')}`;
let admin:Pool,pool:Pool,repo:PostgresOperationRepository,coordinator:PostgresOperationCoordinator;
beforeAll(async()=>{
  if(!process.env.TEST_DATABASE_URL)return;
  admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});await admin.query(`CREATE SCHEMA "${schema}"`);
  pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});await applyMigrations(pool);
  repo=new PostgresOperationRepository(pool,{maxCalls:5,maxConcurrent:1});coordinator=new PostgresOperationCoordinator(pool,repo);
  await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified") VALUES ('user','User','user@example.test',true)`);
  await pool.query(`INSERT INTO "session"(id,token,"userId","expiresAt","updatedAt") VALUES ('session','token','user',now()+interval '1 hour',now())`);
  await pool.query("INSERT INTO mcp_grants(id,owner,client_id,session_id,user_id,client_name,created_at) VALUES ('grant','owner','client','session','user','Client',1)");
});
afterAll(async()=>{await pool?.end();if(admin){await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}});
const identity={actor:'owner',grantId:'grant',scopes:['comex:read','comex:write','comex:generate','comex:publish'] as const};
const draft={id:'comic',ownerId:'owner',storyRevision:1,pages:[{id:'page',panels:[{id:'p1',status:'planned',revision:1,storyRevision:1}]}]};

pgTest('enqueue locks ownership and version, keeps one ticket on lost response and validates page intent',async()=>{
  await pool.query("INSERT INTO comics(id,owner,revision,draft) VALUES ('comic','owner',1,$1)",[JSON.stringify(draft)]);
  const args={identity,action:'generatePage' as const,requestKey:'page-request',comicId:'comic',expectedRevision:1,input:{pageId:'page',intent:'generate'}};
  const ticket=await coordinator.enqueue(args);expect(ticket).toMatchObject({status:'queued',comicId:'comic'});
  await pool.query("UPDATE comics SET revision=2 WHERE id='comic'");
  expect((await coordinator.enqueue(args)).id).toBe(ticket.id);
  await expect(coordinator.enqueue({...args,input:{pageId:'page',intent:'regenerate'}})).rejects.toMatchObject({code:'idempotency_conflict'});
  await expect(coordinator.enqueue({...args,requestKey:'new',expectedRevision:1})).rejects.toMatchObject({code:'conflict'});
  await expect(coordinator.enqueue({...args,requestKey:'regenerate',expectedRevision:2,input:{pageId:'page',intent:'regenerate'}})).rejects.toMatchObject({code:'conflict'});
  await expect(coordinator.enqueue({...args,requestKey:'wrong-owner',identity:{...identity,actor:'intruder'}})).rejects.toMatchObject({code:'not_found'});
});

pgTest('creation records a stable operation without creating a duplicate draft at enqueue',async()=>{
  const req={identity,action:'create' as const,requestKey:'create-key',input:{title:'Test',plot:'A story',style:'ink-manga'}};
  const first=await coordinator.enqueue(req),second=await coordinator.enqueue(req);
  expect(first.id).toBe(second.id);
  expect((await pool.query("SELECT count(*)::int AS n FROM comics WHERE owner='owner'")).rows[0].n).toBe(1);
});

pgTest('redelivery only acknowledges an accepted workflow start and retries a lost start independently',async()=>{
  const req={identity,action:'create' as const,requestKey:'redelivery-key',input:{title:'Draft',plot:'Story',style:'ink-manga'}};
  const ticket=await coordinator.enqueue(req);let attempts=0;
  const error=await redeliverPending(repo,async()=>{attempts++;throw new Error('lost acknowledgment');},{limit:10,leaseMs:300000});
  expect(error.failed).toBe(1);
  const delivered=await redeliverPending(repo,async(id)=>{attempts++;return `run-${id}`;},{limit:10,leaseMs:300000});
  expect(delivered.started).toBeGreaterThan(0);expect(attempts).toBeGreaterThanOrEqual(2);
  expect((await repo.getOwned('owner',ticket.id))?.status).toBe('queued');
});

pgTest('browser starts require a same-transaction identity recheck, including creation',async()=>{
  const browser={actor:'browser-owner',scopes:['comex:write'] as const};
  const req={identity:browser,action:'create' as const,requestKey:'browser-create',input:{title:'T',plot:'Plot',style:'ink-manga'}};
  await expect(coordinator.enqueue(req)).rejects.toThrow('Browser identity');
  await pool.query("INSERT INTO auth_guests(token_hash,owner,email,expires_at) VALUES ('proof','browser-owner','b@example.test',$1)",[Date.now()+60000]);
  const forBrowser=new PostgresOperationCoordinator(pool,repo,async(tx,identity)=>{
    return !!(await tx.query('SELECT 1 FROM auth_guests WHERE token_hash=$1 AND owner=$2 AND expires_at>$3',['proof',identity.actor,Date.now()])).rowCount;
  });
  expect((await forBrowser.enqueue(req)).status).toBe('queued');
  await pool.query("DELETE FROM auth_guests WHERE token_hash='proof'");
  await expect(forBrowser.enqueue({...req,requestKey:'after-claim'})).rejects.toThrow('Browser identity');
});

pgTest('a duplicate request does not hold the operation lock while waiting for its comic',async()=>{
  const req={identity,action:'update' as const,requestKey:'lock-order',comicId:'comic',expectedRevision:2,input:{title:'T'}};
  const ticket=await coordinator.enqueue(req),client=await pool.connect();let pending:Promise<unknown>|undefined;
  try {
    await client.query('BEGIN');await client.query("SELECT id FROM comics WHERE id='comic' FOR UPDATE");
    pending=coordinator.enqueue(req);
    for(let i=0;i<100;i++) {
      const waiting=await pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT owner,revision,draft,import_batch_id FROM comics%' LIMIT 1");
      if(waiting.rowCount)break;
      await new Promise(resolve=>setTimeout(resolve,10));
      if(i===99)throw new Error('Duplicate enqueue did not reach the comic lock.');
    }
    await client.query("SET LOCAL lock_timeout='500ms'");
    await client.query('SELECT id FROM operations WHERE id=$1 FOR UPDATE',[ticket.id]);
    await client.query('COMMIT');
    await pending;
  } finally {await client.query('ROLLBACK').catch(()=>{});client.release();await pending?.catch(()=>{});}
});

pgTest('a comic checkpoint waits for the comic before locking the operation',async()=>{
  const ticket=await coordinator.enqueue({identity,action:'update',requestKey:'checkpoint-lock-order',comicId:'comic',expectedRevision:2,input:{title:'T'}});
  const lease=(await repo.claimOperation(ticket.id,300000))!,client=await pool.connect();let pending:Promise<unknown>|undefined;
  try {
    await client.query('BEGIN');await client.query("SELECT id FROM comics WHERE id='comic' FOR UPDATE");
    const lockComic=async(tx:any,context:any)=>{await tx.query('SELECT id FROM comics WHERE id=$1 FOR UPDATE',[context.operation.targetId]);};
    pending=Promise.resolve(repo.runCheckpoint(lease,'order',async(tx,context)=>{await lockComic(tx,context);return {ok:true};}));
    for(let i=0;i<100;i++) {
      const waiting=await pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query='SELECT id FROM comics WHERE id=$1 FOR UPDATE' LIMIT 1");
      if(waiting.rowCount)break;
      await new Promise(resolve=>setTimeout(resolve,10));
      if(i===99)throw new Error('Checkpoint did not reach the comic lock.');
    }
    await client.query("SET LOCAL lock_timeout='500ms'");
    await client.query('SELECT id FROM operations WHERE id=$1 FOR UPDATE',[ticket.id]);
    await client.query('COMMIT');await pending;
  } finally {await client.query('ROLLBACK').catch(()=>{});client.release();await pending?.catch(()=>{});}
});

pgTest('unknown reconciliation can follow comic-before-operation lock order',async()=>{
  const ticket=await coordinator.enqueue({identity,action:'initialQuestions',requestKey:'reconcile-lock-order',comicId:'comic',expectedRevision:2,input:{}});
  const lease=(await repo.claimOperation(ticket.id,300000))!;
  await repo.claimPaidStep(lease,{id:'question',input:{}},async()=>{});await repo.completePaidStep(lease,'question','unknown',null);await repo.releaseUnknown(lease);
  const client=await pool.connect();let pending:Promise<void>|undefined;
  try {
    await client.query('BEGIN');await client.query("SELECT id FROM comics WHERE id='comic' FOR UPDATE");
    pending=Promise.resolve(repo.reconcileUnknown(ticket.id,'question','completed',{format:'json',value:{}},async()=>{}));
    for(let i=0;i<100;i++) {
      const waiting=await pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query='SELECT id FROM comics WHERE id=$1 FOR UPDATE' LIMIT 1");
      if(waiting.rowCount)break;
      await new Promise(resolve=>setTimeout(resolve,10));
      if(i===99)throw new Error('Reconciliation did not reach the comic lock.');
    }
    await client.query("SET LOCAL lock_timeout='500ms'");
    await client.query('SELECT id FROM operations WHERE id=$1 FOR UPDATE',[ticket.id]);
    await client.query('COMMIT');await pending;
    expect((await repo.getOwned('owner',ticket.id))?.status).toBe('queued');
  } finally {await client.query('ROLLBACK').catch(()=>{});client.release();await pending?.catch(()=>{});}
});

pgTest('a creation checkpoint prevents a second draft after a worker dies before acknowledging completion',async()=>{
  const ticket=await coordinator.enqueue({identity,action:'create',requestKey:'create-atomic',input:{title:'Once',plot:'Story',style:'ink-manga'}});
  const lease=(await repo.claimOperation(ticket.id,300000))!;let calls=0;
  const result=await repo.runCheckpoint(lease,'create',async(tx,context)=>{
    calls++;await tx.query('INSERT INTO comics(id,owner,revision,draft) VALUES ($1,$2,1,$3)',[context.operation.id,context.operation.owner,JSON.stringify({ownerId:context.operation.owner,title:'Once'})]);
    return {comic:{id:context.operation.id}};
  });
  await pool.query('UPDATE operations SET lease_until=0 WHERE id=$1',[ticket.id]);
  const resumed=(await repo.claimOperation(ticket.id,300000))!;
  const replayed=await repo.runCheckpoint(resumed,'create',async()=>{calls++;throw new Error('must not create twice');});
  expect(replayed).toEqual(result);expect(calls).toBe(1);
  expect((await pool.query('SELECT count(*)::int AS n FROM comics WHERE id=$1',[ticket.id])).rows[0].n).toBe(1);
  await repo.finishOperation(resumed,'succeeded',replayed);
});
