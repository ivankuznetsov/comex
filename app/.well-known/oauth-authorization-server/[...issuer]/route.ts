import {getMcpAuth} from '@/src/lib/auth/runtime';
export const runtime='nodejs';
export async function GET(request:Request) {return getMcpAuth().auth.handler(request);}
