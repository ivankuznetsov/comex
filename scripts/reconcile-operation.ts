import {createHash} from 'node:crypto';
import {Pool,type PoolClient} from 'pg';
import {PostgresOperationRepository} from '../src/lib/operations/postgres';
import type {PolicyContext} from '../src/lib/operations/contracts';

/** Errors with fixed messages that are safe to show at the command line. */
class ReconciliationError extends Error {}
const usage='Usage: bun scripts/reconcile-operation.ts inspect <operation-id> | resolve-failed <operation-id> <step-id> --confirm | abandon-suggestions <operation-id> --confirm';
const abandonedCheckpoint='operator/abandoned-unknown-suggestions';

// Step IDs may contain provider-generated panel IDs. Never print those IDs: they
// can contain arbitrary text. This selector is specific to the given operation.
function stepSelector(operationId:string,stepId:string):string {
  return `step-${createHash('sha256').update(operationId).update('\0').update(stepId).digest('hex')}`;
}
function semanticStep(id:string):string {
  if(['initial/questions','refresh/questions','suggestions','story/plan','story/narrative'].includes(id))return id;
  for(const [prefix,suffixes] of [
    ['character',['reference']],['revision',['preview','narrative']],['panel',['classify','image','visual-review']],
  ] as const)for(const suffix of suffixes)
    if(id.startsWith(`${prefix}/`) && id.endsWith(`/${suffix}`) && id.length>prefix.length+suffix.length+2)return `${prefix}/<id>/${suffix}`;
  return 'unrecognized';
}

/** Report only the operation state and non-sensitive projections of unknown steps. */
export async function inspectOperation(pool:Pool,operationId:string) {
  const rows=(await pool.query(`SELECT o.status,
    (o.lease_token IS NOT NULL AND o.lease_until > floor(extract(epoch FROM clock_timestamp())*1000)) AS active_worker,
    EXISTS(SELECT 1 FROM operation_checkpoints cp WHERE cp.operation_id=o.id AND cp.checkpoint_key='operator/abandoned-unknown-suggestions') AS abandoned,
    s.step_id,s.state AS step_state,r.state AS reservation_state
    FROM operations o LEFT JOIN operation_steps s ON s.operation_id=o.id AND s.state='unknown'
    LEFT JOIN provider_reservations r ON r.id=s.reservation_id WHERE o.id=$1 ORDER BY s.step_id`,[operationId])).rows;
  if(!rows.length)throw new ReconciliationError('Operation not found.');
  const statuses=['queued','running','succeeded','needs_review','failed','unknown_outcome','obsolete','revoked'];
  const status=statuses.includes(rows[0].status)?rows[0].status:'unrecognized';
  const steps=rows.filter(row=>row.step_id!==null).map(row=>({
    stepId:stepSelector(operationId,row.step_id),semanticStep:semanticStep(row.step_id),state:'unknown',
    reservationState:['running','unknown','completed'].includes(row.reservation_state)?row.reservation_state:'missing',
  }));
  return {status,activeWorker:rows[0].active_worker===true,abandoned:rows[0].abandoned===true,steps,
    ...(status==='unknown_outcome'&&!steps.length?{note:'No unknown paid step is available; the operation remains blocked.'}:{})};
}

/** Called after the repository has locked the comic and operation, in that order. */
async function requireMatchingTarget(client:PoolClient,context:PolicyContext):Promise<void> {
  const matching=await client.query('SELECT 1 FROM comics WHERE id=$1 AND owner=$2 AND import_batch_id IS NULL',[context.operation.targetId,context.operation.owner]);
  if(!matching.rowCount)throw new ReconciliationError('The operation and its draft are unavailable or no longer match.');
  const intent=await client.query('SELECT 1 FROM operation_dispatch_intents WHERE operation_id=$1 FOR UPDATE',[context.operation.id]);
  if(!intent.rowCount)throw new ReconciliationError('The operation has no dispatch intent and remains blocked.');
}

/** Mark only a confirmed failed step; the repository retains its charged reservation. */
export async function resolveFailed(pool:Pool,operationId:string,selector:string):Promise<void> {
  const rows=(await pool.query("SELECT step_id FROM operation_steps WHERE operation_id=$1 AND state='unknown'",[operationId])).rows;
  // An operator may supply an actual semantic ID, or the non-sensitive selector
  // emitted by inspect. Never echo either value in success or error messages.
  const exact=rows.find(row=>row.step_id===selector);
  const matches=exact?[exact]:rows.filter(row=>stepSelector(operationId,row.step_id)===selector);
  if(matches.length!==1)throw new ReconciliationError('The selected unknown step was not found.');
  const repo=new PostgresOperationRepository(pool,{maxCalls:undefined,maxConcurrent:undefined});
  await repo.reconcileUnknown(operationId,matches[0].step_id,'failed',null,requireMatchingTarget);
}

/** Release only the matching draft lock, keeping the provider result and charge uncertain. */
export async function abandonSuggestions(pool:Pool,operationId:string):Promise<void> {
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const prior=(await client.query('SELECT target_id FROM operations WHERE id=$1',[operationId])).rows[0];
    if(!prior)throw new ReconciliationError('The operation is not available for abandonment.');
    // Match normal operation and handoff lock ordering: comic, then operation.
    const comic=(await client.query('SELECT id,owner,draft,import_batch_id FROM comics WHERE id=$1 FOR UPDATE',[prior.target_id])).rows[0];
    const operation=(await client.query('SELECT * FROM operations WHERE id=$1 FOR UPDATE',[operationId])).rows[0];
    const now=Number((await client.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000) AS now')).rows[0].now);
    if(!comic || !operation || operation.target_id!==comic.id || comic.owner!==operation.owner || comic.import_batch_id!==null ||
       operation.action!=='suggestCharacters' || operation.status!=='unknown_outcome' ||
       (operation.lease_token && (operation.lease_until===null || Number(operation.lease_until)>now)) || comic.draft?.initialSuggestions!=='unknown')
      throw new ReconciliationError('The operation is not available for abandonment.');
    const dispatch=(await client.query('SELECT * FROM operation_dispatch_intents WHERE operation_id=$1 FOR UPDATE',[operationId])).rows[0];
    if(!dispatch || dispatch.state!=='delivered' || (dispatch.lease_token && (dispatch.lease_until===null || Number(dispatch.lease_until)>now)))throw new ReconciliationError('The operation is not available for abandonment.');
    const steps=await client.query('SELECT s.step_id,s.state,s.result_json,r.state AS reservation_state FROM operation_steps s JOIN provider_reservations r ON r.id=s.reservation_id WHERE s.operation_id=$1 FOR UPDATE OF s,r',[operationId]);
    if(steps.rowCount!==1 || steps.rows[0].step_id!=='suggestions' || steps.rows[0].state!=='unknown' || steps.rows[0].reservation_state!=='unknown' || ![null,'null'].includes(steps.rows[0].result_json))throw new ReconciliationError('The operation is not available for abandonment.');
    const lock=(await client.query('SELECT owner,state,operation_id FROM comic_text_operations WHERE comic_id=$1 FOR UPDATE',[comic.id])).rows[0];
    if(!lock || lock.owner!==operation.owner || lock.state!=='unknown' || lock.operation_id!==operationId)throw new ReconciliationError('The operation is not available for abandonment.');
    const competing=await client.query("SELECT 1 FROM operations WHERE target_id=$1 AND id<>$2 AND status IN ('queued','running','unknown_outcome') LIMIT 1",[comic.id,operationId]);
    if(competing.rowCount)throw new ReconciliationError('The draft has another unresolved operation.');
    await client.query('INSERT INTO operation_checkpoints(operation_id,checkpoint_key,value_json) VALUES ($1,$2,$3)',[operationId,abandonedCheckpoint,JSON.stringify({decision:'continue_without_suggestion',providerOutcome:'unknown',recordedAt:new Date(now).toISOString()})]);
    await client.query('UPDATE operations SET fence=fence+1,lease_token=NULL,lease_until=NULL,updated_at=$2 WHERE id=$1',[operationId,new Date(now).toISOString()]);
    const deleted=await client.query("DELETE FROM comic_text_operations WHERE comic_id=$1 AND owner=$2 AND operation_id=$3 AND state='unknown'",[comic.id,operation.owner,operationId]);
    if(deleted.rowCount!==1)throw new ReconciliationError('The draft lock changed.');
    await client.query('COMMIT');
  } catch(error) {await client.query('ROLLBACK').catch(()=>{});throw error;} finally {client.release();}
}

export async function runReconciliation(pool:Pool,args:string[]):Promise<string> {
  const [action,operationId,stepId,confirm]=args;
  if(action==='inspect' && operationId && args.length===2)return JSON.stringify(await inspectOperation(pool,operationId),null,2);
  if(action==='abandon-suggestions' && operationId && stepId==='--confirm' && args.length===3){
    await abandonSuggestions(pool,operationId);
    return 'The suggestion was abandoned without retrying. Its provider outcome and reservation remain unknown.';
  }
  if(action==='resolve-failed' && operationId && stepId && confirm==='--confirm' && args.length===4){
    await resolveFailed(pool,operationId,stepId);
    return 'The investigated step was marked failed. Its provider charge remains recorded; no provider call was repeated.';
  }
  throw new ReconciliationError(usage);
}

if(import.meta.main){
  let pool:Pool|undefined;
  try {
    if(!process.env.DATABASE_URL)throw new ReconciliationError('Set DATABASE_URL for the intended database.');
    pool=new Pool({connectionString:process.env.DATABASE_URL});
    console.log(await runReconciliation(pool,process.argv.slice(2)));
  } catch(error) {
    // Driver errors and unexpected database contents may contain credentials,
    // prompts, or identifiers. Only fixed, locally authored messages are shown.
    console.error(error instanceof ReconciliationError?error.message:'Reconciliation failed; check the operation state and database access.');
    process.exitCode=1;
  } finally {await pool?.end().catch(()=>{});}
}
