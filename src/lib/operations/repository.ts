import {createHash,randomUUID} from 'node:crypto';
import {BudgetError} from '../budget';
import type {BudgetConfig,IntentLease,Json,Operation,OperationRepository,OperationStep,PolicyContext,StartOperation,StepClaim,StepState,TerminalStatus,TransactionPolicy,WorkerLease} from './contracts';
import {OperationError} from './contracts';

type Params=(string|number|null)[];
type Row=Record<string,any>;
type QueryResult={rows:Row[];rowCount:number};
export type Effect<Tx>={kind:'query';sql:string;params:Params}|{kind:'time'}|{kind:'budget_lock'}|{kind:'request_lock';key:string}|{kind:'policy';policy:TransactionPolicy<Tx>;context:PolicyContext};
export type Program<Tx,T>=Generator<Effect<Tx>,T,any>;
const query=(sql:string,...params:Params):Effect<any>=>({kind:'query',sql,params});
const policyEffect=<Tx>(policy:TransactionPolicy<Tx>,context:PolicyContext):Effect<Tx>=>({kind:'policy',policy,context});
const nowEffect:Effect<any>={kind:'time'};
const budgetLock:Effect<any>={kind:'budget_lock'};
function canonical(value:Json):string {
  if(value===null || typeof value==='string' || typeof value==='boolean')return JSON.stringify(value);
  if(typeof value==='number') {if(!Number.isFinite(value))throw new Error('Values must be JSON.');return JSON.stringify(value);}
  if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
  if(typeof value!=='object' || Object.getPrototypeOf(value)!==Object.prototype)throw new Error('Values must be JSON.');
  return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}
const digest=(value:Json)=>createHash('sha256').update(canonical(value)).digest('hex');
const fromJson=(text:string|null):Json|null=>text===null?null:JSON.parse(text) as Json;
function operation(row:Row):Operation {return {id:row.id,owner:row.owner,action:row.action,requestKey:row.request_key,targetId:row.target_id,grantId:row.grant_id,expectedVersions:fromJson(row.expected_versions)!,input:fromJson(row.input_json)!,status:row.status,result:fromJson(row.result_json),createdAt:row.created_at,updatedAt:row.updated_at};}
function ms(value:number):void {if(!Number.isSafeInteger(value)||value<1)throw new Error('Lease duration must be a positive integer.');}
function leased(row:Row|undefined,lease:WorkerLease,now:number):void {
  if(!row || row.status!=='running' || row.lease_token!==lease.token || Number(row.fence)!==lease.fence || Number(row.lease_until)<=now)
    throw new OperationError('lease_lost','The operation worker lease was lost.');
}
function checkBudget(config:BudgetConfig):void {
  if((config.maxCalls!=='unlimited'&&(!Number.isSafeInteger(config.maxCalls)||(config.maxCalls as number)<1))||!Number.isSafeInteger(config.maxConcurrent)||(config.maxConcurrent as number)<1)
    throw new BudgetError('budget_not_configured','Set a positive AI call budget or unlimited and a positive concurrency limit.');
}
const stamp=(now:number)=>new Date(now).toISOString();

/** The two drivers execute these same transactions; the callback gets their real connection. */
export abstract class BaseOperations<Tx> implements OperationRepository<Tx> {
  protected readonly budget:BudgetConfig;
  constructor(budget:BudgetConfig) {this.budget={...budget};}
  protected abstract transact<T>(program:Program<Tx,T>):T|Promise<T>;
  start(provided:StartOperation,policy:TransactionPolicy<Tx>) {
    const input=JSON.parse(canonical(provided as unknown as Json)) as StartOperation;
    return this.transact((function*():Program<Tx,{operation:Operation;created:boolean}>{
      const inputDigest=digest({targetId:input.targetId,grantId:input.grantId,expectedVersions:input.expectedVersions,input:input.input});
      yield {kind:'request_lock',key:canonical([input.owner,input.action,input.requestKey])};
      let existing:QueryResult=yield query('SELECT * FROM operations WHERE owner=? AND action=? AND request_key=? FOR UPDATE',input.owner,input.action,input.requestKey);
      if(existing.rows.length){const row=existing.rows[0],op=operation(row);yield policyEffect(policy,{phase:'existing',operation:op});if(row.input_digest!==inputDigest)throw new OperationError('idempotency_conflict','The request key was used with different input.');return {operation:operation(row),created:false};}
      const now:number=yield nowEffect,id=randomUUID(),createdAt=stamp(now);
      const candidate:Operation={...input,expectedVersions:fromJson(canonical(input.expectedVersions))!,input:fromJson(canonical(input.input))!,id,status:'queued',result:null,createdAt,updatedAt:createdAt};
      yield policyEffect(policy,{phase:'create',operation:candidate});
      const inserted:QueryResult=yield query(`INSERT INTO operations(id,owner,action,request_key,input_digest,target_id,grant_id,expected_versions,input_json,status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,'queued',?,?) ON CONFLICT(owner,action,request_key) DO NOTHING RETURNING *`,id,input.owner,input.action,input.requestKey,inputDigest,input.targetId,input.grantId,canonical(input.expectedVersions),canonical(input.input),createdAt,createdAt);
      if(inserted.rowCount){yield query("INSERT INTO operation_dispatch_intents(operation_id,state) VALUES (?,'pending')",id);return {operation:operation(inserted.rows[0]),created:true};}
      existing=yield query('SELECT * FROM operations WHERE owner=? AND action=? AND request_key=? FOR UPDATE',input.owner,input.action,input.requestKey);
      const row=existing.rows[0];if(!row)throw new OperationError('idempotency_conflict','The request key was used with different input.');
      const op=operation(row);yield policyEffect(policy,{phase:'existing',operation:op});if(row.input_digest!==inputDigest)throw new OperationError('idempotency_conflict','The request key was used with different input.');return {operation:operation(row),created:false};
    })());
  }
  getOwned(owner:string,id:string){return this.transact((function*():Program<Tx,Operation|null>{const r:QueryResult=yield query('SELECT * FROM operations WHERE owner=? AND id=?',owner,id);return r.rows[0]?operation(r.rows[0]):null;})());}
  claimIntent(leaseMs:number){ms(leaseMs);return this.transact((function*():Program<Tx,IntentLease|null>{
    const now:number=yield nowEffect;
    const r:QueryResult=yield query(`SELECT i.* FROM operation_dispatch_intents i JOIN operations o ON o.id=i.operation_id
      WHERE o.status IN ('queued','running') AND (i.state='pending' OR (i.state='leased' AND i.lease_until<=?))
      ORDER BY o.created_at,o.id LIMIT 1 FOR UPDATE OF i SKIP LOCKED`,now);
    const row=r.rows[0];if(!row)return null;
    const token=randomUUID(),expiresAt=now+leaseMs,attempt=Number(row.attempts)+1;
    yield query("UPDATE operation_dispatch_intents SET state='leased',lease_token=?,lease_until=?,attempts=? WHERE operation_id=?",token,expiresAt,attempt,row.operation_id);
    return {operationId:row.operation_id,token,expiresAt,attempt};
  })());}
  ackIntent(lease:IntentLease,runId:string){return this.transact((function*():Program<Tx,boolean>{const now:number=yield nowEffect;const r:QueryResult=yield query("UPDATE operation_dispatch_intents SET state='delivered',workflow_run_id=?,lease_token=NULL,lease_until=NULL WHERE operation_id=? AND state='leased' AND lease_token=? AND lease_until>?",runId,lease.operationId,lease.token,now);return r.rowCount===1;})());}
  releaseIntent(lease:IntentLease){return this.transact((function*():Program<Tx,boolean>{const now:number=yield nowEffect;const r:QueryResult=yield query("UPDATE operation_dispatch_intents SET state='pending',lease_token=NULL,lease_until=NULL WHERE operation_id=? AND state='leased' AND lease_token=? AND lease_until>?",lease.operationId,lease.token,now);return r.rowCount===1;})());}
  requeueIntent(operationId:string){return this.transact((function*():Program<Tx,boolean>{
    const now:number=yield nowEffect;const r:QueryResult=yield query('SELECT * FROM operations WHERE id=? FOR UPDATE',operationId),row=r.rows[0];
    if(!row || !['queued','running'].includes(row.status) || (row.lease_token && Number(row.lease_until)>now))return false;
    const changed:QueryResult=yield query("UPDATE operation_dispatch_intents SET state='pending',lease_token=NULL,lease_until=NULL,workflow_run_id=NULL WHERE operation_id=? AND state='delivered'",operationId);return changed.rowCount===1;
  })());}
  claimOperation(operationId:string,leaseMs:number){ms(leaseMs);return this.transact((function*():Program<Tx,WorkerLease|null>{
    const now:number=yield nowEffect,r:QueryResult=yield query('SELECT * FROM operations WHERE id=? FOR UPDATE',operationId),row=r.rows[0];
    if(!row || !['queued','running'].includes(row.status) || (row.lease_token && Number(row.lease_until)>now))return null;
    const inflight:QueryResult=yield query("SELECT reservation_id FROM operation_steps WHERE operation_id=? AND state='running'",operationId);
    if(inflight.rows.length){
      yield budgetLock;
      for(const step of inflight.rows)yield query("UPDATE provider_reservations SET state='unknown',updated_at=? WHERE id=? AND state='running'",stamp(now),step.reservation_id);
      yield query("UPDATE operation_steps SET state='unknown' WHERE operation_id=? AND state='running'",operationId);
      yield query("UPDATE operations SET status='unknown_outcome',lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=?",stamp(now),operationId);return null;
    }
    const token=randomUUID(),fence=Number(row.fence)+1,expiresAt=now+leaseMs;
    yield query("UPDATE operations SET status='running',lease_token=?,lease_until=?,fence=?,updated_at=? WHERE id=?",token,expiresAt,fence,stamp(now),operationId);
    return {operationId,token,fence,expiresAt};
  })());}
  renewOperation(lease:WorkerLease,leaseMs:number){ms(leaseMs);return this.transact((function*():Program<Tx,WorkerLease>{const now:number=yield nowEffect,r:QueryResult=yield query('SELECT * FROM operations WHERE id=? FOR UPDATE',lease.operationId);leased(r.rows[0],lease,now);const expiresAt=now+leaseMs;yield query('UPDATE operations SET lease_until=?,updated_at=? WHERE id=?',expiresAt,stamp(now),lease.operationId);return {...lease,expiresAt};})());}
  claimPaidStep(lease:WorkerLease,provided:{id:string;input:Json},policy:TransactionPolicy<Tx>){const budget=this.budget,step={id:provided.id,input:fromJson(canonical(provided.input)) as Json};return this.transact((function*():Program<Tx,StepClaim>{
    const now:number=yield nowEffect,r:QueryResult=yield query('SELECT * FROM operations WHERE id=? FOR UPDATE',lease.operationId);leased(r.rows[0],lease,now);
    const stepDigest=digest(step.input),prior:QueryResult=yield query('SELECT * FROM operation_steps WHERE operation_id=? AND step_id=?',lease.operationId,step.id);
    if(prior.rows.length){const row=prior.rows[0];if(row.input_digest!==stepDigest)throw new OperationError('step_conflict','The step ID was used with different input.');return {kind:row.state,reservationId:row.reservation_id,result:fromJson(row.result_json)};}
    yield policyEffect(policy,{phase:'paid_step',operation:operation(r.rows[0]),stepId:step.id,stepInput:step.input});
    checkBudget(budget);yield budgetLock;
    const counts:QueryResult=yield query("SELECT count(*) AS used, coalesce(sum(CASE WHEN state IN ('running','unknown') THEN 1 ELSE 0 END),0) AS active FROM provider_reservations");
    if(typeof budget.maxCalls==='number' && Number(counts.rows[0].used)>=budget.maxCalls)throw new BudgetError('budget_exhausted','The configured AI call budget is exhausted.');
    if(Number(counts.rows[0].active)>=budget.maxConcurrent!)throw new BudgetError('concurrency_limit','The AI concurrency limit is reached or a previous request has an unknown outcome.');
    const reservationId=randomUUID(),stepKey=`comex-operation:${digest([lease.operationId,step.id])}`;
    yield query("INSERT INTO provider_reservations(id,state,created_at,updated_at,step_key) VALUES (?,'running',?,?,?)",reservationId,stamp(now),stamp(now),stepKey);
    yield query("INSERT INTO operation_steps(operation_id,step_id,input_digest,state,reservation_id) VALUES (?,?,?,'running',?)",lease.operationId,step.id,stepDigest,reservationId);
    return {kind:'claimed',reservationId};
  })());}
  completePaidStep(lease:WorkerLease,stepId:string,state:'completed'|'failed'|'unknown',result:Json|null){const encoded=canonical(result);return this.transact((function*():Program<Tx,void>{
    const now:number=yield nowEffect,r:QueryResult=yield query('SELECT * FROM operations WHERE id=? FOR UPDATE',lease.operationId);leased(r.rows[0],lease,now);
    const steps:QueryResult=yield query('SELECT * FROM operation_steps WHERE operation_id=? AND step_id=? FOR UPDATE',lease.operationId,stepId),step=steps.rows[0];
    if(!step || step.state!=='running')throw new OperationError('invalid_transition','The step is not running.');
    yield budgetLock;
    const updated:QueryResult=yield query("UPDATE provider_reservations SET state=?,updated_at=? WHERE id=? AND state='running'",state==='unknown'?'unknown':'completed',stamp(now),step.reservation_id);
    if(updated.rowCount!==1)throw new OperationError('invalid_transition','The reservation is not running.');
    yield query('UPDATE operation_steps SET state=?,result_json=? WHERE operation_id=? AND step_id=?',state,encoded,lease.operationId,stepId);
    if(state==='unknown'){
      const other:QueryResult=yield query("SELECT reservation_id FROM operation_steps WHERE operation_id=? AND state='running'",lease.operationId);
      for(const pending of other.rows)yield query("UPDATE provider_reservations SET state='unknown',updated_at=? WHERE id=? AND state='running'",stamp(now),pending.reservation_id);
      yield query("UPDATE operation_steps SET state='unknown' WHERE operation_id=? AND state='running'",lease.operationId);
      yield query("UPDATE operations SET status='unknown_outcome',lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=?",stamp(now),lease.operationId);
    }
  })());}
  getStep(owner:string,operationId:string,stepId:string){return this.transact((function*():Program<Tx,OperationStep|null>{
    const r:QueryResult=yield query('SELECT s.* FROM operation_steps s JOIN operations o ON o.id=s.operation_id WHERE o.owner=? AND s.operation_id=? AND s.step_id=?',owner,operationId,stepId),row=r.rows[0];
    return row?{id:row.step_id,state:row.state as StepState,reservationId:row.reservation_id,result:fromJson(row.result_json)}:null;
  })());}
  commitCheckpoint(lease:WorkerLease,key:string,value:Json,apply:TransactionPolicy<Tx>){const encoded=canonical(value);return this.transact((function*():Program<Tx,void>{
    const now:number=yield nowEffect,r:QueryResult=yield query('SELECT * FROM operations WHERE id=? FOR UPDATE',lease.operationId);leased(r.rows[0],lease,now);
    const existing:QueryResult=yield query('SELECT value_json FROM operation_checkpoints WHERE operation_id=? AND checkpoint_key=?',lease.operationId,key);
    if(existing.rows.length){if(existing.rows[0].value_json!==encoded)throw new OperationError('checkpoint_conflict','The checkpoint already contains a different value.');return;}
    yield policyEffect(apply,{phase:'checkpoint',operation:operation(r.rows[0]),stepId:key});
    yield query('INSERT INTO operation_checkpoints(operation_id,checkpoint_key,value_json) VALUES (?,?,?)',lease.operationId,key,encoded);
  })());}
  getCheckpoint(owner:string,operationId:string,key:string){return this.transact((function*():Program<Tx,Json|null>{const r:QueryResult=yield query('SELECT c.value_json FROM operation_checkpoints c JOIN operations o ON o.id=c.operation_id WHERE o.owner=? AND c.operation_id=? AND c.checkpoint_key=?',owner,operationId,key);return r.rows.length?fromJson(r.rows[0].value_json):null;})());}
  finishOperation(lease:WorkerLease,status:TerminalStatus,result:Json|null){const encoded=canonical(result);return this.transact((function*():Program<Tx,void>{
    const now:number=yield nowEffect,r:QueryResult=yield query('SELECT * FROM operations WHERE id=? FOR UPDATE',lease.operationId);leased(r.rows[0],lease,now);
    const running:QueryResult=yield query("SELECT step_id FROM operation_steps WHERE operation_id=? AND state IN ('running','unknown')",lease.operationId);
    if(running.rows.length)throw new OperationError('invalid_transition','Resolve outstanding paid steps first.');
    yield query('UPDATE operations SET status=?,result_json=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=?',status,encoded,stamp(now),lease.operationId);
  })());}
  reconcileUnknown(operationId:string,stepId:string,state:'completed'|'failed',result:Json|null,policy:TransactionPolicy<Tx>){const encoded=canonical(result);return this.transact((function*():Program<Tx,void>{
    const now:number=yield nowEffect,r:QueryResult=yield query('SELECT * FROM operations WHERE id=? FOR UPDATE',operationId),row=r.rows[0];
    const steps:QueryResult=yield query('SELECT * FROM operation_steps WHERE operation_id=? AND step_id=? FOR UPDATE',operationId,stepId),step=steps.rows[0];
    if(!row||row.status!=='unknown_outcome'||!step||step.state!=='unknown')throw new OperationError('invalid_transition','The step does not have an unknown outcome.');
    yield policyEffect(policy,{phase:'reconcile',operation:operation(row),stepId});yield budgetLock;
    const reservation:QueryResult=yield query("UPDATE provider_reservations SET state='completed',updated_at=? WHERE id=? AND state='unknown'",stamp(now),step.reservation_id);
    if(reservation.rowCount!==1)throw new OperationError('invalid_transition','The reservation is not unknown.');
    yield query('UPDATE operation_steps SET state=?,result_json=? WHERE operation_id=? AND step_id=?',state,encoded,operationId,stepId);
    const remaining:QueryResult=yield query("SELECT state FROM operation_steps WHERE operation_id=? AND state IN ('running','unknown','failed')",operationId);
    if(remaining.rows.some(step=>step.state==='running'||step.state==='unknown'))return;
    const next=remaining.rows.some(step=>step.state==='failed')?'failed':'queued';
    yield query('UPDATE operations SET status=?,updated_at=? WHERE id=?',next,stamp(now),operationId);
    if(next==='queued')yield query("UPDATE operation_dispatch_intents SET state='pending',lease_token=NULL,lease_until=NULL,workflow_run_id=NULL WHERE operation_id=?",operationId);
  })());}
}
