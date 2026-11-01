import {afterAll,beforeAll,expect,test} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {PostgresOperationRepository} from '../src/lib/operations/postgres';
import {PostgresPaidGateway} from '../src/lib/operations/paid-gateway';

const pgTest=process.env.TEST_DATABASE_URL?test:test.skip,schema=`comex_pool_${randomUUID().replaceAll('-','')}`;
let admin:Pool,setup:Pool;
beforeAll(async()=>{
  if(!process.env.TEST_DATABASE_URL)return;
  admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});await admin.query(`CREATE SCHEMA "${schema}"`);
  setup=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});
  // Apply the same schema in this isolated namespace without the global migration lock.
  await setup.query(await readFile('db/migrations/001_hosted_storage.sql','utf8'));
  await setup.query(await readFile('db/migrations/002_mcp_grants.sql','utf8'));
  await setup.query(await readFile('db/migrations/003_operations.sql','utf8'));
  await setup.query(await readFile('db/migrations/006_provider_costs.sql','utf8'));
  await setup.query('CREATE TABLE "session" (id text PRIMARY KEY,token text,"userId" text,"expiresAt" timestamptz,"updatedAt" timestamptz)');
  for(const id of ['1','2']) {
    await setup.query('INSERT INTO "session"(id,token,"userId","expiresAt","updatedAt") VALUES ($1,$2,$3,now()+interval \'1 hour\',now())',[`s${id}`,`token${id}`,'u']);
    await setup.query('INSERT INTO mcp_grants(id,owner,client_id,session_id,user_id,client_name,created_at) VALUES ($1,$2,$3,$4,$5,$6,1)',[`g${id}`,'owner','client',`s${id}`,'u','Client']);
    await setup.query('INSERT INTO comics(id,owner,revision,draft) VALUES ($1,$2,1,$3)',[`comic${id}`,'owner',JSON.stringify({id:`comic${id}`,ownerId:'owner'})]);
  }
});
afterAll(async()=>{await setup?.end();if(admin){await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}});
const assets={save:async()=>{throw new Error('unexpected asset save');},read:async()=>{throw new Error('unexpected asset read');}};

async function saturate(sameComic:boolean){
  const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`,max:2,connectionTimeoutMillis:1500});
  const repo=new PostgresOperationRepository(setup,{maxCalls:20,maxConcurrent:10}),suffix=randomUUID();
  const leases=[];
  for(let i=0;i<2;i++) {
    const which=sameComic?1:i+1;
    const op=(await repo.start({owner:'owner',action:'test',requestKey:`${suffix}-${i}`,targetId:`comic${which}`,grantId:`g${which}`,expectedVersions:1,input:{}},async()=>{})).operation;
    leases.push((await repo.claimOperation(op.id,300000))!);
  }
  let count=0,release!:()=>void;
  const both=new Promise<void>(r=>{release=r;});
  const synchronized=new Proxy(pool,{get(target,key){
    if(key==='connect')return async()=>{const client=await target.connect();if(++count<=2){if(count===2)release();await both;}return client;};
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }}) as Pool;
  const operations=new PostgresOperationRepository(synchronized,{maxCalls:20,maxConcurrent:10});let calls=0;
  const gateway=new PostgresPaidGateway(synchronized,operations,assets,async()=>{calls++;return Response.json({ok:true});});
  try {
    const outcomes=await Promise.allSettled(leases.map(lease=>gateway.run({lease,owner:'owner',step:{id:'step',input:{}},expectedRevision:1},async fetch=>{
      // Simulates service-side asset lookup before provider dispatch through the app pool.
      await pool.query('SELECT 1');return (await fetch('https://example.test')).json();
    })));
    expect(outcomes).toEqual([{status:'fulfilled',value:{ok:true}},{status:'fulfilled',value:{ok:true}}]);
    expect(calls).toBe(2);
    for(const lease of leases)expect((await operations.getStep('owner',lease.operationId,'step'))?.state).toBe('completed');
  } finally {await pool.end();}
}
pgTest('a full two-client pool progresses when workers use different comics and grants',async()=>{await saturate(false);});
pgTest('a full two-client pool progresses when workers contend for one comic and grant',async()=>{await saturate(true);});
