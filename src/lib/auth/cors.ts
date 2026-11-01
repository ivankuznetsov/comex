export function mcpAllowedOrigins(origin:string,extra=''):string[] {
  const origins=[origin,...extra.split(',').map(value=>value.trim()).filter(Boolean)];
  for(const value of origins) {
    const parsed=new URL(value);
    if(parsed.origin!==value || parsed.username || parsed.password || (parsed.protocol!=='https:' && !(parsed.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(parsed.hostname))))throw new Error('Invalid allowed MCP origin.');
  }
  return [...new Set(origins)];
}

export async function withMcpCors(request:Request,origins:readonly string[],methods:readonly string[],run:()=>Promise<Response>):Promise<Response> {
  const origin=request.headers.get('origin');
  if(origin && !origins.includes(origin))return new Response('Origin not allowed.',{status:403,headers:{'Cache-Control':'no-store'}});
  if(request.method==='OPTIONS') {
    const requested=request.headers.get('access-control-request-method');
    if(!origin || !requested || !methods.includes(requested))return new Response('Origin not allowed.',{status:403,headers:{'Cache-Control':'no-store'}});
    return new Response(null,{status:204,headers:{'Cache-Control':'no-store','Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':[...methods,'OPTIONS'].join(', '),'Access-Control-Allow-Headers':'Authorization, Content-Type, MCP-Protocol-Version, MCP-Session-Id, Last-Event-ID','Vary':'Origin'}});
  }
  const response=await run();
  if(origin) {
    const headers=new Headers(response.headers);
    headers.set('Access-Control-Allow-Origin',origin);
    headers.set('Access-Control-Expose-Headers','WWW-Authenticate, MCP-Session-Id, MCP-Protocol-Version');
    headers.append('Vary','Origin');
    return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
  }
  return response;
}

export async function withConfiguredMcpCors(request:Request,methods:readonly string[],run:()=>Promise<Response>):Promise<Response> {
  try {
    const origin=process.env.COMEX_APP_URL;
    if(!origin)throw new Error('The application origin is not configured.');
    return await withMcpCors(request,mcpAllowedOrigins(origin,process.env.COMEX_MCP_ALLOWED_ORIGINS),methods,run);
  } catch {
    return new Response('MCP authentication is not configured.',{status:503,headers:{'Cache-Control':'no-store'}});
  }
}
