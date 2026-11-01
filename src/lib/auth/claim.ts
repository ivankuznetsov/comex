import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
import type {Pool} from 'pg';
import {browserOwner,type IdentityStore} from './mcp';

type Challenge={kind:'destination';batchId:string;destinationOwner:string;origin:string;expires:number;nonce:string};
type Proof={kind:'source';challenge:Challenge;sourceOwner:string;expires:number};
type Common={origin:string;secret:string;now?:number};
const lifetime=10*60_000;
function canonicalOrigin(origin:string) {
  try {const url=new URL(origin);return url.origin===origin && !url.username && !url.password && (url.protocol==='https:' || (url.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)));}catch{return false;}
}
function key(secret:string) {if(secret.length<32)throw new Error('Import handoff secret must have at least 32 characters.');return createHash('sha256').update('comex-import-handoff\0').update(secret).digest();}
function seal(value:Challenge|Proof,secret:string) {
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key(secret),iv);
  const encrypted=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
  return Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64url');
}
function unseal(value:string,secret:string):unknown {
  try {
    if(value.length>12000 || !/^[A-Za-z0-9_-]+$/.test(value))return null;
    const bytes=Buffer.from(value,'base64url');if(bytes.length<29 || bytes.toString('base64url')!==value)return null;
    const cipher=createDecipheriv('aes-256-gcm',key(secret),bytes.subarray(0,12));cipher.setAuthTag(bytes.subarray(12,28));
    return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString('utf8'));
  } catch{return null;}
}
function validChallenge(value:unknown,origin:string,now:number):value is Challenge {
  const c=value as Partial<Challenge>|null;
  return !!c && c.kind==='destination' && typeof c.batchId==='string' && c.batchId.length<=200 && typeof c.destinationOwner==='string' && /^[a-f0-9]{64}$/.test(c.destinationOwner) && c.origin===origin && typeof c.expires==='number' && c.expires>now && c.expires<=now+lifetime && typeof c.nonce==='string' && /^[a-f0-9]{64}$/.test(c.nonce);
}
/** Operator-only mapping: values come from an already imported trusted batch. */
export async function registerImportBatch(pool:Pool,batchId:string):Promise<number> {
  const result=await pool.query(`INSERT INTO mcp_import_owners(batch_id,source_owner)
    SELECT DISTINCT b.id,c.owner FROM import_batches b JOIN comics c ON c.import_batch_id=b.id
    WHERE b.id=$1 ON CONFLICT DO NOTHING`,[batchId]);
  return result.rowCount??0;
}
export async function issueImportChallenge({pool,identityStore,cookie,batchId,origin,secret,now=Date.now()}:{pool:Pool;identityStore:IdentityStore;cookie:string;batchId:string}&Common):Promise<string|null> {
  if(!canonicalOrigin(origin) || secret.length<32 || batchId.length>200)return null;
  const owner=await browserOwner(cookie,identityStore);if(!owner)return null;
  const registered=await pool.query('SELECT 1 FROM mcp_import_owners WHERE batch_id=$1 AND claimed_at IS NULL LIMIT 1',[batchId]);if(!registered.rowCount)return null;
  return seal({kind:'destination',batchId,destinationOwner:owner.owner,origin,expires:now+lifetime,nonce:randomBytes(32).toString('hex')},secret);
}
/** The old cookie is checked only by the local application and is never embedded in the proof. */
export async function attestImport({identityStore,cookie,challenge,origin,secret,now=Date.now()}:{identityStore:IdentityStore;cookie:string;challenge:string}&Common):Promise<string|null> {
  if(!canonicalOrigin(origin) || secret.length<32)return null;
  const destination=unseal(challenge,secret);if(!validChallenge(destination,origin,now))return null;
  const owner=await browserOwner(cookie,identityStore);if(!owner)return null;
  return seal({kind:'source',challenge:destination,sourceOwner:owner.owner,expires:Math.min(destination.expires,now+lifetime)},secret);
}
export async function redeemImport({pool,identityStore,cookie,proof,origin,secret,now=Date.now()}:{pool:Pool;identityStore:IdentityStore;cookie:string;proof:string}&Common):Promise<boolean> {
  if(!canonicalOrigin(origin) || secret.length<32)return false;
  const decoded=unseal(proof,secret) as Partial<Proof>|null;
  if(!decoded || decoded.kind!=='source' || typeof decoded.sourceOwner!=='string' || !/^[a-f0-9]{64}$/.test(decoded.sourceOwner) || typeof decoded.expires!=='number' || decoded.expires<=now || decoded.expires>now+lifetime || !validChallenge(decoded.challenge,origin,now))return false;
  const owner=await browserOwner(cookie,identityStore);if(!owner || owner.owner!==decoded.challenge.destinationOwner)return false;
  const source=decoded.sourceOwner,batch=decoded.challenge.batchId,c=await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT id FROM auth_guard WHERE id=1 FOR UPDATE');
    const current=await browserOwner(cookie,identityStore);
    if(!current || current.owner!==owner.owner){await c.query('COMMIT');return false;}
    const mapping=await c.query('SELECT 1 FROM mcp_import_owners WHERE batch_id=$1 AND source_owner=$2 AND claimed_at IS NULL FOR UPDATE',[batch,source]);
    if(!mapping.rowCount){await c.query('COMMIT');return false;}
    const rows=await c.query('SELECT id FROM comics WHERE import_batch_id=$1 AND owner=$2 FOR UPDATE',[batch,source]);
    if(!rows.rowCount){await c.query('COMMIT');return false;}
    const active=await c.query(`SELECT 1 FROM comics c WHERE c.import_batch_id=$1 AND c.owner=$2 AND (
      EXISTS(SELECT 1 FROM comic_text_operations t WHERE t.comic_id=c.id AND t.state='running') OR
      EXISTS(SELECT 1 FROM jsonb_each(CASE WHEN jsonb_typeof(c.draft->'operations')='object' THEN c.draft->'operations' ELSE '{}'::jsonb END) o WHERE o.value='"running"'::jsonb) OR
      EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.draft->'pages')='array' THEN c.draft->'pages' ELSE '[]'::jsonb END) p,
        jsonb_array_elements(CASE WHEN jsonb_typeof(p->'panels')='array' THEN p->'panels' ELSE '[]'::jsonb END) n WHERE n->>'status'='checking')) LIMIT 1`,[batch,source]);
    if(active.rowCount){await c.query('COMMIT');return false;}
    await c.query(`UPDATE comic_text_operations SET owner=$1 WHERE comic_id IN (SELECT id FROM comics WHERE import_batch_id=$2 AND owner=$3)`,[owner.owner,batch,source]);
    await c.query(`UPDATE comics SET owner=$1,draft=jsonb_set(draft,'{ownerId}',to_jsonb($1::text),true),
      edition=CASE WHEN edition IS NOT NULL AND edition->>'sourceRevision'=revision::text THEN jsonb_set(edition,'{sourceRevision}',to_jsonb(revision+1),true) ELSE edition END,
      revision=revision+1,import_batch_id=NULL WHERE import_batch_id=$2 AND owner=$3`,[owner.owner,batch,source]);
    await c.query('UPDATE mcp_import_owners SET claimed_at=$1,destination_owner=$2 WHERE batch_id=$3 AND source_owner=$4',[now,owner.owner,batch,source]);
    await c.query('COMMIT');return true;
  } catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;}finally{c.release();}
}
