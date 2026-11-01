import {getMcpAuth} from '@/src/lib/auth/runtime';
import {withConfiguredMcpCors} from '@/src/lib/auth/cors';
export const runtime='nodejs';
async function handler(request:Request) {return withConfiguredMcpCors(request,['GET'],()=>getMcpAuth().auth.handler(request));}
export const GET=handler;
export const OPTIONS=handler;
