import {getHostedBrowserOperations} from '@/src/lib/hosted-browser-operations';

export const runtime='nodejs';
export const dynamic='force-dynamic';
type Context={params:Promise<{id:string}>};
export async function GET(request:Request,{params}:Context) {
  try {return await getHostedBrowserOperations().get(request,(await params).id,true);} catch {return Response.json({error:'Hosted operations are not configured.'},{status:503,headers:{'Cache-Control':'no-store'}});}
}
