import {getMcpAuth} from '@/src/lib/auth/runtime';
import {withConfiguredMcpCors} from '@/src/lib/auth/cors';
export const runtime='nodejs';
// Better Auth's anonymous and consent endpoints are server-only. A browser
// approves through the application endpoint that binds its verified owner.
async function handler(request:Request) {
  const path=new URL(request.url).pathname;
  const methods=['/api/mcp-auth/oauth2/authorize','/api/mcp-auth/jwks'].includes(path) ? ['GET'] : ['/api/mcp-auth/oauth2/token','/api/mcp-auth/oauth2/register'].includes(path) ? ['POST'] : [];
  if(!methods.length || (request.method!=='OPTIONS' && !methods.includes(request.method)))return new Response(null,{status:404});
  return withConfiguredMcpCors(request,methods,()=>getMcpAuth().auth.handler(request));
}
export const GET=handler;
export const POST=handler;
export const OPTIONS=handler;
