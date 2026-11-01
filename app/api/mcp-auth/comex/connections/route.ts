import {getMcpAuth} from '@/src/lib/auth/runtime';
export const runtime='nodejs';
export async function GET(request:Request) {return Response.json({connections:await getMcpAuth().connections(request.headers.get('cookie')??'')},{headers:{'cache-control':'no-store'}});}
export async function POST(request:Request) {
  const base=process.env.COMEX_APP_URL;
  if(!base || request.headers.get('origin')!==base || !request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))return Response.json({error:'Invalid request.'},{status:403});
  let body:{id?:unknown};try{const text=await request.text();if(text.length>1024)throw new Error();body=JSON.parse(text);}catch{return Response.json({error:'Invalid request.'},{status:400});}
  if(typeof body.id!=='string' || !/^[0-9a-f-]{36}$/.test(body.id))return Response.json({error:'Invalid request.'},{status:400});
  const ok=await getMcpAuth().revoke(request.headers.get('cookie')??'',body.id);
  return Response.json({ok},{status:ok?200:404,headers:{'cache-control':'no-store'}});
}
