import {createHash,randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import type {Pool, PoolClient} from 'pg';
import type {ComicRepository} from '../application/contracts';
import type {AIOptions} from '../ai/service';
import {BudgetError, budgetFromEnvironment, setBudgetFinalizer, type BudgetConfig} from '../budget';
import type {ReservationBudget} from './contracts';
import {sha256, type PrivateObjects} from './assets';

async function transaction<T>(pool:Pool, work:(client:PoolClient)=>Promise<T>):Promise<T> {
  const client=await pool.connect();
  try {await client.query('BEGIN');const result=await work(client);await client.query('COMMIT');return result;}
  catch(e) {await client.query('ROLLBACK').catch(()=>{});throw e;} finally {client.release();}
}

/** Explicit, versioned operator action; never invoked by a constructor. */
export async function applyMigrations(pool:Pool):Promise<void> {
  await transaction(pool,async client=>{
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['comex-storage-migrations']);
    await client.query('CREATE TABLE IF NOT EXISTS comex_schema_migrations (version text PRIMARY KEY, checksum text NOT NULL)');
    const directory=join(process.cwd(),'db/migrations');
    for(const file of (await readdir(directory)).filter(name=>/^\d+_[a-z0-9_]+\.sql$/.test(name)).sort()) {
      const sql=await readFile(join(directory,file),'utf8'),checksum=createHash('sha256').update(sql).digest('hex');
      const applied=(await client.query('SELECT checksum FROM comex_schema_migrations WHERE version=$1',[file])).rows[0];
      if(applied) {if(applied.checksum!==checksum)throw new Error(`Applied migration ${file} has changed.`);continue;}
      await client.query(sql);await client.query('INSERT INTO comex_schema_migrations(version,checksum) VALUES ($1,$2)',[file,checksum]);
    }
  });
}

export class PostgresRepository implements ComicRepository {
  constructor(private pool:Pool, private objects:PrivateObjects) {}
  async create(id:string,owner:string,data:unknown):Promise<void> {await this.pool.query('INSERT INTO comics(id,owner,revision,draft) VALUES ($1,$2,1,$3)',[id,owner,JSON.stringify(data)]);}
  async getOwned<T=unknown>(id:string,owner:string):Promise<{revision:number;data:T}|null> {
    const row=(await this.pool.query('SELECT revision,draft FROM comics WHERE id=$1 AND owner=$2 AND import_batch_id IS NULL',[id,owner])).rows[0];
    return row ? {revision:row.revision,data:row.draft as T}:null;
  }
  async listOwned<T=unknown>(owner:string):Promise<T[]> {return (await this.pool.query('SELECT draft FROM comics WHERE owner=$1 AND import_batch_id IS NULL ORDER BY created_at DESC',[owner])).rows.map(r=>r.draft as T);}
  async update(id:string,owner:string,revision:number,data:unknown):Promise<boolean> {
    return (await this.pool.query('UPDATE comics SET draft=$1,revision=revision+1 WHERE id=$2 AND owner=$3 AND revision=$4 AND import_batch_id IS NULL',[JSON.stringify(data),id,owner,revision])).rowCount===1;
  }
  async reserveTextOperation(id:string,owner:string,revision:number):Promise<boolean> {
    return transaction(this.pool,async c=>{
      const row=await c.query('SELECT id FROM comics WHERE id=$1 AND owner=$2 AND revision=$3 AND import_batch_id IS NULL FOR UPDATE',[id,owner,revision]);
      if(!row.rowCount)return false;
      return (await c.query("INSERT INTO comic_text_operations(comic_id,owner,state) VALUES ($1,$2,'running') ON CONFLICT DO NOTHING",[id,owner])).rowCount===1;
    });
  }
  async finishTextOperation(id:string,owner:string,unknown:boolean):Promise<void> {
    if(unknown) await this.pool.query("UPDATE comic_text_operations SET state='unknown' WHERE comic_id=$1 AND owner=$2 AND state='running'",[id,owner]);
    else await this.pool.query("DELETE FROM comic_text_operations WHERE comic_id=$1 AND owner=$2 AND state='running'",[id,owner]);
  }
  async publish(id:string,owner:string,revision:number,edition:unknown,assets:{id:string;data:Uint8Array}[]=[]):Promise<boolean> {
    if(new Set(assets.map(asset=>asset.id)).size!==assets.length) throw new Error('Duplicate publication asset.');
    return transaction(this.pool,async c=>{
      const existing=await c.query('SELECT id FROM comics WHERE id=$1 AND owner=$2 AND revision=$3 AND import_batch_id IS NULL FOR UPDATE',[id,owner,revision]);
      if(!existing.rowCount)return false;
      const uploads=[] as {id:string;path:string;hash:string}[];
      for(const asset of assets) uploads.push({id:asset.id,path:await this.objects.put(`editions/${randomUUID()}.png`,asset.data),hash:sha256(asset.data)});
      await c.query('UPDATE comics SET edition=$1,published_at=now(),revision=revision+1 WHERE id=$2 AND owner=$3 AND revision=$4',[JSON.stringify(edition),id,owner,revision]);
      await c.query('DELETE FROM publication_assets WHERE comic_id=$1',[id]);
      for(const item of uploads) await c.query('INSERT INTO publication_assets(comic_id,asset_id,object_path,sha256) VALUES ($1,$2,$3,$4)',[id,item.id,item.path,item.hash]);
      return true;
    });
  }
  async withdraw(id:string,owner:string,revision?:number):Promise<boolean> {
    return transaction(this.pool,async c=>{
      const changed=await c.query('UPDATE comics SET edition=NULL,published_at=NULL,revision=revision+1 WHERE id=$1 AND owner=$2 AND import_batch_id IS NULL AND ($3::integer IS NULL OR revision=$3)',[id,owner,revision??null]);
      if(changed.rowCount) await c.query('DELETE FROM publication_assets WHERE comic_id=$1',[id]);
      return changed.rowCount===1;
    });
  }
  async getPublished<T=unknown>(id:string):Promise<T|null> {return (await this.pool.query('SELECT edition FROM comics WHERE id=$1 AND edition IS NOT NULL',[id])).rows[0]?.edition as T ?? null;}
  async listPublished<T=unknown>():Promise<T[]> {return (await this.pool.query('SELECT edition FROM comics WHERE edition IS NOT NULL ORDER BY published_at DESC LIMIT 100')).rows.map(r=>r.edition as T);}
  async getPublicationAsset(id:string,assetId:string):Promise<Uint8Array|null> {
    const row=(await this.pool.query('SELECT object_path FROM publication_assets WHERE comic_id=$1 AND asset_id=$2',[id,assetId])).rows[0];
    return row ? new Uint8Array(await this.objects.read(row.object_path)) : null;
  }
}

export class PostgresProviderBudget implements ReservationBudget {
  constructor(private pool:Pool,private config:BudgetConfig=budgetFromEnvironment()) {}
  async reserve(stepKey?:string):Promise<string> {
    const {maxCalls,maxConcurrent}=this.config;
    if((maxCalls!=='unlimited'&&(!Number.isSafeInteger(maxCalls)||(maxCalls as number)<1))||!Number.isSafeInteger(maxConcurrent)||(maxConcurrent as number)<1)
      throw new BudgetError('budget_not_configured','Set COMEX_MAX_PROVIDER_CALLS to a positive integer or unlimited, and COMEX_MAX_CONCURRENT_CALLS to a positive integer before using AI.');
    return transaction(this.pool,async c=>{
      await c.query('SELECT id FROM provider_budget_guard WHERE id=1 FOR UPDATE');
      if(stepKey !== undefined && (await c.query('SELECT 1 FROM provider_reservations WHERE step_key=$1',[stepKey])).rowCount) throw new BudgetError('reservation_exists','This provider step already has a reservation.');
      const counts=await this.counts(c);
      if(typeof maxCalls==='number'&&counts.used>=maxCalls) throw new BudgetError('budget_exhausted','The configured AI call budget is exhausted.');
      if(counts.active>=maxConcurrent!) throw new BudgetError('concurrency_limit','The AI concurrency limit is reached or a previous request has an unknown outcome.');
      const id=randomUUID(),now=new Date().toISOString();
      await c.query("INSERT INTO provider_reservations(id,state,created_at,updated_at,step_key) VALUES ($1,'running',$2,$2,$3)",[id,now,stepKey??null]);return id;
    });
  }
  async finish(id:string,state:'completed'|'unknown'):Promise<void> {
    if((await this.pool.query("UPDATE provider_reservations SET state=$1,updated_at=$2 WHERE id=$3 AND state='running'",[state,new Date().toISOString(),id])).rowCount!==1) throw new Error('Provider reservation could not be finalized.');
  }
  async listOutstanding():Promise<{id:string;state:'running'|'unknown';createdAt:string}[]> {return (await this.pool.query("SELECT id,state,created_at AS \"createdAt\" FROM provider_reservations WHERE state IN ('running','unknown') ORDER BY created_at,id")).rows;}
  async markUnknown(id:string):Promise<void> {await this.finish(id,'unknown');}
  async resolveUnknown(id:string):Promise<void> {if((await this.pool.query("UPDATE provider_reservations SET state='completed',updated_at=$1 WHERE id=$2 AND state='unknown'",[new Date().toISOString(),id])).rowCount!==1) throw new Error('Unknown provider reservation could not be resolved.');}
  private async counts(c:Pool|PoolClient):Promise<{used:number;active:number;unknown:number}> {
    const r=(await c.query("SELECT count(*)::int AS used,count(*) FILTER (WHERE state IN ('running','unknown'))::int AS active,count(*) FILTER (WHERE state='unknown')::int AS unknown FROM provider_reservations")).rows[0];return {used:r.used,active:r.active,unknown:r.unknown};
  }
  async summary():Promise<{used:number;active:number;unknown:number}> {return this.counts(this.pool);}
}

/** Budget each provider request once. An ambiguous dispatch stays active for reconciliation. */
export function createPostgresBudgetedFetch(budget:PostgresProviderBudget,fetcher:NonNullable<AIOptions['fetch']>=globalThis.fetch,stepKey?:string):NonNullable<AIOptions['fetch']> {
  return async (input,init)=>{
    const id=await budget.reserve(stepKey);
    let response:Response;
    try {response=await fetcher(input,init);} catch(error) {await budget.finish(id,'unknown');throw error;}
    if(!response.ok) {await budget.finish(id,response.status===408||response.status>=500?'unknown':'completed');return response;}
    setBudgetFinalizer(response,state=>budget.finish(id,state));return response;
  };
}
