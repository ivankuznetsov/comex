import {after} from 'next/server';
import {getHostedApp} from '@/src/lib/hosted-runtime';
import {createComexMcpHandler} from '@/src/lib/mcp/server';
import {mcpAllowedOrigins,withMcpCors} from '@/src/lib/auth/cors';

export const runtime='nodejs';
export const dynamic='force-dynamic';

async function handle(request:Request):Promise<Response> {
  try {
    const app=getHostedApp(),canonical=new URL(app.origin);
    if(new URL(request.url).origin!==canonical.origin || request.headers.get('host')!==canonical.host)
      return new Response('Invalid application host.',{status:403,headers:{'Cache-Control':'no-store'}});
    const allowedOrigins=mcpAllowedOrigins(app.origin,process.env.COMEX_MCP_ALLOWED_ORIGINS);
    const handler=createComexMcpHandler({
      allowedOrigins,resourceMetadata:`${app.origin}/.well-known/oauth-protected-resource/mcp`,editorOrigin:app.origin,
      authenticate:async incoming=>{const actor=await app.auth.authenticate(incoming,[]);if(actor)after(async()=>{try{await app.runtime.redeliver();}catch{/* The scheduled recovery can retry later. */}});return actor?{actor:actor.ownerId,grantId:actor.grantId,scopes:actor.scopes}:null;},
      reads:app.reads,
      operations:{kind:'durable',async enqueue(input){
        const ticket=await app.runtime.coordinator.enqueue(input);
        after(async()=>{try{await app.runtime.redeliver();}catch{/* The independent scheduler retries the committed intent. */}});
        return ticket;
      }},
    });
    return await withMcpCors(request,allowedOrigins,['GET','POST','DELETE'],()=>handler(request));
  } catch {
    return new Response('Comex MCP is not configured.',{status:503,headers:{'Cache-Control':'no-store'}});
  }
}
export const GET=handle;
export const POST=handle;
export const DELETE=handle;
export const OPTIONS=handle;
