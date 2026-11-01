import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {ComicRepository} from '../application/contracts';
import {sha256,type PrivateObjects} from '../storage/assets';
import type {PolicyContext} from './contracts';

/** Match owner handoff's comic-before-operation lock order. */
export async function lockCheckpointComic(client:PoolClient,context:PolicyContext):Promise<void> {
  if(context.operation.targetId)await client.query('SELECT id FROM comics WHERE id=$1 FOR UPDATE',[context.operation.targetId]);
}

/** Comic repository whose writes participate in the operation checkpoint transaction. */
export class TransactionComicRepository implements ComicRepository {
  constructor(private client:PoolClient,private objects:PrivateObjects,private operationId?:string) {}
  async create(id:string,owner:string,data:unknown) {await this.client.query('INSERT INTO comics(id,owner,revision,draft) VALUES ($1,$2,1,$3)',[id,owner,JSON.stringify(data)]);}
  async getOwned<T=unknown>(id:string,owner:string):Promise<{revision:number;data:T}|null> {const r=(await this.client.query('SELECT revision,draft FROM comics WHERE id=$1 AND owner=$2 AND import_batch_id IS NULL',[id,owner])).rows[0];return r?{revision:r.revision,data:r.draft as T}:null;}
  async listOwned<T=unknown>(owner:string):Promise<T[]> {return (await this.client.query('SELECT draft FROM comics WHERE owner=$1 AND import_batch_id IS NULL ORDER BY created_at DESC',[owner])).rows.map(r=>r.draft as T);}
  async update(id:string,owner:string,revision:number,data:unknown):Promise<boolean> {return (await this.client.query('UPDATE comics SET draft=$1,revision=revision+1 WHERE id=$2 AND owner=$3 AND revision=$4 AND import_batch_id IS NULL',[JSON.stringify(data),id,owner,revision])).rowCount===1;}
  async reserveTextOperation(id:string,owner:string,revision:number):Promise<boolean> {
    const row=await this.client.query('SELECT id FROM comics WHERE id=$1 AND owner=$2 AND revision=$3 AND import_batch_id IS NULL FOR UPDATE',[id,owner,revision]);if(!row.rowCount)return false;
    return (await this.client.query("INSERT INTO comic_text_operations(comic_id,owner,state,operation_id) VALUES ($1,$2,'running',$3) ON CONFLICT DO NOTHING",[id,owner,this.operationId??null])).rowCount===1;
  }
  async finishTextOperation(id:string,owner:string,unknown:boolean):Promise<void> {
    const ownership=this.operationId?' AND operation_id=$3':' AND operation_id IS NULL';
    const args=this.operationId?[id,owner,this.operationId]:[id,owner];
    if(unknown)await this.client.query(`UPDATE comic_text_operations SET state='unknown' WHERE comic_id=$1 AND owner=$2 AND state='running'${ownership}`,args);
    else await this.client.query(`DELETE FROM comic_text_operations WHERE comic_id=$1 AND owner=$2 AND state='running'${ownership}`,args);
  }
  async resumeTextOperation(id:string,owner:string):Promise<boolean> {
    if(!this.operationId)return false;
    return (await this.client.query("UPDATE comic_text_operations SET state='running' WHERE comic_id=$1 AND owner=$2 AND operation_id=$3 AND state='unknown'",[id,owner,this.operationId])).rowCount===1;
  }
  async publish(id:string,owner:string,revision:number,edition:unknown,assets:{id:string;data:Uint8Array}[]):Promise<boolean> {
    if(new Set(assets.map(a=>a.id)).size!==assets.length)throw new Error('Duplicate publication asset.');
    const row=await this.client.query('SELECT id FROM comics WHERE id=$1 AND owner=$2 AND revision=$3 AND import_batch_id IS NULL FOR UPDATE',[id,owner,revision]);if(!row.rowCount)return false;
    const uploaded=[] as {id:string;path:string;hash:string}[];
    for(const asset of assets)uploaded.push({id:asset.id,path:await this.objects.put(`editions/${randomUUID()}.png`,asset.data),hash:sha256(asset.data)});
    await this.client.query('UPDATE comics SET edition=$1,published_at=now(),revision=revision+1 WHERE id=$2 AND owner=$3 AND revision=$4',[JSON.stringify(edition),id,owner,revision]);
    await this.client.query('DELETE FROM publication_assets WHERE comic_id=$1',[id]);
    for(const a of uploaded)await this.client.query('INSERT INTO publication_assets(comic_id,asset_id,object_path,sha256) VALUES ($1,$2,$3,$4)',[id,a.id,a.path,a.hash]);return true;
  }
  async withdraw(id:string,owner:string,revision?:number):Promise<boolean> {const r=await this.client.query('UPDATE comics SET edition=NULL,published_at=NULL,revision=revision+1 WHERE id=$1 AND owner=$2 AND import_batch_id IS NULL AND ($3::integer IS NULL OR revision=$3)',[id,owner,revision??null]);if(r.rowCount)await this.client.query('DELETE FROM publication_assets WHERE comic_id=$1',[id]);return r.rowCount===1;}
  async getPublished<T=unknown>(id:string):Promise<T|null> {return (await this.client.query('SELECT edition FROM comics WHERE id=$1 AND edition IS NOT NULL',[id])).rows[0]?.edition as T ?? null;}
  async listPublished<T=unknown>():Promise<T[]> {return (await this.client.query('SELECT edition FROM comics WHERE edition IS NOT NULL ORDER BY published_at DESC LIMIT 100')).rows.map(r=>r.edition as T);}
  async getPublicationAsset(id:string,assetId:string):Promise<Uint8Array|null> {const row=(await this.client.query('SELECT object_path FROM publication_assets WHERE comic_id=$1 AND asset_id=$2',[id,assetId])).rows[0];return row?new Uint8Array(await this.objects.read(row.object_path)):null;}
}
