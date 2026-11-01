import {afterAll,beforeAll,expect,test} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {applyMigrations} from '../src/lib/storage/postgres';
import {PostgresOperationRepository} from '../src/lib/operations/postgres';
import {PostgresOperationCoordinator} from '../src/lib/operations/coordinator';
import {PostgresPaidGateway} from '../src/lib/operations/paid-gateway';
import {AIError} from '../src/lib/ai/service';

const pgTest=process.env.TEST_DATABASE_URL?test:test.skip,schema=`comex_paid_${randomUUID().replaceAll('-','')}`;
let admin:Pool,pool:Pool,repo:PostgresOperationRepository,coordinator:PostgresOperationCoordinator;
const saved=new Map<string,Buffer>();
const assets={save:async(data:Buffer)=>{const id=randomUUID();saved.set(id,Buffer.from(data));return id;},read:async(id:string)=>{const b=saved.get(id);if(!b)throw new Error('missing');return b;}};
beforeAll(async()=>{
  if(!process.env.TEST_DATABASE_URL)return;
  admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});await admin.query(`CREATE SCHEMA "${schema}"`);
  pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});await applyMigrations(pool);
  repo=new PostgresOperationRepository(pool,{maxCalls:10,maxConcurrent:1});coordinator=new PostgresOperationCoordinator(pool,repo);
  await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified") VALUES ('u','User','u@example.test',true)`);
  await pool.query(`INSERT INTO "session"(id,token,"userId","expiresAt","updatedAt") VALUES ('s','token','u',now()+interval '1 hour',now())`);
  await pool.query("INSERT INTO mcp_grants(id,owner,client_id,session_id,user_id,client_name,created_at) VALUES ('g','owner','c','s','u','Client',1)");
  await pool.query("INSERT INTO comics(id,owner,revision,draft) VALUES ('comic','owner',1,$1)",[JSON.stringify({ownerId:'owner',storyRevision:1,pages:[]})]);
});
afterAll(async()=>{await pool?.end();if(admin){await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}});
const identity={actor:'owner',grantId:'g',scopes:['comex:write','comex:generate'] as const};
async function operation(key:string){const ticket=await coordinator.enqueue({identity,action:'initialQuestions',requestKey:key,comicId:'comic',expectedRevision:1,input:{}});return (await repo.claimOperation(ticket.id,300000))!;}
const call=async(fetcher:(input:string|URL|Request,init?:RequestInit)=>Promise<Response>)=>await (await fetcher('https://example.test')).json();

pgTest('revocation is serialized with dispatch, then prevents the next paid step',async()=>{
  const lease=await operation('revoke');let began!:()=>void,finish!:()=>void,calls=0;
  const started=new Promise<void>(r=>{began=r;}),hold=new Promise<void>(r=>{finish=r;});
  const gateway=new PostgresPaidGateway(pool,repo,assets,async()=>{calls++;began();await hold;return Response.json({answer:'kept'});});
  const running=gateway.run({lease,owner:'owner',step:{id:'questions',input:{plot:'x'}},expectedRevision:1},call);
  await started;
  await pool.query("UPDATE mcp_grants SET revoked_at=1 WHERE id='g'");
  finish();expect(await running).toEqual({answer:'kept'});
  await expect(gateway.run({lease,owner:'owner',step:{id:'judge',input:{}},expectedRevision:1},call)).rejects.toThrow('revoked');
  expect(calls).toBe(1);
  expect((await pool.query('SELECT count(*)::int AS n FROM provider_reservations')).rows[0].n).toBe(1);
  await pool.query("UPDATE mcp_grants SET revoked_at=NULL WHERE id='g'");
});

pgTest('binary paid results are stored privately by asset ID and replay without dispatch',async()=>{
  const lease=await operation('binary');let calls=0;
  const gateway=new PostgresPaidGateway(pool,repo,assets,async()=>{calls++;return new Response('not used');});
  const invoke=async(fetcher:(input:string|URL|Request,init?:RequestInit)=>Promise<Response>)=>{await fetcher('https://example.test');return Buffer.from([1,2,3,4]);};
  const request={lease,owner:'owner',step:{id:'reference',input:{name:'Mina'}},expectedRevision:1};
  expect(await gateway.run(request,invoke)).toEqual(Buffer.from([1,2,3,4]));
  expect(await gateway.run(request,invoke)).toEqual(Buffer.from([1,2,3,4]));expect(calls).toBe(1);
  const row=(await pool.query('SELECT result_json FROM operation_steps WHERE operation_id=$1 AND step_id=$2',[lease.operationId,'reference'])).rows[0];
  const result=JSON.parse(row.result_json);expect(result.format).toBe('private_asset');expect(result.assetId).toBeTruthy();expect(await gateway.assetIdFor('owner',lease.operationId,'reference')).toBe(result.assetId);expect(await gateway.assetIdFor('intruder',lease.operationId,'reference')).toBeNull();expect(row.result_json).not.toContain(Buffer.from([1,2,3,4]).toString('base64'));
});

pgTest('a known provider failure replays as the same class of failure without redispatch',async()=>{
  const lease=await operation('known-failure');let calls=0;
  const gateway=new PostgresPaidGateway(pool,repo,assets,async()=>{calls++;return new Response('no');});
  const request={lease,owner:'owner',step:{id:'review',input:{panel:'x'}},expectedRevision:1};
  const invoke=async(fetcher:(input:string|URL|Request,init?:RequestInit)=>Promise<Response>)=>{await fetcher('https://example.test');throw new AIError('provider_error','Provider refused the review.');};
  await expect(gateway.run(request,invoke)).rejects.toMatchObject({code:'provider_error'});
  await expect(gateway.run(request,invoke)).rejects.toMatchObject({code:'provider_error'});
  expect(calls).toBe(1);
});

pgTest('a lost response remains unknown and never redispatches on recovery',async()=>{
  const lease=await operation('lost');let calls=0;
  const gateway=new PostgresPaidGateway(pool,repo,assets,async()=>{calls++;throw new Error('lost connection');});
  await expect(gateway.run({lease,owner:'owner',step:{id:'questions',input:{plot:'lost'}},expectedRevision:1},call)).rejects.toMatchObject({code:'unknown_outcome'});
  expect(await repo.getOwned('owner',lease.operationId)).toMatchObject({status:'unknown_outcome'});
  expect(await repo.getStep('owner',lease.operationId,'questions')).toMatchObject({state:'unknown'});
  expect(await repo.claimOperation(lease.operationId,300000)).toBeNull();expect(calls).toBe(1);
});
