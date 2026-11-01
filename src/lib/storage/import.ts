import {DatabaseSync} from 'node:sqlite';
import {createHash, randomUUID} from 'node:crypto';
import {readdir, readFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import type {Pool} from 'pg';
import {sha256, type PrivateObjects} from './assets';

type Row=Record<string, string|number|Uint8Array|null>;
const tables=['comics','publication_assets','comic_text_operations','auth_users','auth_sessions','auth_requests','auth_guests','auth_codes','auth_code_attempts','provider_reservations'] as const;

/** Import a caller-selected SQLite snapshot and asset directory. Never opens the source for writing. */
export async function importSqlite({pool,objects,databasePath,budgetPath,assetPath,batchId}:{pool:Pool;objects:PrivateObjects;databasePath:string;budgetPath?:string;assetPath:string;batchId:string}):Promise<void> {
  const source=new DatabaseSync(databasePath,{readOnly:true});
  const snapshot={} as Record<typeof tables[number],Row[]>;
  try {
    source.exec('BEGIN');
    const existing=new Set((source.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(r=>r.name));
    for(const table of tables) snapshot[table]=existing.has(table) ? source.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Row[] : [];
    source.exec('COMMIT');
  } finally {source.close();}
  if(budgetPath && resolve(budgetPath)!==resolve(databasePath)) {
    const budget=new DatabaseSync(budgetPath,{readOnly:true});
    try {
      budget.exec('BEGIN');
      const exists=budget.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='provider_reservations'").get();
      if(!exists) throw new Error('The selected budget database has no provider reservation table.');
      snapshot.provider_reservations=budget.prepare('SELECT * FROM provider_reservations ORDER BY rowid').all() as Row[];
      budget.exec('COMMIT');
    } finally {budget.close();}
  }
  const files=await readdir(assetPath);
  const privateAssets=[] as {id:string;data:Buffer;hash:string}[];
  for(const name of files.sort()) if(/^[0-9a-f-]{36}\.png$/i.test(name)) {
    const data=await readFile(join(assetPath,name));privateAssets.push({id:name.slice(0,-4),data,hash:sha256(data)});
  }
  const fingerprint=createHash('sha256').update(JSON.stringify({snapshot,assets:privateAssets.map(({id,hash})=>({id,hash}))})).digest('hex');
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['comex-sqlite-import']);
    await client.query('SELECT id FROM provider_budget_guard WHERE id=1 FOR UPDATE');
    const prior=(await client.query('SELECT fingerprint FROM import_batches WHERE id=$1',[batchId])).rows[0];
    if(prior) {
      if(prior.fingerprint!==fingerprint) throw new Error('Import batch already exists with different source data.');
      await client.query('COMMIT');return;
    }
    await client.query('INSERT INTO import_batches(id,fingerprint) VALUES ($1,$2)',[batchId,fingerprint]);
    for(const r of snapshot.comics) await client.query('INSERT INTO comics(id,owner,revision,draft,edition,published_at,import_batch_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',[r.id,r.owner,r.revision,r.draft,r.edition,r.published_at,batchId]);
    for(const r of snapshot.comic_text_operations) await client.query('INSERT INTO comic_text_operations(comic_id,owner,state) VALUES ($1,$2,$3)',[r.comic_id,r.owner,r.state]);
    for(const a of privateAssets) {
      const path=await objects.put(`imports/${randomUUID()}.png`,a.data);
      await client.query('INSERT INTO assets(id,object_path,sha256) VALUES ($1,$2,$3)',[a.id,path,a.hash]);
    }
    for(const r of snapshot.publication_assets) {
      const data=r.data as Uint8Array,path=await objects.put(`editions/${randomUUID()}.png`,data);
      await client.query('INSERT INTO publication_assets(comic_id,asset_id,object_path,sha256) VALUES ($1,$2,$3,$4)',[r.comic_id,r.asset_id,path,sha256(data)]);
    }
    for(const r of snapshot.auth_users) await client.query('INSERT INTO auth_users(email,owner) VALUES ($1,$2)',[r.email,r.owner]);
    for(const r of snapshot.auth_sessions) await client.query('INSERT INTO auth_sessions(token_hash,owner,expires_at) VALUES ($1,$2,$3)',[r.token_hash,r.owner,r.expires_at]);
    for(const r of snapshot.auth_requests) await client.query('INSERT INTO auth_requests(email_hash,requested_at,request_id,rejected) VALUES ($1,$2,$3,$4)',[r.email_hash,r.requested_at,r.request_id??null,r.rejected??0]);
    for(const r of snapshot.auth_guests) await client.query('INSERT INTO auth_guests(token_hash,owner,email,expires_at) VALUES ($1,$2,$3,$4)',[r.token_hash,r.owner,r.email,r.expires_at??Date.now()+30*24*60*60*1000]);
    for(const r of snapshot.auth_codes) await client.query('INSERT INTO auth_codes(email,code_hash,salt,browser_hash,expires_at) VALUES ($1,$2,$3,$4,$5)',[r.email,r.code_hash,r.salt,r.browser_hash,r.expires_at]);
    for(const r of snapshot.auth_code_attempts) await client.query('INSERT INTO auth_code_attempts(email_hash,attempted_at) VALUES ($1,$2)',[r.email_hash,r.attempted_at]);
    for(const r of snapshot.provider_reservations) await client.query('INSERT INTO provider_reservations(id,state,created_at,updated_at,step_key) VALUES ($1,$2,$3,$4,$5)',[r.id,r.state,r.created_at,r.updated_at,r.step_key??null]);
    await client.query('COMMIT');
  } catch(e) {await client.query('ROLLBACK').catch(()=>{});throw e;} finally {client.release();}
}
