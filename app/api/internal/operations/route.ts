import {getConfiguredOperationRuntime} from '../../../../src/lib/operations/hosted';
import {cronAuthorized} from '../../../../src/lib/operations/runtime';

export const runtime='nodejs';

export async function GET(request:Request):Promise<Response> {
  if(!cronAuthorized(process.env.CRON_SECRET,request.headers.get('authorization')))return new Response('Unauthorized',{status:401});
  try {return Response.json(await getConfiguredOperationRuntime().redeliver(),{headers:{'Cache-Control':'no-store'}});}
  catch {return new Response('Operation dispatch is unavailable.',{status:503,headers:{'Cache-Control':'no-store'}});}
}
