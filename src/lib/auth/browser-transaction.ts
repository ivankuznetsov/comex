import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';

const cookieValue=(header:string,name:string)=>header.split(';').map(part=>part.trim()).find(part=>part.startsWith(`${name}=`))?.slice(name.length+1);
const valid=(token:string|undefined):token is string=>!!token && /^[a-f0-9]{64}$/.test(token);
const hash=(token:string)=>createHash('sha256').update(token).digest('hex');

/** Caller holds auth_guard in this transaction, serializing against workspace claims. */
export async function browserOwnerMatches(client:PoolClient,cookie:string,owner:string):Promise<boolean> {
  const authenticated=cookieValue(cookie,'comex_auth');
  if (valid(authenticated)) {
    const account=(await client.query(`SELECT s.owner FROM auth_sessions s JOIN auth_users u ON u.owner=s.owner
      WHERE s.token_hash=$1 AND s.expires_at>$2 FOR UPDATE OF s`,[hash(authenticated),Date.now()])).rows[0];
    if (account) return account.owner===owner;
  }
  const guest=cookieValue(cookie,'comex_session');
  if (!valid(guest)) return false;
  const row=(await client.query('SELECT owner,expires_at FROM auth_guests WHERE token_hash=$1 FOR UPDATE',[hash(guest)])).rows[0];
  if (row) return Number(row.expires_at)>Date.now() && row.owner===owner;
  if (guest!==owner) return false;
  const legacy=await client.query(`SELECT c.id FROM comics c WHERE c.owner=$1 AND c.import_batch_id IS NULL
    AND NOT EXISTS(SELECT 1 FROM auth_users u WHERE u.owner=c.owner)
    AND NOT EXISTS(SELECT 1 FROM auth_guests g WHERE g.owner=c.owner) LIMIT 1 FOR SHARE`,[guest]);
  return !!legacy.rowCount;
}
