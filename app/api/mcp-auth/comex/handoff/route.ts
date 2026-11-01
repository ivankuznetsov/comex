import {Pool} from 'pg';
import {getMcpAuth} from '@/src/lib/auth/runtime';
import {attestImport,issueImportChallenge,redeemImport} from '@/src/lib/auth/claim';
export const runtime='nodejs';
export async function POST(request:Request) {
  const localOrigin=process.env.COMEX_APP_URL,secret=process.env.COMEX_IMPORT_HANDOFF_SECRET;
  if(!localOrigin || !secret || secret.length<32)return Response.json({error:'Import handoff is not configured.'},{status:503});
  if(request.headers.get('origin')!==localOrigin || !request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))return Response.json({error:'Invalid request.'},{status:403});
  let body:{action?:unknown;batchId?:unknown;challenge?:unknown;proof?:unknown};
  try{const text=await request.text();if(text.length>16000)throw new Error();body=JSON.parse(text);}catch{return Response.json({error:'Invalid request.'},{status:400});}
  const server=getMcpAuth(),cookie=request.headers.get('cookie')??'';
  if(body.action==='challenge' && server.database instanceof Pool && typeof body.batchId==='string') {
    const challenge=await issueImportChallenge({pool:server.database,identityStore:server.identityStore,cookie,batchId:body.batchId,origin:localOrigin,secret});
    return challenge?Response.json({challenge},{headers:{'cache-control':'no-store'}}):Response.json({error:'This batch is not available to claim.'},{status:400});
  }
  if(body.action==='attest' && !(server.database instanceof Pool) && typeof body.challenge==='string') {
    const origin=process.env.COMEX_IMPORT_DESTINATION_URL;
    if(!origin)return Response.json({error:'The destination is not configured.'},{status:503});
    const proof=await attestImport({identityStore:server.identityStore,cookie,challenge:body.challenge,origin,secret});
    return proof?Response.json({proof},{headers:{'cache-control':'no-store'}}):Response.json({error:'This browser or request could not be verified.'},{status:400});
  }
  if(body.action==='redeem' && server.database instanceof Pool && typeof body.proof==='string') {
    const ok=await redeemImport({pool:server.database,identityStore:server.identityStore,cookie,proof:body.proof,origin:localOrigin,secret});
    return ok?Response.json({ok:true},{headers:{'cache-control':'no-store'}}):Response.json({error:'This handoff is invalid, expired, already used, or still in progress.'},{status:400});
  }
  return Response.json({error:'Invalid request.'},{status:400});
}
