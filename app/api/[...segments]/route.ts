import { NextRequest } from 'next/server';
import { handleApi } from '@/src/lib/local-api';
import {getHostedApp} from '@/src/lib/hosted-runtime';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = {params: Promise<{segments: string[]}>};
async function handle(request:NextRequest,{params}:Context) {
  const {segments}=await params;
  if(process.env.COMEX_RUNTIME!=='hosted')return handleApi(request,segments);
  try {
    const app=getHostedApp();
    if(segments[0]==='comics' && (request.method!=='GET' || (segments[2]==='pages' && segments[4]==='download')))
      return Response.json({error:'Use a hosted operation to change or export a comic.'},{status:409,headers:{'Cache-Control':'no-store'}});
    return handleApi(request,segments,app.backend);
  } catch {
    return Response.json({error:'Hosted Comex is not configured.'},{status:503,headers:{'Cache-Control':'no-store'}});
  }
}
export const GET=handle;
export const POST=handle;
export const PATCH=handle;
export const DELETE=handle;
