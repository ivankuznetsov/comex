import {getHostedBrowserOperations} from '@/src/lib/hosted-browser-operations';

export const runtime='nodejs';
export const dynamic='force-dynamic';
const unavailable=()=>Response.json({error:'Hosted operations are not configured.'},{status:503,headers:{'Cache-Control':'no-store'}});

export async function POST(request:Request) {
  try {return await getHostedBrowserOperations().start(request);} catch {return unavailable();}
}
export async function GET(request:Request) {
  try {return await getHostedBrowserOperations().list(request);} catch {return unavailable();}
}
