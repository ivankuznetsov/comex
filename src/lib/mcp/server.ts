import {createMcpHandler, McpServer} from '@modelcontextprotocol/server';
import type {ComexMcpDependencies} from './contracts';
import {instructions, registerTools} from './tools';
export type {ComexMcpDependencies, ComexScope, DurableOperationDispatcher, McpIdentity, McpReads, MutationAction, OperationRequest, OperationStatus, OperationTicket} from './contracts';

/** Request-scoped protocol entry. The caller supplies real authentication and a durable dispatcher. */
export function createComexMcpHandler(deps:ComexMcpDependencies):(request:Request)=>Promise<Response> {
  if (!deps || typeof deps.authenticate!=='function' || !deps.reads || deps.operations?.kind!=='durable' || typeof deps.operations.enqueue!=='function') throw new Error('MCP requires authentication, owned reads and a durable dispatcher.');
  const origins=new Set(deps.allowedOrigins.map(origin=>{
    const parsed=new URL(origin);
    if (parsed.origin!==origin || !['https:','http:'].includes(parsed.protocol) || parsed.username || parsed.password || (parsed.protocol==='http:' && !['localhost','127.0.0.1','[::1]'].includes(parsed.hostname))) throw new Error('Invalid allowed MCP origin.');
    return origin;
  }));
  const metadata=new URL(deps.resourceMetadata);
  if ((metadata.protocol!=='https:' && !(metadata.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(metadata.hostname))) || metadata.username || metadata.password || /["\r\n]/.test(deps.resourceMetadata)) throw new Error('Invalid resource metadata URL.');
  if (deps.editorOrigin) {
    const editor=new URL(deps.editorOrigin);
    if (editor.origin!==deps.editorOrigin || (editor.protocol!=='https:' && !(editor.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(editor.hostname))) || editor.username || editor.password) throw new Error('Invalid editor origin.');
  }
  const challenge=`Bearer resource_metadata="${metadata.href}"`;
  return async request=>{
    const origin=request.headers.get('origin');
    if (origin && !origins.has(origin)) return new Response('Origin not allowed.',{status:403,headers:{'Cache-Control':'no-store'}});
    const authorization=request.headers.get('authorization');
    if (!authorization || !/^Bearer\s+\S+$/i.test(authorization)) return new Response('Authentication required.',{status:401,headers:{'WWW-Authenticate':challenge,'Cache-Control':'no-store'}});
    let identity;
    try {identity=await deps.authenticate(request);} catch {return new Response('Authentication is unavailable.',{status:503,headers:{'Cache-Control':'no-store'}});}
    if (!identity || !identity.actor || !Array.isArray(identity.scopes)) return new Response('Authentication required.',{status:401,headers:{'WWW-Authenticate':challenge,'Cache-Control':'no-store'}});
    const protocol=createMcpHandler(()=>{
      const server=new McpServer({name:'comex',version:'0.1.0'},{capabilities:{tools:{}},instructions,maxToolInputElements:1000});
      registerTools(server,deps,identity,authorization);
      return server;
    },{legacy:'stateless',maxRequestBodySize:128*1024});
    const response=await protocol.fetch(request);
    response.headers.set('Cache-Control','no-store');
    return response;
  };
}
