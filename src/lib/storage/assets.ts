import {createHash, randomUUID} from 'node:crypto';
import {del, get, put} from '@vercel/blob';
import type {Pool} from 'pg';
import type {ComicAssets} from '../application/contracts';
import {ApplicationError} from '../application/contracts';

export interface PrivateObjects {
  put(path:string, bytes:Uint8Array): Promise<string>;
  read(path:string): Promise<Buffer>;
  delete(path:string): Promise<void>;
}
export const sha256 = (data:Uint8Array) => createHash('sha256').update(data).digest('hex');

/** Credentials are kept server-side; no public Blob URL is returned to a client. */
export class VercelPrivateObjects implements PrivateObjects {
  constructor(private sdk:Pick<typeof import('@vercel/blob'),'put'|'get'|'del'>={put,get,del}) {}
  async put(path:string, bytes:Uint8Array): Promise<string> {
    const blob=await this.sdk.put(path,Buffer.from(bytes),{access:'private',contentType:'image/png'});
    return blob.pathname;
  }
  async read(path:string): Promise<Buffer> {
    const result=await this.sdk.get(path,{access:'private'});
    if (!result || result.statusCode!==200) throw new Error('Private asset unavailable.');
    return Buffer.from(await new Response(result.stream).arrayBuffer());
  }
  async delete(path:string): Promise<void> {await this.sdk.del(path);}
}

/** Authorization is checked against the owned draft by the application before read. */
export class PostgresAssets implements ComicAssets {
  constructor(private pool:Pool, private objects:PrivateObjects) {}
  async save(bytes:Buffer):Promise<string> {
    const id=randomUUID(), path=await this.objects.put(`drafts/${id}/${randomUUID()}.png`,bytes);
    await this.pool.query('INSERT INTO assets(id,object_path,sha256) VALUES ($1,$2,$3)',[id,path,sha256(bytes)]);
    return id;
  }
  async read(id:string):Promise<Buffer> {
    const row=(await this.pool.query('SELECT object_path FROM assets WHERE id=$1',[id])).rows[0];
    if (!row) throw new ApplicationError('not_found','Image not found.');
    return this.objects.read(row.object_path);
  }
  async discard(id:string):Promise<void> {
    const row=(await this.pool.query('DELETE FROM assets WHERE id=$1 RETURNING object_path',[id])).rows[0];
    if(row) await this.objects.delete(row.object_path);
  }
}
