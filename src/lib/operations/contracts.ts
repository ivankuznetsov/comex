import type {BudgetConfig} from '../budget';
export const operationActions=['create','update','initialQuestions','refreshQuestions','suggestCharacters','addCharacter','editCharacter','removeCharacter','generateReference','approveCharacter','planStory','approveStory','acceptStoryReview','generatePage','acceptPanel','editPanel','previewRevision','applyRevision','exportPage','publish','withdraw'] as const;
export type MutationAction=typeof operationActions[number];
export type ComexScope='comex:read'|'comex:write'|'comex:generate'|'comex:publish';
export type OperationIdentity={actor:string;grantId?:string;scopes:readonly ComexScope[]};
export type OperationRequest={identity:OperationIdentity;action:MutationAction;requestKey:string;comicId?:string;expectedRevision?:number;input:Record<string,unknown>};
export type Json = null | boolean | number | string | Json[] | {[key:string]:Json};
export type MaybePromise<T> = T | Promise<T>;
export type OperationStatus = 'queued'|'running'|'succeeded'|'needs_review'|'failed'|'unknown_outcome'|'obsolete'|'revoked';
export interface StartOperation {owner:string;action:string;requestKey:string;targetId:string;grantId:string|null;expectedVersions:Json;input:Json}
export interface Operation extends StartOperation {id:string;status:OperationStatus;result:Json|null;createdAt:string;updatedAt:string}
export interface ActiveOperation {id:string;status:OperationStatus;action:string;comicId?:string;expectedRevision?:number;targetIds?:{pageId?:string;panelId?:string;characterId?:string};createdAt:string;updatedAt:string}
export interface WorkerLease {operationId:string;token:string;fence:number;expiresAt:number}
export interface IntentLease {operationId:string;token:string;expiresAt:number;attempt:number}
export type StepState='running'|'completed'|'failed'|'unknown';
export interface OperationStep {id:string;state:StepState;result:Json|null;reservationId:string}
export type StepClaim = {kind:'claimed';reservationId:string}|{kind:'running'|'unknown'|'failed'|'completed';reservationId:string;result:Json|null};
export type PolicyContext = {phase:'create'|'existing'|'paid_step'|'reconcile'|'checkpoint';operation:Operation;stepId?:string;stepInput?:Json};
/** A policy runs on the same transaction/connection. It must throw on denial. */
export type TransactionPolicy<Tx> = (transaction:Tx,context:PolicyContext)=>MaybePromise<void>;
export type TransactionWork<Tx> = (transaction:Tx,context:PolicyContext)=>MaybePromise<Json>;
export type TerminalStatus='succeeded'|'needs_review'|'failed'|'obsolete'|'revoked';
export class OperationError extends Error {
  constructor(readonly code:'idempotency_conflict'|'step_conflict'|'checkpoint_conflict'|'lease_lost'|'invalid_transition',message:string) {super(message);this.name='OperationError';}
}
export interface OperationRepository<Tx> {
  start(input:StartOperation,policy:TransactionPolicy<Tx>):MaybePromise<{operation:Operation;created:boolean}>;
  getOwned(owner:string,id:string):MaybePromise<Operation|null>;
  findOwned(owner:string,action:string,requestKey:string):MaybePromise<Operation|null>;
  /** Bounded, owner-scoped projection; excludes request inputs and credentials. */
  listActiveOwned(owner:string,targetId?:string):MaybePromise<ActiveOperation[]>;
  claimIntent(leaseMs:number):MaybePromise<IntentLease|null>;
  ackIntent(lease:IntentLease,runId:string):MaybePromise<boolean>;
  releaseIntent(lease:IntentLease):MaybePromise<boolean>;
  requeueIntent(operationId:string):MaybePromise<boolean>;
  recoverStalled(limit:number):MaybePromise<{requeued:number;unknown:number}>;
  claimOperation(operationId:string,leaseMs:number):MaybePromise<WorkerLease|null>;
  renewOperation(lease:WorkerLease,leaseMs:number):MaybePromise<WorkerLease>;
  releaseUnknown(lease:WorkerLease):MaybePromise<void>;
  getLeased(lease:WorkerLease):MaybePromise<Operation>;
  runCheckpoint(lease:WorkerLease,key:string,work:TransactionWork<Tx>,beforeLock?:TransactionPolicy<Tx>):MaybePromise<Json>;
  claimPaidStep(lease:WorkerLease,step:{id:string;input:Json},policy:TransactionPolicy<Tx>):MaybePromise<StepClaim>;
  /** Only the claimant that has not invoked a provider may cancel this reservation. */
  cancelUndispatchedStep(lease:WorkerLease,stepId:string,reservationId:string):MaybePromise<void>;
  completePaidStep(lease:WorkerLease,stepId:string,state:'completed'|'failed'|'unknown',result:Json|null):MaybePromise<void>;
  getStep(owner:string,operationId:string,stepId:string):MaybePromise<OperationStep|null>;
  commitCheckpoint(lease:WorkerLease,key:string,value:Json,apply:TransactionPolicy<Tx>):MaybePromise<void>;
  getCheckpoint(owner:string,operationId:string,key:string):MaybePromise<Json|null>;
  finishOperation(lease:WorkerLease,status:TerminalStatus,result:Json|null):MaybePromise<void>;
  reconcileUnknown(operationId:string,stepId:string,state:'completed'|'failed',result:Json|null,policy:TransactionPolicy<Tx>,beforeLock?:TransactionPolicy<Tx>):MaybePromise<void>;
}
export type {BudgetConfig};
