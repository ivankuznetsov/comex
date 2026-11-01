import {getMcpAuth} from '@/src/lib/auth/runtime';
import {browserOwner} from '@/src/lib/auth/mcp';
export const runtime='nodejs';
export async function GET(request:Request) {
  const owner=await browserOwner(request.headers.get('cookie')??'',getMcpAuth().identityStore);
  return Response.json({hasOwner:!!owner,needsEmail:!owner?.email},{headers:{'cache-control':'no-store'}});
}
