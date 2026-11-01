import {afterAll,beforeAll,expect,test} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {Pool,type PoolClient} from 'pg';
import {applyMigrations} from '../src/lib/storage/postgres';
import {PostgresOperationRepository} from '../src/lib/operations/postgres';
import {TransactionComicRepository} from '../src/lib/operations/transaction-repository';

const pgTest=process.env.TEST_DATABASE_URL?test:test.skip,schema=`comex_text_${randomUUID().replaceAll('-','')}`;
let admin:Pool,pool:Pool,operations:PostgresOperationRepository;
const objects={put:async(path:string)=>path,read:async()=>Buffer.from([]),delete:async()=>{}};
beforeAll(async()=>{if(!process.env.TEST_DATABASE_URL)return;admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});await admin.query(`CREATE SCHEMA "${schema}"`);pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});await applyMigrations(pool);operations=new PostgresOperationRepository(pool,{maxCalls:5,maxConcurrent:1});await pool.query("INSERT INTO comics(id,owner,revision,draft) VALUES ('comic','owner',1,'{}')");});
afterAll(async()=>{await pool?.end();if(admin){await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}});
async function transaction<T>(operationId:string|undefined,work:(repo:TransactionComicRepository,client:PoolClient)=>Promise<T>) {
  const client=await pool.connect();try {await client.query('BEGIN');const value=await work(new TransactionComicRepository(client,objects,operationId),client);await client.query('COMMIT');return value;} catch(error){await client.query('ROLLBACK');throw error;} finally{client.release();}
}
async function op(key:string){return (await operations.start({owner:'owner',action:'initialQuestions',requestKey:key,targetId:'comic',grantId:null,expectedVersions:1,input:{}},async()=>{})).operation.id;}

pgTest('only the original operation can resume or release its unknown text reservation',async()=>{
  const a=await op('a'),b=await op('b');
  expect(await transaction(a,repo=>repo.reserveTextOperation('comic','owner',1))).toBe(true);
  await transaction(a,async repo=>{await repo.finishTextOperation('comic','owner',true);});
  expect(await transaction(b,repo=>repo.resumeTextOperation('comic','owner'))).toBe(false);
  await transaction(b,async repo=>{await repo.finishTextOperation('comic','owner',false);});
  expect((await pool.query("SELECT state,operation_id FROM comic_text_operations WHERE comic_id='comic'")).rows[0]).toEqual({state:'unknown',operation_id:a});
  expect(await transaction(a,repo=>repo.resumeTextOperation('comic','owner'))).toBe(true);
  await transaction(undefined,async repo=>{await repo.finishTextOperation('comic','owner',false);});
  expect((await pool.query("SELECT state,operation_id FROM comic_text_operations WHERE comic_id='comic'")).rows[0]).toEqual({state:'running',operation_id:a});
  await transaction(a,async repo=>{await repo.finishTextOperation('comic','owner',false);});
  expect((await pool.query('SELECT count(*)::int n FROM comic_text_operations')).rows[0].n).toBe(0);
});

pgTest('an unbound legacy unknown text reservation cannot be adopted',async()=>{
  const a=await op('legacy');await pool.query('DELETE FROM comic_text_operations');await pool.query("INSERT INTO comic_text_operations(comic_id,owner,state) VALUES ('comic','owner','unknown')");
  expect(await transaction(a,repo=>repo.resumeTextOperation('comic','owner'))).toBe(false);
  expect((await pool.query("SELECT state,operation_id FROM comic_text_operations WHERE comic_id='comic'")).rows[0]).toEqual({state:'unknown',operation_id:null});
});
