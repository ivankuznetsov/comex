import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {NextRequest} from 'next/server';
import {Pool} from 'pg';
import {createHostedBackend} from '../src/lib/hosted-api';
import {handleApi} from '../src/lib/local-api';
import {createMcpReads} from '../src/lib/mcp/reads';
import type {PrivateObjects} from '../src/lib/storage/assets';
import {applyMigrations} from '../src/lib/storage/postgres';

class MemoryObjects implements PrivateObjects {
  private data = new Map<string,Buffer>();
  async put(path:string,bytes:Uint8Array) {this.data.set(path,Buffer.from(bytes));return path;}
  async read(path:string) {const value=this.data.get(path);if(!value)throw new Error('missing');return value;}
  async delete(path:string) {this.data.delete(path);}
}

const postgres = process.env.TEST_DATABASE_URL ? describe : describe.skip;
postgres('hosted browser adapter',()=>{
  let admin:Pool,pool:Pool;
  const schema=`hosted_browser_${randomUUID().replaceAll('-','')}`;
  beforeAll(async()=>{
    admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});
    await applyMigrations(pool);
  });
  afterAll(async()=>{
    await pool?.end();
    if(admin) {await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
  });
  test('browser sessions and the shared service see the same private draft',async()=>{
    let providerCalls=0;
    const backend=createHostedBackend({pool,objects:new MemoryObjects(),origin:'https://comex.example',budgetFetch:async()=>{providerCalls++;throw new Error('not allowed');}});
    const create=new NextRequest('https://comex.example/api/comics',{method:'POST',headers:{host:'comex.example',origin:'https://comex.example','content-type':'application/json'},body:JSON.stringify({title:'A story',plot:'A parcel crosses town',style:'clear-line-adventure',email:'owner@example.test'})});
    const created=await handleApi(create,['comics'],backend);
    expect(created.status).toBe(201);
    const {comic}=await created.json();
    const cookie=created.headers.get('set-cookie')!.split(';')[0];
    const token=cookie.slice('comex_session='.length);
    const identity=await backend.auth.guestIdentity(token);
    expect(identity).not.toBeNull();
    expect((await backend.service.get(identity!.owner,comic.id)).comic.title).toBe('A story');
    await pool.query('INSERT INTO import_batches(id,fingerprint) VALUES ($1,$2)',['hidden','fixture']);
    await pool.query('INSERT INTO comics(id,owner,revision,draft,import_batch_id) VALUES ($1,$2,1,$3,$4)', ['hidden',identity!.owner,JSON.stringify({title:'Unclaimed',plot:'private'}),'hidden']);
    const reads=createMcpReads(pool,backend.service,{getOwned:()=>null});
    expect((await reads.listComics({actor:identity!.owner,scopes:['comex:read']},{limit:10})).comics).toEqual([{id:comic.id,title:'A story',plot:'A parcel crosses town',published:false}]);
    const get=(headers:Record<string,string>)=>new NextRequest(`https://comex.example/api/comics/${comic.id}`,{headers:{host:'comex.example',...headers}});
    expect((await handleApi(get({cookie}),['comics',comic.id],backend)).status).toBe(200);
    expect((await handleApi(get({}),['comics',comic.id],backend)).status).toBe(404);
    expect((await handleApi(get({cookie,host:'attacker.example'}),['comics',comic.id],backend)).status).toBe(403);
    const crossOrigin=new NextRequest(`https://comex.example/api/comics/${comic.id}`,{method:'PATCH',headers:{host:'comex.example',origin:'https://attacker.example','content-type':'application/json',cookie},body:JSON.stringify({title:'Stolen'})});
    expect((await handleApi(crossOrigin,['comics',comic.id],backend)).status).toBe(403);
    expect(providerCalls).toBe(0);
  });
  test('rejects a noncanonical or insecure hosted origin',()=>{
    const options={pool,objects:new MemoryObjects(),budgetFetch:async()=>new Response()};
    expect(()=>createHostedBackend({...options,origin:'https://comex.example/path'})).toThrow();
    expect(()=>createHostedBackend({...options,origin:'http://comex.example'})).toThrow();
  });
});
