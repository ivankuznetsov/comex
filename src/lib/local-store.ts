import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export class ClaimInProgressError extends Error {}

/** Single-node local development store. Replace with managed persistence for deployment. */
export class LocalStore {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode = WAL;
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
      CREATE TABLE IF NOT EXISTS auth_users (email TEXT PRIMARY KEY, owner TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS auth_links (token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, browser_hash TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_sessions (token_hash TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_requests (email_hash TEXT NOT NULL, requested_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS auth_requests_time ON auth_requests(requested_at);`);
  }
  issueLink(email: string, token: string, browser: string, now = Date.now()): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM auth_requests WHERE requested_at < ?').run(now - 60 * 60 * 1000);
      this.db.prepare('DELETE FROM auth_links WHERE expires_at <= ?').run(now);
      const emailHash = hash(email);
      const recent = this.db.prepare('SELECT COUNT(*) AS count FROM auth_requests WHERE email_hash=? AND requested_at > ?').get(emailHash, now - 60 * 60 * 1000) as {count: number};
      const total = this.db.prepare('SELECT COUNT(*) AS count FROM auth_requests WHERE requested_at > ?').get(now - 60 * 60 * 1000) as {count: number};
      if (Number(recent.count) >= 5 || Number(total.count) >= 50) { this.db.exec('COMMIT'); return false; }
      this.db.prepare('INSERT INTO auth_requests VALUES (?,?)').run(emailHash, now);
      this.db.prepare('INSERT INTO auth_links VALUES (?,?,?,?)').run(hash(token), email, hash(browser), now + 15 * 60 * 1000);
      this.db.exec('COMMIT'); return true;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  invalidateLink(token: string): void { this.db.prepare('DELETE FROM auth_links WHERE token_hash=?').run(hash(token)); }
  inspectLink(token: string, now = Date.now()): {email:string} | null {
    return (this.db.prepare('SELECT email FROM auth_links WHERE token_hash=? AND expires_at>?').get(hash(token),now) as {email:string} | undefined) ?? null;
  }
  consumeLink(token: string, browser: string | null, anonymousOwner: string | null, now = Date.now()): {session: string; email: string; sameBrowser: boolean} | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const link = this.db.prepare('SELECT email,browser_hash FROM auth_links WHERE token_hash=? AND expires_at>?').get(hash(token), now) as {email:string;browser_hash:string} | undefined;
      if (!link) { this.db.exec('COMMIT'); return null; }
      this.db.prepare('DELETE FROM auth_links WHERE token_hash=?').run(hash(token));
      const existing = this.db.prepare('SELECT owner FROM auth_users WHERE email=?').get(link.email) as {owner:string} | undefined;
      const owner = existing?.owner ?? randomBytes(32).toString('hex');
      if (!existing) this.db.prepare('INSERT INTO auth_users VALUES (?,?)').run(link.email, owner);
      const sameBrowser = !!browser && hash(browser) === link.browser_hash;
      if (anonymousOwner && sameBrowser) {
        const active = this.db.prepare(`SELECT 1 FROM comics c WHERE c.owner=? AND (
          EXISTS(SELECT 1 FROM comic_text_operations t WHERE t.comic_id=c.id AND t.state='running') OR
          EXISTS(SELECT 1 FROM json_each(c.draft,'$.operations') o WHERE o.value='running') OR
          EXISTS(SELECT 1 FROM json_each(c.draft,'$.pages') p, json_each(p.value,'$.panels') n WHERE json_extract(n.value,'$.status')='checking')
        ) LIMIT 1`).get(anonymousOwner);
        if (active) throw new ClaimInProgressError('Wait for your existing draft generation to finish, then try signing in again.');
        this.db.prepare(`UPDATE comics SET owner=?, draft=json_set(draft, '$.ownerId', ?),
          edition=CASE WHEN edition IS NOT NULL AND json_extract(edition,'$.sourceRevision')=revision
            THEN json_set(edition,'$.sourceRevision',revision+1) ELSE edition END,
          revision=revision+1 WHERE owner=?`).run(owner, owner, anonymousOwner);
        this.db.prepare('UPDATE comic_text_operations SET owner=? WHERE owner=?').run(owner, anonymousOwner);
      }
      const session = randomBytes(32).toString('hex');
      this.db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(now);
      this.db.prepare('INSERT INTO auth_sessions VALUES (?,?,?)').run(hash(session), owner, now + 30 * 24 * 60 * 60 * 1000);
      this.db.exec('COMMIT'); return {session, email:link.email, sameBrowser};
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
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
  listOwned<T = unknown>(owner: string): T[] {
    const rows = this.db.prepare('SELECT draft FROM comics WHERE owner=? ORDER BY rowid DESC').all(owner) as {draft: string}[];
    return rows.map(row => JSON.parse(row.draft) as T);
  }
  update(id: string, owner: string, revision: number, data: unknown): boolean {
    return Number(this.db.prepare('UPDATE comics SET draft=?,revision=revision+1 WHERE id=? AND owner=? AND revision=?').run(JSON.stringify(data), id, owner, revision).changes) === 1;
  }
  /** Atomically reserve all story-related provider work for the unchanged draft. */
  reserveTextOperation(id: string, owner: string, revision: number): boolean {
    return Number(this.db.prepare(`INSERT OR IGNORE INTO comic_text_operations(comic_id,owner,state)
      SELECT id,owner,'running' FROM comics WHERE id=? AND owner=? AND revision=?`).run(id,owner,revision).changes) === 1;
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
  withdraw(id: string, owner: string): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const changed = Number(this.db.prepare('UPDATE comics SET edition=NULL,published_at=NULL,revision=revision+1 WHERE id=? AND owner=?').run(id, owner).changes) === 1;
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
