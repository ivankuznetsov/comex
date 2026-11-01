import {afterAll,beforeAll,expect,test} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {applyMigrations} from '../src/lib/storage/postgres';
import {PostgresOperationRepository} from '../src/lib/operations/postgres';
import {PostgresOperationCoordinator} from '../src/lib/operations/coordinator';
import {PostgresAtomicExecutor} from '../src/lib/operations/atomic-executor';

const pgTest=process.env.TEST_DATABASE_URL?test:test.skip,schema=`comex_atomic_${randomUUID().replaceAll('-','')}`;
let admin:Pool,pool:Pool,repo:PostgresOperationRepository,coordinator:PostgresOperationCoordinator;
const objects={put:async(path:string,_bytes:Uint8Array)=>path,read:async()=>Buffer.from([1]),delete:async()=>{}};
const assets={save:async()=>randomUUID(),read:async()=>Buffer.from([1]),discard:async()=>{}};
beforeAll(async()=>{if(!process.env.TEST_DATABASE_URL)return;
  admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});await admin.query(`CREATE SCHEMA "${schema}"`);
  pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});await applyMigrations(pool);
  repo=new PostgresOperationRepository(pool,{maxCalls:3,maxConcurrent:1});coordinator=new PostgresOperationCoordinator(pool,repo);
  await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified") VALUES ('u','User','u@example.test',true)`);
  await pool.query(`INSERT INTO "session"(id,token,"userId","expiresAt","updatedAt") VALUES ('s','token','u',now()+interval '1 hour',now())`);
  await pool.query("INSERT INTO mcp_grants(id,owner,client_id,session_id,user_id,client_name,created_at) VALUES ('g','owner','c','s','u','Client',1)");
});
afterAll(async()=>{await pool?.end();if(admin){await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}});
const identity={actor:'owner',grantId:'g',scopes:['comex:write','comex:generate','comex:publish'] as const};

pgTest('shared service creates exactly one draft when completion acknowledgment is lost',async()=>{
  const ticket=await coordinator.enqueue({identity,action:'create',requestKey:'create-once',input:{title:'Once',plot:'A story',style:'ink-manga'}});
  let first=true;
  const flaky=new Proxy(repo,{get(target,key){const value=Reflect.get(target,key);if(key==='finishOperation')return async(...args:any[])=>{if(first){first=false;throw new Error('lost acknowledgment');}return value.apply(target,args);};return typeof value==='function'?value.bind(target):value;}});
  const executor=new PostgresAtomicExecutor(flaky,objects,assets);
  await expect(executor.execute(ticket.id)).rejects.toThrow('lost acknowledgment');
  await pool.query('UPDATE operations SET lease_until=0 WHERE id=$1',[ticket.id]);
  await executor.execute(ticket.id);
  const rows=await pool.query('SELECT id,draft FROM comics WHERE owner=$1',['owner']);
  expect(rows.rows).toHaveLength(1);expect(rows.rows[0].id).toBe(ticket.id);expect(rows.rows[0].draft).toMatchObject({title:'Once',plot:'A story',styleId:'ink-manga'});
  expect(await repo.getOwned('owner',ticket.id)).toMatchObject({status:'succeeded'});
});
