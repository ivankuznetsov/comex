import {BudgetError} from './budget';
import {getMcpAuth} from './auth/runtime';
import {createHostedBackend} from './hosted-api';
import {createMcpReads} from './mcp/reads';
import {getConfiguredOperationRuntime} from './operations/hosted';

/** One configured hosted database and object store serve both creator interfaces. */
export function getHostedApp() {
  if(process.env.COMEX_RUNTIME!=='hosted')throw new Error('Hosted Comex is not enabled.');
  const origin=process.env.COMEX_APP_URL;
  if(!origin)throw new Error('The application origin is not configured.');
  const runtime=getConfiguredOperationRuntime(),auth=getMcpAuth();
  const backend=createHostedBackend({pool:runtime.pool,objects:runtime.objects,origin,workspaceSecret:process.env.COMEX_MCP_AUTH_SECRET ?? '',budgetFetch:async()=>{throw new BudgetError('budget_not_configured','Use a durable operation for generation.');}});
  const reads=createMcpReads(runtime.pool,backend.service,runtime.operations,runtime.readOwnedExport);
  return {origin,runtime,auth,backend,reads};
}
