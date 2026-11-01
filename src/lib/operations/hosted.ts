import {Pool} from 'pg';
import * as comicModule from '../application/comics';
import {budgetFromEnvironment} from '../budget';
import {PostgresAssets,VercelPrivateObjects} from '../storage/assets';
import type {DurableServiceAdapter} from './executor';
import {assertSchedulerSecret,assertVercelWorkflowWorld,createOperationRuntime} from './runtime';
import {startComicWorkflow} from './workflow-starter';

const globals=globalThis as typeof globalThis & {__comexOperationRuntime?:ReturnType<typeof createOperationRuntime>};

/** Shared infrastructure only; request-specific browser proof is supplied per enqueue. */
export function getConfiguredOperationRuntime() {
  if(globals.__comexOperationRuntime)return globals.__comexOperationRuntime;
  assertVercelWorkflowWorld(process.env);
  const comics=comicModule as typeof comicModule & {durableComicServiceVersion?:string};
  if(comics.durableComicServiceVersion!=='comex-durable-service-v1')throw new Error('The durable comic service is not configured.');
  if(!process.env.DATABASE_URL)throw new Error('Hosted operations require a database.');
  assertSchedulerSecret(process.env.CRON_SECRET);
  if(!process.env.BLOB_READ_WRITE_TOKEN && !process.env.BLOB_STORE_ID)throw new Error('Hosted operations require a private Blob store.');
  const durableService:DurableServiceAdapter={kind:'comex-durable-service-v1',create:(deps,durable)=>{
    const configured={...deps,durable};
    return comics.createComicService(configured);
  }};
  const pool=new Pool({connectionString:process.env.DATABASE_URL});
  const objects=new VercelPrivateObjects(),assets=new PostgresAssets(pool,objects);
  return globals.__comexOperationRuntime=createOperationRuntime({pool,objects,assets,budget:budgetFromEnvironment(),durableService,startWorkflow:startComicWorkflow});
}
