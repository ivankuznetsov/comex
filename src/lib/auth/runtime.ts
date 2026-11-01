import {DatabaseSync} from 'node:sqlite';
import {resolve} from 'node:path';
import {mkdirSync} from 'node:fs';
import {Pool} from 'pg';
import {LocalStore} from '../local-store';
import {PostgresAuth} from '../storage/auth';
import {createMcpAuth} from './mcp';
import {mcpAllowedOrigins} from './cors';

const globalAuth=globalThis as typeof globalThis & {__comexMcpAuth?:ReturnType<typeof createMcpAuth>};
/** Configuration and database are explicit; never fall back to local state on a hosted deployment. */
export function getMcpAuth() {
  if(globalAuth.__comexMcpAuth)return globalAuth.__comexMcpAuth;
  const baseURL=process.env.COMEX_APP_URL,secret=process.env.COMEX_MCP_AUTH_SECRET;
  if(!baseURL || !secret || secret.length<32)throw new Error('MCP authentication is not configured.');
  const trustedOrigins=mcpAllowedOrigins(baseURL,process.env.COMEX_MCP_ALLOWED_ORIGINS);
  if(process.env.VERCEL && !process.env.DATABASE_URL)throw new Error('Hosted MCP requires managed persistence.');
  if(process.env.DATABASE_URL) {
    const pool=new Pool({connectionString:process.env.DATABASE_URL});
    return globalAuth.__comexMcpAuth=createMcpAuth({baseURL,resource:baseURL+'/mcp',secret,database:pool,identityStore:new PostgresAuth(pool),trustedOrigins});
  }
  const path=resolve(process.env.COMEX_DB_PATH || 'data/comex.sqlite');mkdirSync(resolve(path,'..'),{recursive:true});
  const store=new LocalStore(path),database=new DatabaseSync(path);
  return globalAuth.__comexMcpAuth=createMcpAuth({baseURL,resource:baseURL+'/mcp',secret,database,identityStore:store,trustedOrigins});
}
