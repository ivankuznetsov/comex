import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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
      );`);
  }
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
