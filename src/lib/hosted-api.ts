import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {createAIService, type AIOptions} from './ai/service';
import {createComicService} from './application/comics';
import type {BrowserBackend} from './local-api';
import {PostgresAssets, type PrivateObjects} from './storage/assets';
import {PostgresAuth} from './storage/auth';
import {PostgresRepository} from './storage/postgres';
import {workspaceId} from './auth/workspace';

/** A hosted browser and MCP must use the same database and private object store. */
export function createHostedBackend(options:{pool:Pool; objects:PrivateObjects; origin:string; workspaceSecret:string; budgetFetch:NonNullable<AIOptions['fetch']>}):BrowserBackend {
  const canonical = new URL(options.origin);
  if (canonical.origin !== options.origin || canonical.username || canonical.password ||
      options.workspaceSecret.length<32 || (canonical.protocol !== 'https:' && !(canonical.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(canonical.hostname)))) {
    throw new Error('The hosted application origin must be a canonical HTTPS origin.');
  }
  const auth = new PostgresAuth(options.pool);
  const service = createComicService({repository:new PostgresRepository(options.pool,options.objects),
    assets:new PostgresAssets(options.pool,options.objects),provider:createAIService,
    budgetFetch:options.budgetFetch,id:randomUUID});
  return {auth,service,workspaceId:owner=>workspaceId(owner,options.workspaceSecret),validateRequest:request => request.nextUrl.origin === canonical.origin && request.headers.get('host') === canonical.host};
}
