import {timingSafeEqual} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {AIOptions} from '../ai/service';
import type {ComicAssets} from '../application/contracts';
import type {BudgetConfig} from '../budget';
import type {PrivateObjects} from '../storage/assets';
import {readOwnedExport} from './atomic-executor';
import {PostgresOperationCoordinator,type OperationIdentity} from './coordinator';
import {PostgresComicExecutor,type DurableServiceAdapter} from './executor';
import {PostgresOperationRepository} from './postgres';
import {redeliverPending} from './redelivery';

type BrowserRevalidator=(client:PoolClient,identity:OperationIdentity)=>Promise<boolean>;
export type OperationRuntimeOptions={
  pool:Pool;
  objects:PrivateObjects;
  assets:ComicAssets;
  budget:BudgetConfig;
  durableService:DurableServiceAdapter;
  /** Start a persistent workflow and return its durable run ID. */
  startWorkflow:(operationId:string)=>Promise<string>;
  fetcher?:NonNullable<AIOptions['fetch']>;
};

/** No request identity or cookie belongs in this shared runtime. */
export function createOperationRuntime(options:OperationRuntimeOptions) {
  if(options.durableService?.kind!=='comex-durable-service-v1' || typeof options.startWorkflow!=='function')throw new Error('Durable operation execution is not configured.');
  const operations=new PostgresOperationRepository(options.pool,options.budget);
  const coordinator=new PostgresOperationCoordinator(options.pool,operations);
  const executor=new PostgresComicExecutor(options.pool,operations,options.objects,options.assets,options.durableService,options.fetcher);
  return {
    pool:options.pool,objects:options.objects,assets:options.assets,operations,coordinator,executor,
    coordinatorForBrowser:(revalidate:BrowserRevalidator)=>new PostgresOperationCoordinator(options.pool,operations,revalidate),
    redeliver:()=>redeliverPending(operations,options.startWorkflow,{limit:20,leaseMs:60000}),
    readOwnedExport:(owner:string,operationId:string)=>readOwnedExport(operations,options.assets,owner,operationId),
  };
}

/** The SDK otherwise silently selects its local world outside a deployment. */
export function assertVercelWorkflowWorld(env:Record<string,string|undefined>):void {
  const target=env.WORKFLOW_TARGET_WORLD;
  if(!env.VERCEL_DEPLOYMENT_ID || (target && target!=='vercel' && target!=='@workflow/world-vercel'))throw new Error('A Vercel Workflow deployment is required for hosted operations.');
}

export function assertSchedulerSecret(secret:string|undefined):asserts secret is string {
  if(!secret || secret.length<16)throw new Error('The scheduler secret must contain at least 16 characters.');
}

export function cronAuthorized(secret:string|undefined,authorization:string|null):boolean {
  if(!secret || secret.length<16 || !authorization)return false;
  const expected=Buffer.from(`Bearer ${secret}`),actual=Buffer.from(authorization);
  return actual.length===expected.length && timingSafeEqual(actual,expected);
}
