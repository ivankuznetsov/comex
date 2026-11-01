import {getMcpAuth} from '@/src/lib/auth/runtime';
export const runtime='nodejs';
export async function POST(request:Request) {return getMcpAuth().consent(request);}
