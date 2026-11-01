import {createHash, createHmac, randomBytes, timingSafeEqual} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {ClaimInProgressError} from '../local-store';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const ttl=30*24*60*60*1000;

/** Hosted counterpart of the existing email-code and guest records. OAuth integration is separate. */
export class PostgresAuth {
  constructor(private pool:Pool) {}
  private async locked<T>(fn:(client:PoolClient)=>Promise<T>):Promise<T> {
    const c=await this.pool.connect();
    try {await c.query('BEGIN');await c.query('SELECT id FROM auth_guard WHERE id=1 FOR UPDATE');const result=await fn(c);await c.query('COMMIT');return result;}
    catch(error) {await c.query('ROLLBACK').catch(()=>{});throw error;} finally {c.release();}
  }
  /** The caller has locked the source comics and holds the auth transaction. */
  private async transferOperations(c:PoolClient,source:string,destination:string):Promise<void> {
    if(source===destination)return;
    const active=await c.query(`SELECT 1 FROM operations o WHERE o.owner=$1 AND (o.status IN ('queued','running','unknown_outcome') OR
      EXISTS(SELECT 1 FROM operation_steps s LEFT JOIN provider_reservations r ON r.id=s.reservation_id WHERE s.operation_id=o.id AND (s.state IN ('running','unknown') OR r.id IS NULL OR r.state IN ('running','unknown')))) LIMIT 1`,[source]);
    if(active.rowCount)throw new ClaimInProgressError('Wait for your existing draft generation to finish, then try again.');
    // Once a target row is locked, authorized starts lock that same row before
    // insertion. Lock the existing terminal rows before changing ownership.
    await c.query('SELECT id FROM operations WHERE owner=$1 FOR UPDATE',[source]);
    const invalidGrant=await c.query(`SELECT 1 FROM operations o LEFT JOIN mcp_grants g ON g.id=o.grant_id WHERE o.owner=$1 AND o.grant_id IS NOT NULL AND (g.id IS NULL OR g.owner<>o.owner) LIMIT 1`,[source]);
    if(invalidGrant.rowCount)throw new ClaimInProgressError('A saved operation references another connection; the drafts were not moved.');
    const collision=await c.query(`SELECT 1 FROM operations s JOIN operations d ON d.owner=$2 AND d.action=s.action AND d.request_key=s.request_key WHERE s.owner=$1 LIMIT 1`,[source,destination]);
    if(collision.rowCount)throw new ClaimInProgressError('A saved operation uses the same request key in both workspaces; the drafts were not moved.');
    try {await c.query('UPDATE operations SET owner=$1 WHERE owner=$2',[destination,source]);}
    catch(error){if((error as {code?:string}).code==='23505')throw new ClaimInProgressError('A saved operation uses the same request key in both workspaces; the drafts were not moved.');throw error;}
  }
  async createGuest(email:string,now=Date.now()):Promise<{token:string;owner:string}> {
    const token=randomBytes(32).toString('hex'),owner=randomBytes(32).toString('hex');
    await this.pool.query('INSERT INTO auth_guests(token_hash,owner,email,expires_at) VALUES ($1,$2,$3,$4)',[hash(token),owner,email,now+ttl]);return {token,owner};
  }
  async guestIdentity(token:string,now=Date.now()):Promise<{owner:string;email:string}|null> {return (await this.pool.query('SELECT owner,email FROM auth_guests WHERE token_hash=$1 AND expires_at>$2',[hash(token),now])).rows[0]??null;}
  async hasGuestToken(token:string):Promise<boolean> {return !!(await this.pool.query('SELECT 1 FROM auth_guests WHERE token_hash=$1',[hash(token)])).rowCount;}
  async hasLegacyOwner(owner:string):Promise<boolean> {return !!(await this.pool.query(`SELECT 1 FROM comics c WHERE c.owner=$1 AND c.import_batch_id IS NULL
    AND NOT EXISTS(SELECT 1 FROM auth_users u WHERE u.owner=c.owner) AND NOT EXISTS(SELECT 1 FROM auth_guests g WHERE g.owner=c.owner) LIMIT 1`,[owner])).rowCount;}
  async claimLegacyOwner(token:string,email:string,now=Date.now()):Promise<{owner:string;email:string}|null> {
    return this.locked(async c=>{
      const existing=(await c.query('SELECT owner,email FROM auth_guests WHERE token_hash=$1 AND expires_at>$2',[hash(token),now])).rows[0];if(existing)return existing;
      if((await c.query('SELECT 1 FROM auth_guests WHERE token_hash=$1',[hash(token)])).rowCount)return null;
      const rows=await c.query(`SELECT c.id FROM comics c WHERE c.owner=$1 AND c.import_batch_id IS NULL AND NOT EXISTS(SELECT 1 FROM auth_users u WHERE u.owner=c.owner) AND NOT EXISTS(SELECT 1 FROM auth_guests g WHERE g.owner=c.owner) FOR UPDATE`,[token]);if(!rows.rowCount)return null;
      const active=await c.query(`SELECT 1 FROM comics c WHERE c.owner=$1 AND c.import_batch_id IS NULL AND (
        EXISTS(SELECT 1 FROM comic_text_operations t WHERE t.comic_id=c.id AND t.state='running') OR
        EXISTS(SELECT 1 FROM jsonb_each(CASE WHEN jsonb_typeof(c.draft->'operations')='object' THEN c.draft->'operations' ELSE '{}'::jsonb END) o WHERE o.value='"running"'::jsonb) OR
        EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.draft->'pages')='array' THEN c.draft->'pages' ELSE '[]'::jsonb END) p,jsonb_array_elements(CASE WHEN jsonb_typeof(p->'panels')='array' THEN p->'panels' ELSE '[]'::jsonb END) n WHERE n->>'status'='checking')) LIMIT 1`,[token]);
      if(active.rowCount)throw new ClaimInProgressError('Wait for your existing draft generation to finish, then try again.');
      const owner=randomBytes(32).toString('hex');
      await this.transferOperations(c,token,owner);
      await c.query('INSERT INTO auth_guests(token_hash,owner,email,expires_at) VALUES ($1,$2,$3,$4)',[hash(token),owner,email,now+ttl]);
      await c.query(`UPDATE comics SET owner=$1,draft=jsonb_set(draft,'{ownerId}',to_jsonb($1::text),true),edition=CASE WHEN edition IS NOT NULL AND edition->>'sourceRevision'=revision::text THEN jsonb_set(edition,'{sourceRevision}',to_jsonb(revision+1),true) ELSE edition END,revision=revision+1 WHERE owner=$2 AND import_batch_id IS NULL`,[owner,token]);
      await c.query('UPDATE comic_text_operations SET owner=$1 WHERE owner=$2 AND comic_id IN (SELECT id FROM comics WHERE owner=$1 AND import_batch_id IS NULL)',[owner,token]);
      await c.query('UPDATE mcp_grants SET owner=$1 WHERE owner=$2',[owner,token]);return {owner,email};
    });
  }
  async updateGuestEmail(token:string,email:string,now=Date.now()):Promise<boolean> {return (await this.pool.query('UPDATE auth_guests SET email=$1 WHERE token_hash=$2 AND expires_at>$3',[email,hash(token),now])).rowCount===1;}
  async issueCode(email:string,code:string,browser:string,secret:string,now=Date.now()):Promise<string|null> {
    return this.locked(async c=>{
      await c.query('DELETE FROM auth_requests WHERE requested_at<$1',[now-3600000]);await c.query('DELETE FROM auth_codes WHERE expires_at<=$1',[now]);
      const emailHash=hash(email);
      const counts=(await c.query('SELECT count(*)::int AS total,count(*) FILTER (WHERE email_hash=$1 AND rejected=0)::int AS recent FROM auth_requests',[emailHash])).rows[0];
      if(counts.recent>=5||counts.total>=50)return null;
      const salt=randomBytes(32).toString('hex'),codeHash=createHmac('sha256',secret).update(`${salt}:${email}:${code}`).digest('hex');
      await c.query('INSERT INTO auth_requests(email_hash,requested_at,request_id) VALUES ($1,$2,$3)',[emailHash,now,salt]);
      await c.query('INSERT INTO auth_codes(email,code_hash,salt,browser_hash,expires_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(email) DO UPDATE SET code_hash=excluded.code_hash,salt=excluded.salt,browser_hash=excluded.browser_hash,expires_at=excluded.expires_at',[email,codeHash,salt,hash(browser),now+15*60*1000]);return salt;
    });
  }
  async invalidateCode(email:string,salt:string,knownRejected=false):Promise<void> {
    await this.locked(async c=>{await c.query('DELETE FROM auth_codes WHERE email=$1 AND salt=$2',[email,salt]);if(knownRejected) await c.query('UPDATE auth_requests SET rejected=1 WHERE email_hash=$1 AND request_id=$2',[hash(email),salt]);});
  }
  async consumeCode(email:string,code:string,secret:string,browser:string|null,anonymousOwner:string|null,now=Date.now()):Promise<{session:string;email:string;sameBrowser:boolean}|null> {
    return this.locked(async c=>{
      const emailHash=hash(email);await c.query('DELETE FROM auth_code_attempts WHERE attempted_at<$1',[now-15*60*1000]);
      const row=(await c.query('SELECT code_hash,salt,browser_hash FROM auth_codes WHERE email=$1 AND expires_at>$2',[email,now])).rows[0];
      if(!row)return null;
      const count=(await c.query('SELECT count(*)::int AS count FROM auth_code_attempts WHERE email_hash=$1',[emailHash])).rows[0].count;
      if(count>=10)return null;
      const supplied=createHmac('sha256',secret).update(`${row.salt}:${email}:${code}`).digest(),expected=Buffer.from(row.code_hash,'hex');
      if(expected.length!==supplied.length||!timingSafeEqual(expected,supplied)) {await c.query('INSERT INTO auth_code_attempts VALUES ($1,$2)',[emailHash,now]);return null;}
      await c.query('DELETE FROM auth_codes WHERE email=$1',[email]);
      const existing=(await c.query('SELECT owner FROM auth_users WHERE email=$1',[email])).rows[0];
      const owner=existing?.owner??randomBytes(32).toString('hex');
      if(!existing)await c.query('INSERT INTO auth_users(email,owner) VALUES ($1,$2)',[email,owner]);
      const sameBrowser=!!browser&&hash(browser)===row.browser_hash;
      if(anonymousOwner&&sameBrowser) {
        // Serializes against revision updates and text-operation reservations.
        await c.query('SELECT id FROM comics WHERE owner=$1 AND import_batch_id IS NULL FOR UPDATE',[anonymousOwner]);
        const active=await c.query(`SELECT 1 FROM comics c WHERE c.owner=$1 AND c.import_batch_id IS NULL AND (
          EXISTS(SELECT 1 FROM comic_text_operations t WHERE t.comic_id=c.id AND t.state='running') OR
          EXISTS(SELECT 1 FROM jsonb_each(CASE WHEN jsonb_typeof(c.draft->'operations')='object' THEN c.draft->'operations' ELSE '{}'::jsonb END) o WHERE o.value='"running"'::jsonb) OR
          EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.draft->'pages')='array' THEN c.draft->'pages' ELSE '[]'::jsonb END) p,
            jsonb_array_elements(CASE WHEN jsonb_typeof(p->'panels')='array' THEN p->'panels' ELSE '[]'::jsonb END) n WHERE n->>'status'='checking')
        ) LIMIT 1`,[anonymousOwner]);
        if(active.rowCount)throw new ClaimInProgressError('Wait for your existing draft generation to finish, then try signing in again.');
        await this.transferOperations(c,anonymousOwner,owner);
        await c.query(`UPDATE comics SET owner=$1,draft=jsonb_set(draft,'{ownerId}',to_jsonb($1::text),true),
          edition=CASE WHEN edition IS NOT NULL AND edition->>'sourceRevision'=revision::text THEN jsonb_set(edition,'{sourceRevision}',to_jsonb(revision+1),true) ELSE edition END,revision=revision+1
          WHERE owner=$2 AND import_batch_id IS NULL`,[owner,anonymousOwner]);
        await c.query('UPDATE comic_text_operations SET owner=$1 WHERE owner=$2 AND comic_id IN (SELECT id FROM comics WHERE owner=$1 AND import_batch_id IS NULL)',[owner,anonymousOwner]);
        await c.query('UPDATE mcp_grants SET owner=$1 WHERE owner=$2',[owner,anonymousOwner]);
        await c.query('DELETE FROM auth_guests WHERE owner=$1 AND NOT EXISTS (SELECT 1 FROM comics WHERE owner=$1 AND import_batch_id IS NOT NULL)',[anonymousOwner]);
      }
      const session=randomBytes(32).toString('hex');await c.query('DELETE FROM auth_sessions WHERE expires_at<=$1',[now]);
      await c.query('INSERT INTO auth_sessions(token_hash,owner,expires_at) VALUES ($1,$2,$3)',[hash(session),owner,now+ttl]);return {session,email,sameBrowser};
    });
  }
  async authIdentity(session:string,now=Date.now()):Promise<{owner:string;email:string}|null> {return (await this.pool.query('SELECT s.owner,u.email FROM auth_sessions s JOIN auth_users u ON u.owner=s.owner WHERE s.token_hash=$1 AND s.expires_at>$2',[hash(session),now])).rows[0]??null;}
  async signOut(session:string):Promise<void> {await this.pool.query('DELETE FROM auth_sessions WHERE token_hash=$1',[hash(session)]);}
}
