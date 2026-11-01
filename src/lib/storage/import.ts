import {DatabaseSync} from 'node:sqlite';
import {createHash, randomUUID} from 'node:crypto';
import {readdir, readFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import type {Pool} from 'pg';
import {sha256, type PrivateObjects} from './assets';

type Row=Record<string, string|number|Uint8Array|null>;
const legacyTables=['comics','publication_assets','comic_text_operations','auth_users','auth_sessions','auth_requests','auth_guests','auth_codes','auth_code_attempts','provider_reservations'] as const;
const operationTables=['operations','operation_dispatch_intents','operation_steps','operation_checkpoints'] as const;
const tables=[...legacyTables,...operationTables,'mcp_grants','advisory_reviews'] as const;
/** Import owner IDs cannot be used as browser credentials before redemption. */
export const importOwnerPrefix=(batchId:string)=>`import:${createHash('sha256').update(batchId).digest('hex')}:`;
export const importStagedOwner=(batchId:string,owner:string)=>importOwnerPrefix(batchId)+owner;

const isRecord=(value:unknown):value is Record<string,unknown> => !!value && typeof value==='object' && !Array.isArray(value);

/** Fold only current-version advisory evidence into the imported draft, as the local editor does. */
function resolveImportedAdvisories(raw:string, reviews:Map<string,unknown>):string {
  const draft:unknown=JSON.parse(raw);
  if(!isRecord(draft))return raw;
  const validReview=(value:unknown):value is {outcome:'pass'|'findings'|'inconclusive'|'failed';findings:unknown[]} =>
    isRecord(value) && typeof value.outcome==='string' && ['pass','findings','inconclusive','failed'].includes(value.outcome) && Array.isArray(value.findings);
  let changed=false;
  if(typeof draft.storyReviewRunId==='string') {
    const story=reviews.get(`story:${draft.storyReviewRunId}:${draft.storyRevision}`);
    if(validReview(story)){draft.storyReview=story;changed=true;}
  }
  const panelReviews=isRecord(draft.panelReviews)?{...draft.panelReviews}:{};
  const panelFindings=isRecord(draft.panelFindings)?{...draft.panelFindings}:{};
  if(Array.isArray(draft.pages)) for(const page of draft.pages) {
    if(!isRecord(page) || !Array.isArray(page.panels))continue;
    for(const panel of page.panels) {
      if(!isRecord(panel) || typeof panel.id!=='string' || typeof panel.assetId!=='string' || panel.storyRevision!==draft.storyRevision || panel.status==='outdated')continue;
      const review=reviews.get(`panel:${panel.id}:${panel.assetId}:${panel.storyRevision}:${panel.revision}`);
      if(!validReview(review))continue;
      panelReviews[panel.id]={assetId:panel.assetId,storyRevision:panel.storyRevision,panelRevision:panel.revision,outcome:review.outcome};
      panelFindings[panel.id]=review.findings;changed=true;
      if(panel.status==='checking') {
        const evaluation=review.findings.some(f=>isRecord(f) && f.severity==='blocker')?'blocker':review.findings.some(f=>isRecord(f) && f.severity==='warning')?'warning':review.outcome==='pass'?'pass':'uncertain';
        panel.evaluation=evaluation;panel.status=evaluation==='pass'?'current':'needs_review';
      }
    }
  }
  if(!changed)return raw;
  draft.panelReviews=panelReviews;draft.panelFindings=panelFindings;
  return JSON.stringify(draft);
}

/** Import a caller-selected SQLite snapshot and asset directory. Never opens the source for writing. */
export async function importSqlite({pool,objects,databasePath,budgetPath,assetPath,batchId}:{pool:Pool;objects:PrivateObjects;databasePath:string;budgetPath?:string;assetPath:string;batchId:string}):Promise<void> {
  const source=new DatabaseSync(databasePath,{readOnly:true});
  const snapshot={} as Record<typeof tables[number],Row[]>;
  try {
    source.exec('BEGIN');
    const existing=new Set((source.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(r=>r.name));
    const operationTableCount=operationTables.filter(table=>existing.has(table)).length;
    if(operationTableCount!==0 && operationTableCount!==operationTables.length)throw new Error('The source operation history is incomplete; import was not started.');
    for(const table of tables) snapshot[table]=existing.has(table) ? source.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Row[] : [];
    source.exec('COMMIT');
  } finally {source.close();}
  if(budgetPath && resolve(budgetPath)!==resolve(databasePath)) {
    const budget=new DatabaseSync(budgetPath,{readOnly:true});
    try {
      budget.exec('BEGIN');
      const exists=budget.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='provider_reservations'").get();
      if(!exists) throw new Error('The selected budget database has no provider reservation table.');
      const budgetTables=new Set((budget.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(row=>row.name));
      const budgetOperationTables=operationTables.filter(table=>budgetTables.has(table));
      if((budgetOperationTables.length!==0 && budgetOperationTables.length!==operationTables.length) || snapshot.operations.length || budgetOperationTables.some(table=>!!budget.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()))throw new Error('Operation history and its budget must come from the same SQLite snapshot.');
      snapshot.provider_reservations=budget.prepare('SELECT * FROM provider_reservations ORDER BY rowid').all() as Row[];
      budget.exec('COMMIT');
    } finally {budget.close();}
  }
  const comicOwners=new Map(snapshot.comics.map(row=>[row.id,row.owner]));
  const operationIds=new Set(snapshot.operations.map(row=>row.id));
  const reservationsById=new Map(snapshot.provider_reservations.map(row=>[row.id,row]));
  const grantsById=new Map(snapshot.mcp_grants.map(row=>[row.id,row]));
  for(const operation of snapshot.operations) {
    if(typeof operation.owner!=='string' || !/^[a-f0-9]{64}$/.test(operation.owner))throw new Error('An operation has an owner that cannot be verified for handoff.');
    if(comicOwners.has(operation.target_id) && comicOwners.get(operation.target_id)!==operation.owner)throw new Error('An operation references another owner’s draft.');
    if(['queued','running','unknown_outcome'].includes(String(operation.status)))throw new Error('Finish or resolve active operations before importing.');
    if(!['succeeded','needs_review','failed','obsolete','revoked'].includes(String(operation.status)))throw new Error('Operation history has an invalid status.');
    if(operation.grant_id && grantsById.get(operation.grant_id)?.owner!==operation.owner)throw new Error('An operation references a missing or mismatched connection.');
  }
  for(const grant of snapshot.mcp_grants)if(typeof grant.owner!=='string' || !/^[a-f0-9]{64}$/.test(grant.owner))throw new Error('A connection has an owner that cannot be verified for handoff.');
  for(const table of ['operation_dispatch_intents','operation_steps','operation_checkpoints'] as const)
    for(const row of snapshot[table])if(!operationIds.has(row.operation_id))throw new Error('Operation history contains an orphaned record.');
  for(const step of snapshot.operation_steps) {
    if(['running','unknown'].includes(String(step.state)))throw new Error('Finish or resolve active operations before importing.');
    if(!['completed','failed'].includes(String(step.state)))throw new Error('Operation history has an invalid step state.');
    const reservation=reservationsById.get(step.reservation_id);
    if(!reservation)throw new Error('Operation history is missing a budget reservation.');
    if(reservation.state!=='completed')throw new Error('Finish or resolve active operations before importing.');
  }
  const files=await readdir(assetPath);
  const privateAssets=[] as {id:string;data:Buffer;hash:string}[];
  for(const name of files.sort()) if(/^[0-9a-f-]{36}\.png$/i.test(name)) {
    const data=await readFile(join(assetPath,name));privateAssets.push({id:name.slice(0,-4),data,hash:sha256(data)});
  }
  // Preserve fingerprints of pre-U5 imports that have no additional records.
  const fingerprintSnapshot:Record<string,Row[]>=Object.fromEntries(legacyTables.map(table=>[table,snapshot[table]]));
  if(operationTables.some(table=>snapshot[table].length) || snapshot.mcp_grants.length)for(const table of [...operationTables,'mcp_grants'] as const)fingerprintSnapshot[table]=snapshot[table];
  if(snapshot.advisory_reviews.length)fingerprintSnapshot.advisory_reviews=snapshot.advisory_reviews;
  const fingerprint=createHash('sha256').update(JSON.stringify({snapshot:fingerprintSnapshot,assets:privateAssets.map(({id,hash})=>({id,hash}))})).digest('hex');
  const reviewsByComic=new Map<string,Map<string,unknown>>();
  for(const review of snapshot.advisory_reviews) {
    if(typeof review.comic_id!=='string' || typeof review.review_key!=='string' || typeof review.result!=='string')continue;
    try {
      const reviews=reviewsByComic.get(review.comic_id) ?? new Map<string,unknown>();
      reviews.set(review.review_key,JSON.parse(review.result));reviewsByComic.set(review.comic_id,reviews);
    } catch { /* Malformed evidence must not unblock an unfinished review. */ }
  }
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
    for(const r of snapshot.comics) {
      const reviews=typeof r.id==='string'?reviewsByComic.get(r.id):undefined;
      const draft=reviews && typeof r.draft==='string'?resolveImportedAdvisories(r.draft,reviews):r.draft;
      await client.query('INSERT INTO comics(id,owner,revision,draft,edition,published_at,import_batch_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',[r.id,r.owner,r.revision,draft,r.edition,r.published_at,batchId]);
    }
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
    // The destination never accepts a grant issued by the old origin. Keep its
    // identifier for operation history, but import it as revoked and staged.
    for(const r of snapshot.mcp_grants) await client.query('INSERT INTO mcp_grants(id,owner,client_id,session_id,user_id,client_name,created_at,revoked_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',[r.id,importStagedOwner(batchId,String(r.owner)),r.client_id,r.session_id,r.user_id,r.client_name,r.created_at,r.revoked_at??Date.now()]);
    for(const r of snapshot.operations) await client.query(`INSERT INTO operations(id,owner,action,request_key,input_digest,target_id,grant_id,expected_versions,input_json,status,result_json,lease_token,lease_until,fence,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,[r.id,importStagedOwner(batchId,String(r.owner)),r.action,r.request_key,r.input_digest,r.target_id,r.grant_id,r.expected_versions,r.input_json,r.status,r.result_json,r.lease_token,r.lease_until,r.fence,r.created_at,r.updated_at]);
    for(const r of snapshot.operation_dispatch_intents) await client.query('INSERT INTO operation_dispatch_intents(operation_id,state,lease_token,lease_until,attempts,workflow_run_id) VALUES ($1,$2,$3,$4,$5,$6)',[r.operation_id,r.state,r.lease_token,r.lease_until,r.attempts,r.workflow_run_id]);
    for(const r of snapshot.operation_steps) await client.query('INSERT INTO operation_steps(operation_id,step_id,input_digest,state,reservation_id,result_json) VALUES ($1,$2,$3,$4,$5,$6)',[r.operation_id,r.step_id,r.input_digest,r.state,r.reservation_id,r.result_json]);
    for(const r of snapshot.operation_checkpoints) await client.query('INSERT INTO operation_checkpoints(operation_id,checkpoint_key,value_json) VALUES ($1,$2,$3)',[r.operation_id,r.checkpoint_key,r.value_json]);
    await client.query('COMMIT');
  } catch(e) {await client.query('ROLLBACK').catch(()=>{});throw e;} finally {client.release();}
}
