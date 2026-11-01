import {expect,test} from 'bun:test';
import {Pool} from 'pg';
import {createOperationRuntime,assertVercelWorkflowWorld,assertSchedulerSecret,cronAuthorized} from '../src/lib/operations/runtime';

const pool=new Pool({connectionString:'postgresql://example.invalid/comex'});
const objects={put:async(path:string)=>path,read:async()=>Buffer.from([]),delete:async()=>{}};
const assets={save:async()=>'',read:async()=>Buffer.from([]),discard:async()=>{}};
const durableService={kind:'comex-durable-service-v1' as const,create:()=>({} as never)};
const options={pool,objects,assets,budget:{maxCalls:1,maxConcurrent:1},durableService,startWorkflow:async(id:string)=>`run-${id}`};

test('runtime fails closed without its durable service or independent starter',()=>{
  expect(()=>createOperationRuntime({...options,durableService:undefined as never})).toThrow();
  expect(()=>createOperationRuntime({...options,startWorkflow:undefined as never})).toThrow();
  const runtime=createOperationRuntime(options);
  const a=runtime.coordinatorForBrowser(async()=>true),b=runtime.coordinatorForBrowser(async()=>false);
  expect(a).not.toBe(b);expect(runtime.coordinator.kind).toBe('durable');
});

test('hosted runtime rejects a local or unspecified Workflow World',()=>{
  expect(()=>assertVercelWorkflowWorld({})).toThrow();
  expect(()=>assertVercelWorkflowWorld({VERCEL_DEPLOYMENT_ID:'deployment',WORKFLOW_TARGET_WORLD:'local'})).toThrow();
  expect(()=>assertVercelWorkflowWorld({VERCEL_DEPLOYMENT_ID:'deployment'})).not.toThrow();
  expect(()=>assertVercelWorkflowWorld({VERCEL_DEPLOYMENT_ID:'deployment',WORKFLOW_TARGET_WORLD:'@workflow/world-vercel'})).not.toThrow();
});

test('cron authentication requires a configured matching bearer secret',()=>{
  expect(()=>assertSchedulerSecret(undefined)).toThrow();
  expect(()=>assertSchedulerSecret('short')).toThrow();
  expect(()=>assertSchedulerSecret('long-enough-secret')).not.toThrow();
  expect(cronAuthorized(undefined,'Bearer anything')).toBe(false);
  expect(cronAuthorized('', 'Bearer ')).toBe(false);
  expect(cronAuthorized('short','Bearer short')).toBe(false);
  expect(cronAuthorized('long-enough-secret','Bearer wrong')).toBe(false);
  expect(cronAuthorized('long-enough-secret','Bearer long-enough-secret')).toBe(true);
});
