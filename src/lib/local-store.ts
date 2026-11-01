import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const GUEST_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export class ClaimInProgressError extends Error {}
export type PageJob = {id:string; comicId:string; pageId:string; owner:string; state:'running'|'completed'|'paused'|'failed'|'unknown'; message:string | null; createdAt:number};

/** Single-node local development store. Replace with managed persistence for deployment. */
export class LocalStore {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS comics (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, revision INTEGER NOT NULL,
        draft TEXT NOT NULL, edition TEXT, published_at TEXT
      );
      CREATE TABLE IF NOT EXISTS publication_assets (
        comic_id TEXT NOT NULL, asset_id TEXT NOT NULL, data BLOB NOT NULL,
        PRIMARY KEY (comic_id, asset_id)
      );
      CREATE TABLE IF NOT EXISTS comic_text_operations (
        comic_id TEXT PRIMARY KEY, owner TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('running', 'unknown'))
      );
      CREATE TABLE IF NOT EXISTS page_jobs (
        id TEXT PRIMARY KEY, comic_id TEXT NOT NULL, page_id TEXT NOT NULL, owner TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('running','completed','paused','failed','unknown')),
        message TEXT, created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS active_page_job ON page_jobs(comic_id) WHERE state IN ('running','unknown');
      CREATE TABLE IF NOT EXISTS advisory_reviews (
        comic_id TEXT NOT NULL, review_key TEXT NOT NULL, result TEXT NOT NULL,
        PRIMARY KEY(comic_id,review_key)
      );
      CREATE TABLE IF NOT EXISTS auth_users (email TEXT PRIMARY KEY, owner TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS auth_sessions (token_hash TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_requests (email_hash TEXT NOT NULL, requested_at INTEGER NOT NULL, request_id TEXT, rejected INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS auth_guests (token_hash TEXT PRIMARY KEY, owner TEXT NOT NULL UNIQUE, email TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_codes (email TEXT PRIMARY KEY, code_hash TEXT NOT NULL, salt TEXT NOT NULL, browser_hash TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_code_attempts (email_hash TEXT NOT NULL, attempted_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS auth_requests_time ON auth_requests(requested_at);
      CREATE TABLE IF NOT EXISTS mcp_grants (id TEXT PRIMARY KEY, owner TEXT NOT NULL, client_id TEXT NOT NULL, session_id TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL, client_name TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER);
      CREATE INDEX IF NOT EXISTS mcp_grants_owner ON mcp_grants(owner);`);
    // Existing guest tables predate server-side expiry. Preserve their sessions
    // for one cookie lifetime from migration, without extending them on restart.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const columns=this.db.prepare('PRAGMA table_info(auth_guests)').all() as {name:string}[];
      if (!columns.some(column=>column.name==='expires_at')) {
        this.db.exec('ALTER TABLE auth_guests ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0');
        this.db.prepare('UPDATE auth_guests SET expires_at=? WHERE expires_at=0').run(Date.now()+GUEST_TTL_MS);
      }
      const requestColumns=this.db.prepare('PRAGMA table_info(auth_requests)').all() as {name:string}[];
      if (!requestColumns.some(column=>column.name==='request_id')) this.db.exec('ALTER TABLE auth_requests ADD COLUMN request_id TEXT');
      if (!requestColumns.some(column=>column.name==='rejected')) this.db.exec('ALTER TABLE auth_requests ADD COLUMN rejected INTEGER NOT NULL DEFAULT 0');
      this.db.exec('COMMIT');
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
  createGuest(email:string,now=Date.now()): {token:string; owner:string} {
    const token=randomBytes(32).toString('hex'), owner=randomBytes(32).toString('hex');
    this.db.prepare('INSERT INTO auth_guests(token_hash,owner,email,expires_at) VALUES (?,?,?,?)').run(hash(token),owner,email,now+GUEST_TTL_MS);
    return {token,owner};
  }
  guestIdentity(token:string,now=Date.now()): {owner:string;email:string} | null {
    return (this.db.prepare('SELECT owner,email FROM auth_guests WHERE token_hash=? AND expires_at>?').get(hash(token),now) as {owner:string;email:string}|undefined) ?? null;
  }
  hasGuestToken(token:string): boolean {
    return !!this.db.prepare('SELECT 1 FROM auth_guests WHERE token_hash=?').get(hash(token));
  }
  /** Legacy browser sessions used their bearer token directly as draft owner. */
  hasLegacyOwner(owner:string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM comics c WHERE c.owner=?
      AND NOT EXISTS(SELECT 1 FROM auth_users u WHERE u.owner=c.owner)
      AND NOT EXISTS(SELECT 1 FROM auth_guests g WHERE g.owner=c.owner) LIMIT 1`).get(owner);
  }
  /** Called inside the same write transaction as the draft and grant transfer. */
  private transferOperations(source:string,destination:string):void {
    if(source===destination)return;
    const tables=this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('operations','operation_dispatch_intents','operation_steps','operation_checkpoints')").all() as {name:string}[];
    if(tables.length===0)return; // Databases created before U5 have no operation history.
    if(tables.length!==4)throw new Error('Operation history is incomplete; the claim cannot continue.');
    const active=this.db.prepare(`SELECT 1 FROM operations o WHERE o.owner=? AND (o.status IN ('queued','running','unknown_outcome') OR
      EXISTS(SELECT 1 FROM operation_steps s LEFT JOIN provider_reservations r ON r.id=s.reservation_id WHERE s.operation_id=o.id AND (s.state IN ('running','unknown') OR r.id IS NULL OR r.state IN ('running','unknown')))) LIMIT 1`).get(source);
    if(active)throw new ClaimInProgressError('Wait for your existing draft generation to finish, then try again.');
    const invalidGrant=this.db.prepare(`SELECT 1 FROM operations o LEFT JOIN mcp_grants g ON g.id=o.grant_id WHERE o.owner=? AND o.grant_id IS NOT NULL AND (g.id IS NULL OR g.owner<>o.owner) LIMIT 1`).get(source);
    if(invalidGrant)throw new ClaimInProgressError('A saved operation references another connection; the drafts were not moved.');
    const collision=this.db.prepare(`SELECT 1 FROM operations s JOIN operations d ON d.owner=? AND d.action=s.action AND d.request_key=s.request_key WHERE s.owner=? LIMIT 1`).get(destination,source);
    if(collision)throw new ClaimInProgressError('A saved operation uses the same request key in both workspaces; the drafts were not moved.');
    this.db.prepare('UPDATE operations SET owner=? WHERE owner=?').run(destination,source);
  }
  /** Convert a proven legacy cookie capability into a separate stable owner. */
  claimLegacyOwner(token:string,email:string,now=Date.now()): {owner:string;email:string} | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing=this.guestIdentity(token,now);if(existing){this.db.exec('COMMIT');return existing;}
      if(this.hasGuestToken(token) || !this.hasLegacyOwner(token)){this.db.exec('COMMIT');return null;}
      const active=this.db.prepare(`SELECT 1 FROM comics c WHERE c.owner=? AND (
        EXISTS(SELECT 1 FROM comic_text_operations t WHERE t.comic_id=c.id AND t.state='running') OR
        EXISTS(SELECT 1 FROM json_each(c.draft,'$.operations') o WHERE o.value='running') OR
        EXISTS(SELECT 1 FROM json_each(c.draft,'$.pages') p, json_each(p.value,'$.panels') n WHERE json_extract(n.value,'$.status')='checking')) LIMIT 1`).get(token);
      if(active)throw new ClaimInProgressError('Wait for your existing draft generation to finish, then try again.');
      const owner=randomBytes(32).toString('hex');
      this.transferOperations(token,owner);
      this.db.prepare('INSERT INTO auth_guests(token_hash,owner,email,expires_at) VALUES (?,?,?,?)').run(hash(token),owner,email,now+GUEST_TTL_MS);
      this.db.prepare(`UPDATE comics SET owner=?,draft=json_set(draft,'$.ownerId',?), edition=CASE WHEN edition IS NOT NULL AND json_extract(edition,'$.sourceRevision')=revision THEN json_set(edition,'$.sourceRevision',revision+1) ELSE edition END,revision=revision+1 WHERE owner=?`).run(owner,owner,token);
      this.db.prepare('UPDATE comic_text_operations SET owner=? WHERE owner=?').run(owner,token);
      this.db.prepare('UPDATE mcp_grants SET owner=? WHERE owner=?').run(owner,token);
      this.db.exec('COMMIT');return {owner,email};
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  updateGuestEmail(token:string,email:string,now=Date.now()): boolean {
    return Number(this.db.prepare('UPDATE auth_guests SET email=? WHERE token_hash=? AND expires_at>?').run(email,hash(token),now).changes)===1;
  }
  issueCode(email:string, code:string, browser:string, secret:string, now=Date.now()): string | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM auth_requests WHERE requested_at < ?').run(now-3600000);
      this.db.prepare('DELETE FROM auth_codes WHERE expires_at <= ?').run(now);
      const emailHash=hash(email);
      const recent=this.db.prepare('SELECT COUNT(*) AS count FROM auth_requests WHERE email_hash=? AND rejected=0').get(emailHash) as {count:number};
      const total=this.db.prepare('SELECT COUNT(*) AS count FROM auth_requests').get() as {count:number};
      if (Number(recent.count)>=5 || Number(total.count)>=50) {this.db.exec('COMMIT'); return null;}
      const salt=randomBytes(32).toString('hex');
      const codeHash=createHmac('sha256',secret).update(`${salt}:${email}:${code}`).digest('hex');
      this.db.prepare('INSERT INTO auth_requests(email_hash,requested_at,request_id) VALUES (?,?,?)').run(emailHash,now,salt);
      this.db.prepare('INSERT OR REPLACE INTO auth_codes VALUES (?,?,?,?,?)').run(email,codeHash,salt,hash(browser),now+15*60*1000);
      this.db.exec('COMMIT');return salt;
    } catch (error) {this.db.exec('ROLLBACK');throw error;}
  }
  invalidateCode(email:string,salt:string,knownRejected=false): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM auth_codes WHERE email=? AND salt=?').run(email,salt);
      // Count every outbound attempt globally, but allow the address to recover
      // after a definite provider rejection. Ambiguous failures remain charged.
      if (knownRejected) this.db.prepare('UPDATE auth_requests SET rejected=1 WHERE email_hash=? AND request_id=?').run(hash(email),salt);
      this.db.exec('COMMIT');
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
  consumeCode(email:string,code:string,secret:string,browser:string|null,anonymousOwner:string|null,now=Date.now()): {session:string;email:string;sameBrowser:boolean}|null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const emailHash=hash(email);
      this.db.prepare('DELETE FROM auth_code_attempts WHERE attempted_at < ?').run(now-15*60*1000);
      const row=this.db.prepare('SELECT code_hash,salt,browser_hash FROM auth_codes WHERE email=? AND expires_at>?').get(email,now) as {code_hash:string;salt:string;browser_hash:string}|undefined;
      if (!row) {this.db.exec('COMMIT');return null;}
      const count=this.db.prepare('SELECT COUNT(*) AS count FROM auth_code_attempts WHERE email_hash=?').get(emailHash) as {count:number};
      if (Number(count.count)>=10) {this.db.exec('COMMIT');return null;}
      const supplied=createHmac('sha256',secret).update(`${row.salt}:${email}:${code}`).digest();
      const expected=Buffer.from(row.code_hash,'hex');
      if (expected.length!==supplied.length || !timingSafeEqual(expected,supplied)) {
        this.db.prepare('INSERT INTO auth_code_attempts VALUES (?,?)').run(emailHash,now);
        this.db.exec('COMMIT');return null;
      }
      this.db.prepare('DELETE FROM auth_codes WHERE email=?').run(email);
      const existing=this.db.prepare('SELECT owner FROM auth_users WHERE email=?').get(email) as {owner:string}|undefined;
      const owner=existing?.owner ?? randomBytes(32).toString('hex');
      if (!existing) this.db.prepare('INSERT INTO auth_users VALUES (?,?)').run(email,owner);
      const sameBrowser=!!browser && hash(browser)===row.browser_hash;
      if (anonymousOwner && sameBrowser) {
        const active=this.db.prepare(`SELECT 1 FROM comics c WHERE c.owner=? AND (
          EXISTS(SELECT 1 FROM comic_text_operations t WHERE t.comic_id=c.id AND t.state='running') OR
          EXISTS(SELECT 1 FROM page_jobs j WHERE j.comic_id=c.id AND j.state IN ('running','unknown')) OR
          EXISTS(SELECT 1 FROM json_each(c.draft,'$.operations') o WHERE o.value='running')
        ) LIMIT 1`).get(anonymousOwner);
        if (active) throw new ClaimInProgressError('Wait for your existing draft generation to finish, then try signing in again.');
        this.transferOperations(anonymousOwner,owner);
        this.db.prepare(`UPDATE comics SET owner=?,draft=json_set(draft,'$.ownerId',?), edition=CASE WHEN edition IS NOT NULL AND json_extract(edition,'$.sourceRevision')=revision THEN json_set(edition,'$.sourceRevision',revision+1) ELSE edition END,revision=revision+1 WHERE owner=?`).run(owner,owner,anonymousOwner);
        this.db.prepare('UPDATE comic_text_operations SET owner=? WHERE owner=?').run(owner,anonymousOwner);
        this.db.prepare('UPDATE mcp_grants SET owner=? WHERE owner=?').run(owner,anonymousOwner);
        this.db.prepare('UPDATE page_jobs SET owner=? WHERE owner=?').run(owner,anonymousOwner);
        this.db.prepare('DELETE FROM auth_guests WHERE owner=?').run(anonymousOwner);
      }
      const session=randomBytes(32).toString('hex');
      this.db.prepare('DELETE FROM auth_sessions WHERE expires_at<=?').run(now);
      this.db.prepare('INSERT INTO auth_sessions VALUES (?,?,?)').run(hash(session),owner,now+30*24*60*60*1000);
      this.db.exec('COMMIT');return {session,email,sameBrowser};
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
  authIdentity(session: string, now = Date.now()): {owner: string; email: string} | null {
    const row = this.db.prepare('SELECT s.owner,u.email FROM auth_sessions s JOIN auth_users u ON u.owner=s.owner WHERE s.token_hash=? AND s.expires_at>?').get(hash(session),now) as {owner:string; email:string} | undefined;
    return row ?? null;
  }
  signOut(session: string): void { this.db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').run(hash(session)); }
  create(id: string, owner: string, data: unknown): void {
    this.db.prepare('INSERT INTO comics(id,owner,revision,draft) VALUES(?,?,1,?)').run(id, owner, JSON.stringify(data));
  }
  getOwned<T = unknown>(id: string, owner: string): {revision: number; data: T} | null {
    const row = this.db.prepare('SELECT revision,draft FROM comics WHERE id=? AND owner=?').get(id, owner) as {revision: number; draft: string} | undefined;
    return row ? { revision: Number(row.revision), data: JSON.parse(row.draft) as T } : null;
  }
  /** Internal background work may finish after a verified guest draft is claimed. */
  getReviewTarget<T = unknown>(id:string):{owner:string;revision:number;data:T}|null {
    const row=this.db.prepare('SELECT owner,revision,draft FROM comics WHERE id=?').get(id) as {owner:string;revision:number;draft:string}|undefined;
    return row ? {owner:row.owner,revision:Number(row.revision),data:JSON.parse(row.draft) as T} : null;
  }
  listOwned<T = unknown>(owner: string): T[] {
    const rows = this.db.prepare('SELECT draft FROM comics WHERE owner=? ORDER BY rowid DESC').all(owner) as {draft: string}[];
    return rows.map(row => JSON.parse(row.draft) as T);
  }
  update(id: string, owner: string, revision: number, data: unknown): boolean {
    return Number(this.db.prepare('UPDATE comics SET draft=?,revision=revision+1 WHERE id=? AND owner=? AND revision=?').run(JSON.stringify(data), id, owner, revision).changes) === 1;
  }
  updateWithoutActivePageJob(id:string,owner:string,revision:number,data:unknown):boolean {
    return Number(this.db.prepare(`UPDATE comics SET draft=?,revision=revision+1 WHERE id=? AND owner=? AND revision=?
      AND NOT EXISTS(SELECT 1 FROM page_jobs WHERE comic_id=comics.id AND state IN ('running','unknown'))`).run(JSON.stringify(data),id,owner,revision).changes)===1;
  }
  /** Reviews are version-keyed metadata and never alter the creator's draft revision. */
  putAdvisoryReview(id:string, owner:string, key:string, result:unknown): boolean {
    return Number(this.db.prepare(`INSERT INTO advisory_reviews(comic_id,review_key,result)
      SELECT id,?,? FROM comics WHERE id=? AND owner=?
      ON CONFLICT(comic_id,review_key) DO UPDATE SET result=excluded.result`).run(key,JSON.stringify(result),id,owner).changes) === 1;
  }
  getAdvisoryReview<T=unknown>(id:string,key:string):T|null {
    const row=this.db.prepare('SELECT result FROM advisory_reviews WHERE comic_id=? AND review_key=?').get(id,key) as {result:string}|undefined;
    return row ? JSON.parse(row.result) as T : null;
  }
  /** Atomically reserve all story-related provider work for the unchanged draft. */
  reserveTextOperation(id: string, owner: string, revision: number): boolean {
    return Number(this.db.prepare(`INSERT OR IGNORE INTO comic_text_operations(comic_id,owner,state)
      SELECT id,owner,'running' FROM comics WHERE id=? AND owner=? AND revision=?
      AND NOT EXISTS (SELECT 1 FROM page_jobs j WHERE j.comic_id=comics.id AND j.state IN ('running','unknown'))`).run(id,owner,revision).changes) === 1;
  }
  pageJob(id:string, owner:string, pageId:string, requestId?:string):PageJob|null {
    const suffix=requestId ? ' AND id=?' : '';
    const sql=`SELECT id,comic_id AS comicId,page_id AS pageId,owner,state,message,created_at AS createdAt FROM page_jobs WHERE comic_id=? AND owner=? AND page_id=?${suffix} ORDER BY created_at DESC,rowid DESC LIMIT 1`;
    const args=requestId ? [id,owner,pageId,requestId] : [id,owner,pageId];
    return (this.db.prepare(sql).get(...args) as PageJob|undefined) ?? null;
  }
  hasActivePageJob(id:string,owner:string):boolean {
    return !!this.db.prepare("SELECT 1 FROM page_jobs WHERE comic_id=? AND owner=? AND state IN ('running','unknown') LIMIT 1").get(id,owner);
  }
  activePageJob(id:string,owner:string):PageJob|null {
    return (this.db.prepare("SELECT id,comic_id AS comicId,page_id AS pageId,owner,state,message,created_at AS createdAt FROM page_jobs WHERE comic_id=? AND owner=? AND state IN ('running','unknown') LIMIT 1").get(id,owner) as PageJob|undefined) ?? null;
  }
  /** Idempotency key and active-job reservation are checked in the same write transaction. */
  beginPageJob(id:string,owner:string,pageId:string,requestId:string,revision:number):{job:PageJob;created:boolean}|null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior=this.pageJob(id,owner,pageId,requestId);
      if (prior) {this.db.exec('COMMIT');return {job:prior,created:false};}
      const active=this.db.prepare("SELECT id FROM page_jobs WHERE comic_id=? AND state IN ('running','unknown')").get(id) as {id:string}|undefined;
      if (active) {this.db.exec('COMMIT');return null;}
      const eligible=this.db.prepare(`SELECT 1 FROM comics c WHERE id=? AND owner=? AND revision=?
        AND NOT EXISTS(SELECT 1 FROM comic_text_operations t WHERE t.comic_id=c.id AND t.state IN ('running','unknown'))`).get(id,owner,revision);
      if (!eligible) {this.db.exec('COMMIT');return null;}
      this.db.prepare("INSERT INTO page_jobs(id,comic_id,page_id,owner,state,message,created_at) VALUES(?,?,?,?,'running',NULL,?)").run(requestId,id,pageId,owner,Date.now());
      const job=this.pageJob(id,owner,pageId,requestId)!;
      this.db.exec('COMMIT');return {job,created:true};
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
  finishPageJob(id:string,owner:string,state:'completed'|'paused'|'failed'|'unknown',message:string|null):void {
    if (Number(this.db.prepare("UPDATE page_jobs SET state=?,message=? WHERE id=? AND owner=? AND state='running'").run(state,message,id,owner).changes)!==1) throw new Error('Page job could not be finalized.');
  }
  finishTextOperation(id: string, owner: string, unknown: boolean): void {
    if (unknown) this.db.prepare("UPDATE comic_text_operations SET state='unknown' WHERE comic_id=? AND owner=? AND state='running'").run(id,owner);
    else this.db.prepare("DELETE FROM comic_text_operations WHERE comic_id=? AND owner=? AND state='running'").run(id,owner);
  }
  publish(id: string, owner: string, revision: number, edition: unknown, assets: {id: string; data: Uint8Array}[] = []): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const changed = Number(this.db.prepare('UPDATE comics SET edition=?,published_at=?,revision=revision+1 WHERE id=? AND owner=? AND revision=?').run(JSON.stringify(edition), new Date().toISOString(), id, owner, revision).changes) === 1;
      if (changed) {
        this.db.prepare('DELETE FROM publication_assets WHERE comic_id=?').run(id);
        const insert = this.db.prepare('INSERT INTO publication_assets(comic_id,asset_id,data) VALUES(?,?,?)');
        for (const asset of assets) insert.run(id, asset.id, asset.data);
      }
      this.db.exec('COMMIT');
      return changed;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  withdraw(id: string, owner: string, revision?: number): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const changed = Number(this.db.prepare('UPDATE comics SET edition=NULL,published_at=NULL,revision=revision+1 WHERE id=? AND owner=? AND (? IS NULL OR revision=?)').run(id, owner, revision ?? null, revision ?? null).changes) === 1;
      if (changed) this.db.prepare('DELETE FROM publication_assets WHERE comic_id=?').run(id);
      this.db.exec('COMMIT');
      return changed;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  getPublicationAsset(id: string, assetId: string): Uint8Array | null {
    const row = this.db.prepare('SELECT data FROM publication_assets WHERE comic_id=? AND asset_id=?').get(id, assetId) as {data: Uint8Array} | undefined;
    return row?.data ?? null;
  }
  getPublished<T = unknown>(id: string): T | null {
    const row = this.db.prepare('SELECT edition FROM comics WHERE id=? AND edition IS NOT NULL').get(id) as {edition: string} | undefined;
    return row ? JSON.parse(row.edition) as T : null;
  }
  listPublished<T = unknown>(): T[] {
    const rows = this.db.prepare('SELECT edition FROM comics WHERE edition IS NOT NULL ORDER BY published_at DESC LIMIT 100').all() as {edition: string}[];
    return rows.map(row => JSON.parse(row.edition) as T);
  }
  close(): void { this.db.close(); }
}
