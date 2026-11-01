import {getMcpAuth} from '@/src/lib/auth/runtime';
export const runtime='nodejs';
// Better Auth's anonymous and consent endpoints are server-only. A browser
// approves through the application endpoint that binds its verified owner.
async function handler(request:Request) {
  const path=new URL(request.url).pathname;
  const allowed=request.method==='GET' ? ['/api/mcp-auth/oauth2/authorize','/api/mcp-auth/jwks'] : ['/api/mcp-auth/oauth2/token','/api/mcp-auth/oauth2/register'];
  if(!allowed.includes(path))return new Response(null,{status:404});
  return getMcpAuth().auth.handler(request);
}
export const GET=handler;
export const POST=handler;
