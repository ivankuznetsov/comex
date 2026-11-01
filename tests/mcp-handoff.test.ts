import {afterAll,beforeAll,describe,expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {applyMigrations} from '../src/lib/storage/postgres';
import {PostgresAuth} from '../src/lib/storage/auth';
import {LocalStore} from '../src/lib/local-store';
import {attestImport,issueImportChallenge,redeemImport,registerImportBatch} from '../src/lib/auth/claim';

const destination='https://comex.example', secret='test-handoff-secret-test-handoff-secret-test-handoff-secret';
const pgDescribe=process.env.TEST_DATABASE_URL?describe:describe.skip;
pgDescribe('local to hosted ownership handoff',()=>{
  const schema='comex_handoff_test_'+randomUUID().replaceAll('-','');
  let admin:Pool,pool:Pool,local:LocalStore,dir:string;
  beforeAll(async()=>{
    const config={connectionString:process.env.TEST_DATABASE_URL};
    admin=new Pool(config);await admin.query(`CREATE SCHEMA "${schema}"`);pool=new Pool({...config,options:`-c search_path=${schema}`});await applyMigrations(pool);
    dir=mkdtempSync(join(tmpdir(),'comex-handoff-'));local=new LocalStore(join(dir,'source.sqlite'));
  });
  afterAll(async()=>{local?.close();if(dir)rmSync(dir,{recursive:true,force:true});await pool?.end();if(admin){await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}});
  test('trusted batch, local possession and destination session are all required; proof is one use',async()=>{
    const source=local.createGuest('creator@example.test'),hosted=new PostgresAuth(pool),target=await hosted.createGuest('creator@example.test'),other=await hosted.createGuest('other@example.test');
    const batch='test-batch';await pool.query('INSERT INTO import_batches(id,fingerprint) VALUES ($1,$2)',[batch,'fixture']);
    await pool.query('INSERT INTO comics(id,owner,revision,draft,import_batch_id) VALUES ($1,$2,1,$3,$4)',['imported',source.owner,JSON.stringify({ownerId:source.owner,title:'imported'}),batch]);
    const cookie=`comex_session=${target.token}`,sourceCookie=`comex_session=${source.token}`;
    const challenge=await issueImportChallenge({pool,identityStore:hosted,cookie,batchId:batch,origin:destination,secret});
    expect(challenge).toBeNull(); // operator has not registered this batch
    await registerImportBatch(pool,batch);
    const valid=await issueImportChallenge({pool,identityStore:hosted,cookie,batchId:batch,origin:destination,secret});expect(valid).toBeTruthy();
    expect(valid).not.toContain(source.token);
    expect(await attestImport({identityStore:local,cookie:'',challenge:valid!,origin:destination,secret})).toBeNull();
    expect(await attestImport({identityStore:local,cookie:sourceCookie,challenge:valid!,origin:'https://wrong.example',secret})).toBeNull();
    const proof=await attestImport({identityStore:local,cookie:sourceCookie,challenge:valid!,origin:destination,secret});expect(proof).toBeTruthy();expect(proof).not.toContain(source.token);
    expect(await redeemImport({pool,identityStore:hosted,cookie:`comex_session=${other.token}`,proof:proof!,origin:destination,secret})).toBe(false);
    expect(await redeemImport({pool,identityStore:hosted,cookie,proof:proof!+'x',origin:destination,secret})).toBe(false);
    expect((await pool.query('SELECT import_batch_id FROM comics WHERE id=$1',['imported'])).rows[0].import_batch_id).toBe(batch);
    expect(await redeemImport({pool,identityStore:hosted,cookie,proof:proof!,origin:destination,secret})).toBe(true);
    expect(await redeemImport({pool,identityStore:hosted,cookie,proof:proof!,origin:destination,secret})).toBe(false);
    const row=(await pool.query('SELECT owner,draft,revision,import_batch_id FROM comics WHERE id=$1',['imported'])).rows[0];
    expect(row.owner).toBe(target.owner);expect(row.draft.ownerId).toBe(target.owner);expect(row.revision).toBe(2);expect(row.import_batch_id).toBeNull();
  });
  test('expired proof and a different destination are rejected',async()=>{
    const source=local.createGuest('old@example.test'),hosted=new PostgresAuth(pool),target=await hosted.createGuest('old@example.test'),batch='expiry-batch';
    await pool.query('INSERT INTO import_batches(id,fingerprint) VALUES ($1,$2)',[batch,'fixture']);
    await pool.query('INSERT INTO comics(id,owner,revision,draft,import_batch_id) VALUES ($1,$2,1,$3,$4)',['old',source.owner,JSON.stringify({ownerId:source.owner}),batch]);await registerImportBatch(pool,batch);
    const cookie=`comex_session=${target.token}`,now=Date.now();
    const challenge=await issueImportChallenge({pool,identityStore:hosted,cookie,batchId:batch,origin:destination,secret,now});
    const proof=await attestImport({identityStore:local,cookie:`comex_session=${source.token}`,challenge:challenge!,origin:destination,secret,now});
    expect(await redeemImport({pool,identityStore:hosted,cookie,proof:proof!,origin:destination,secret,now:now+11*60_000})).toBe(false);
    expect(await redeemImport({pool,identityStore:hosted,cookie,proof:proof!,origin:'https://wrong.example',secret,now})).toBe(false);
    expect((await pool.query('SELECT import_batch_id FROM comics WHERE id=$1',['old'])).rows[0].import_batch_id).toBe(batch);
  });
});
