import {DatabaseSync} from 'node:sqlite';
import type {Pool} from 'pg';
import type {createComicService} from '../application/comics';
import {ApplicationError} from '../application/contracts';
import type {Operation, MaybePromise} from '../operations/contracts';
import type {McpReads} from './contracts';

type OperationReader = {getOwned(owner:string,id:string):MaybePromise<Operation|null>};
type ListingRow = {id:string;draft:unknown;published:boolean | number};

/** Read projections are bounded and always filtered by the authenticated owner. */
export function createMcpReads(database:DatabaseSync | Pool, service:ReturnType<typeof createComicService>, operations:OperationReader, readExport:(owner:string,id:string)=>Promise<Buffer|null>):McpReads {
  return {
    async listStyles() {return service.listStyles();},
    async listComics(identity,{limit,cursor}) {
      const rows:ListingRow[] = database instanceof DatabaseSync
        ? database.prepare('SELECT id,draft,edition IS NOT NULL AS published FROM comics WHERE owner=? AND id>? ORDER BY id LIMIT ?').all(identity.actor,cursor ?? '',limit+1) as ListingRow[]
        : (await database.query('SELECT id,draft,edition IS NOT NULL AS published FROM comics WHERE owner=$1 AND import_batch_id IS NULL AND id>$2 ORDER BY id LIMIT $3',[identity.actor,cursor ?? '',limit+1])).rows as ListingRow[];
      const comics=rows.slice(0,limit).map(row=>{
        const draft=(typeof row.draft==='string' ? JSON.parse(row.draft) : row.draft) as {title:string;plot:string};
        return {id:row.id,title:draft.title,plot:draft.plot,published:!!row.published};
      });
      return {comics,nextCursor:rows.length>limit ? rows[limit-1].id : null};
    },
    async getComic(identity,id) {return service.get(identity.actor,id);},
    async getAsset(identity,id,assetId) {return {bytes:await service.getAsset(identity.actor,id,assetId),mimeType:'image/png'};},
    async getExport(identity,id) {
      const bytes=await readExport(identity.actor,id);
      if (!bytes) throw new ApplicationError('not_found','Export not found.');
      return {bytes,mimeType:'image/png'};
    },
    async getOperation(identity,id) {
      const operation=await operations.getOwned(identity.actor,id);
      if (!operation) throw new ApplicationError('not_found','Operation not found.');
      return {id:operation.id,status:operation.status,action:operation.action,comicId:operation.targetId || undefined,result:operation.result};
    },
  };
}
