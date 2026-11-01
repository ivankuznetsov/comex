import {afterAll,beforeAll,expect,test} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {applyMigrations} from '../src/lib/storage/postgres';
import {PostgresOperationRepository} from '../src/lib/operations/postgres';
import {PostgresOperationCoordinator} from '../src/lib/operations/coordinator';
import {PostgresComicExecutor} from '../src/lib/operations/executor';
import {AIError} from '../src/lib/ai/service';

const pgTest=process.env.TEST_DATABASE_URL?test:test.skip,schema=`comex_runner_${randomUUID().replaceAll('-','')}`;
let admin:Pool,pool:Pool,repo:PostgresOperationRepository,coordinator:PostgresOperationCoordinator;
const values=new Map<string,Buffer>();
const assets={save:async(value:Buffer)=>{const id=randomUUID();values.set(id,value);return id;},read:async(id:string)=>values.get(id)!,discard:async(id:string)=>{values.delete(id);}};
const objects={put:async(path:string)=>path,read:async()=>Buffer.from([1]),delete:async()=>{}};
beforeAll(async()=>{if(!process.env.TEST_DATABASE_URL)return;admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});await admin.query(`CREATE SCHEMA "${schema}"`);pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});await applyMigrations(pool);repo=new PostgresOperationRepository(pool,{maxCalls:3,maxConcurrent:1});coordinator=new PostgresOperationCoordinator(pool,repo);
  await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified") VALUES ('u','User','u@example.test',true)`);await pool.query(`INSERT INTO "session"(id,token,"userId","expiresAt","updatedAt") VALUES ('s','token','u',now()+interval '1 hour',now())`);await pool.query("INSERT INTO mcp_grants(id,owner,client_id,session_id,user_id,client_name,created_at) VALUES ('g','owner','c','s','u','Client',1)");await pool.query("INSERT INTO comics(id,owner,revision,draft) VALUES ('comic','owner',1,$1)",[JSON.stringify({id:'comic',ownerId:'owner',plot:'plot',storyRevision:1,pages:[]})]);});
afterAll(async()=>{await pool?.end();if(admin){await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}});

pgTest('executor uses a durable provider step and atomic comic checkpoint',async()=>{
  let calls=0;
  const adapter={kind:'comex-durable-service-v1' as const,create:(deps:any,durable:any)=>({
    initialQuestions:async(owner:string,id:string)=>{
      const record=await deps.repository.getOwned(id,owner);
      const output=await durable.paid({id:'initial/questions',input:{plot:record.data.plot},expectedRevision:record.revision},async(fetcher:any)=>await (await fetcher('https://example.test')).json());
      return durable.checkpoint('questions/apply',async(store:any)=>{const current=await store.getOwned(id,owner);if(!await store.update(id,owner,current.revision,{...current.data,questions:output.questions}))throw new Error('stale');return {questions:output.questions};});
    }
  }) as any};
  const executor=new PostgresComicExecutor(pool,repo,objects,assets,adapter,async()=>{calls++;return Response.json({questions:['Where?']});});
  const ticket=await coordinator.enqueue({identity:{actor:'owner',grantId:'g',scopes:['comex:write','comex:generate']},action:'initialQuestions',requestKey:'questions',comicId:'comic',expectedRevision:1,input:{}});
  await executor.execute(ticket.id);
  expect(calls).toBe(1);expect((await repo.getOwned('owner',ticket.id))?.status).toBe('succeeded');
  expect((await pool.query("SELECT draft FROM comics WHERE id='comic'")).rows[0].draft.questions).toEqual(['Where?']);
  await executor.execute(ticket.id);expect(calls).toBe(1);
});

pgTest('unknown paid outcomes can checkpoint draft status before the worker releases its lease',async()=>{
  const adapter={kind:'comex-durable-service-v1' as const,create:(deps:any,durable:any)=>({
    initialQuestions:async(owner:string,id:string)=>{
      const record=await deps.repository.getOwned(id,owner);
      try {await durable.paid({id:'initial/questions',input:{plot:record.data.plot},expectedRevision:record.revision},async(fetcher:any)=>await (await fetcher('https://example.test')).json());}
      catch(error){await durable.checkpoint('questions/unknown',async(store:any)=>{const current=await store.getOwned(id,owner);await store.update(id,owner,current.revision,{...current.data,initialQuestions:'unknown'});return {recorded:true};});throw new AIError('invalid_response','The response could not be validated.');}
      throw new Error('unexpected success');
    }
  }) as any};
  const executor=new PostgresComicExecutor(pool,repo,objects,assets,adapter,async()=>{throw new Error('connection lost');});
  const ticket=await coordinator.enqueue({identity:{actor:'owner',grantId:'g',scopes:['comex:write','comex:generate']},action:'initialQuestions',requestKey:'unknown',comicId:'comic',expectedRevision:2,input:{}});
  await executor.execute(ticket.id);
  expect((await repo.getOwned('owner',ticket.id))?.status).toBe('unknown_outcome');
  expect((await pool.query('SELECT lease_token FROM operations WHERE id=$1',[ticket.id])).rows[0].lease_token).toBeNull();
  expect((await pool.query("SELECT draft FROM comics WHERE id='comic'")).rows[0].draft.initialQuestions).toBe('unknown');
  expect(await repo.getCheckpoint('owner',ticket.id,'questions/unknown')).toEqual({recorded:true});
});

pgTest('invalid response outside the gateway still leaves an unleased unknown operation',async()=>{
  const adapter={kind:'comex-durable-service-v1' as const,create:()=>({initialQuestions:async()=>{throw new AIError('invalid_response','Could not validate.');}}) as any};
  const executor=new PostgresComicExecutor(pool,repo,objects,assets,adapter);
  const ticket=await coordinator.enqueue({identity:{actor:'owner',grantId:'g',scopes:['comex:write','comex:generate']},action:'initialQuestions',requestKey:'invalid-outside',comicId:'comic',expectedRevision:3,input:{}});
  await executor.execute(ticket.id);
  expect((await repo.getOwned('owner',ticket.id))?.status).toBe('unknown_outcome');
  expect((await pool.query('SELECT lease_token FROM operations WHERE id=$1',[ticket.id])).rows[0].lease_token).toBeNull();
});
