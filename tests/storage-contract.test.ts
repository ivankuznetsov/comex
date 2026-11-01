import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Pool} from 'pg';
import {LocalStore} from '../src/lib/local-store';
import {ProviderBudget} from '../src/lib/budget';
import type {ComicRepository} from '../src/lib/application/contracts';
import {applyMigrations, PostgresRepository, PostgresProviderBudget, createPostgresBudgetedFetch} from '../src/lib/storage/postgres';
import {PostgresAuth} from '../src/lib/storage/auth';
import {finalizeBudgetedResponse} from '../src/lib/budget';
import {createAIService} from '../src/lib/ai/service';
import {importSqlite} from '../src/lib/storage/import';
import {PostgresAssets, VercelPrivateObjects, type PrivateObjects} from '../src/lib/storage/assets';
import {createComicService} from '../src/lib/application/comics';

class MemoryObjects implements PrivateObjects {
  data = new Map<string, Buffer>();
  async put(path:string, bytes:Uint8Array) { this.data.set(path, Buffer.from(bytes)); return path; }
  async read(path:string) { const bytes=this.data.get(path); if (!bytes) throw new Error('missing object'); return Buffer.from(bytes); }
  async delete(path:string) { this.data.delete(path); }
}

function repositoryContract(make:()=>Promise<{store:ComicRepository; close:()=>Promise<void>}>) {
  test('owner isolation, revision CAS, publication snapshots and text reservations', async () => {
    const {store,close}=await make();
    try {
      await store.create('comic','owner',{title:'private'});
      expect(await store.getOwned('comic','other')).toBeNull();
      expect(await store.listOwned('other')).toEqual([]);
      expect(await store.reserveTextOperation('comic','other',1)).toBe(false);
      expect(await store.reserveTextOperation('comic','owner',2)).toBe(false);
      expect((await Promise.all([store.reserveTextOperation('comic','owner',1),store.reserveTextOperation('comic','owner',1)])).filter(Boolean)).toHaveLength(1);
      await store.finishTextOperation('comic','owner',true);
      expect(await store.reserveTextOperation('comic','owner',1)).toBe(false);
      await store.finishTextOperation('comic','owner',false);
      expect(await store.reserveTextOperation('comic','owner',1)).toBe(false);
      const updates=await Promise.all([store.update('comic','owner',1,{title:'one'}),store.update('comic','owner',1,{title:'two'})]);
      expect(updates.filter(Boolean)).toHaveLength(1);
      expect(await store.getOwned('comic','owner')).toMatchObject({revision:2});
      expect(await store.publish('comic','other',2,{title:'leak'},[{id:'page',data:new Uint8Array([1,2,3])}])).toBe(false);
      expect(await store.publish('comic','owner',2,{title:'public'},[{id:'page',data:new Uint8Array([1,2,3])}])).toBe(true);
      expect(await store.publish('comic','owner',2,{title:'stale'},[{id:'bad',data:new Uint8Array([9])}])).toBe(false);
      expect(await store.getPublicationAsset('comic','page')).toEqual(new Uint8Array([1,2,3]));
      expect(await store.update('comic','owner',3,{title:'unpublished'})).toBe(true);
      expect(await store.getPublished('comic')).toEqual({title:'public'});
      await expect(Promise.resolve().then(()=>store.publish('comic','owner',4,{title:'broken'},[{id:'duplicate',data:new Uint8Array([4])},{id:'duplicate',data:new Uint8Array([5])}]))).rejects.toThrow();
      expect(await store.getPublished('comic')).toEqual({title:'public'});
      expect(await store.getPublicationAsset('comic','page')).toEqual(new Uint8Array([1,2,3]));
      expect(await store.withdraw('comic','other')).toBe(false);
      expect(await store.withdraw('comic','owner',3)).toBe(false);
      expect(await store.withdraw('comic','owner',4)).toBe(true);
      expect(await store.getPublished('comic')).toBeNull();
      expect(await store.getPublicationAsset('comic','page')).toBeNull();
      expect(await store.publish('comic','owner',4,{title:'stale'},[])).toBe(false);
    } finally {await close();}
  });
}

function authContract(make:()=>Promise<{store:any; repository:ComicRepository;close:()=>Promise<void>}>) {
  test('guest and email authentication preserves owned drafts and refuses claims while work is running',async()=>{
    const {store,repository,close}=await make();
    try {
      const now=1_000_000, guest=await store.createGuest('same@example.test',now);
      await repository.create('auth-comic',guest.owner,{ownerId:guest.owner,title:'kept',operations:{}});
      expect(await store.guestIdentity(guest.token,now)).toEqual({owner:guest.owner,email:'same@example.test'});
      expect(await store.guestIdentity(guest.token,now+31*24*60*60*1000)).toBeNull();
      expect(await store.issueCode('same@example.test','123456',guest.token,'secret',now)).toBeTruthy();
      expect(await store.consumeCode('same@example.test','wrong','secret',guest.token,guest.owner,now)).toBeNull();
      expect(await repository.reserveTextOperation('auth-comic',guest.owner,1)).toBe(true);
      await expect(Promise.resolve().then(()=>store.consumeCode('same@example.test','123456','secret',guest.token,guest.owner,now))).rejects.toThrow('Wait for your existing draft generation');
      await repository.finishTextOperation('auth-comic',guest.owner,true);
      const result=await store.consumeCode('same@example.test','123456','secret',guest.token,guest.owner,now);
      expect(result.sameBrowser).toBe(true);
      const identity=await store.authIdentity(result.session,now);
      expect(identity.email).toBe('same@example.test');
      expect(await repository.getOwned('auth-comic',guest.owner)).toBeNull();
      expect(await repository.getOwned('auth-comic',identity.owner)).toEqual({revision:2,data:{ownerId:identity.owner,title:'kept',operations:{}}});
      expect(await repository.reserveTextOperation('auth-comic',identity.owner,2)).toBe(false);
      expect(await store.consumeCode('same@example.test','123456','secret',guest.token,guest.owner,now)).toBeNull();
      await store.signOut(result.session); expect(await store.authIdentity(result.session,now)).toBeNull();
    } finally {await close();}
  });
  test('email issue and verification quotas retain local expiry and rejection behavior',async()=>{
    const {store,close}=await make();
    try {
      const now=3_000_000,email='limits@example.test',salts:string[]=[];
      for(let i=0;i<5;i++) salts.push(await store.issueCode(email,'123456','browser','secret',now));
      expect(await store.issueCode(email,'123456','browser','secret',now)).toBeNull();
      await store.invalidateCode(email,salts[4],true);
      expect(await store.issueCode(email,'123456','browser','secret',now)).toBeTruthy();
      for(let i=0;i<10;i++) expect(await store.consumeCode(email,'wrong','secret','browser',null,now)).toBeNull();
      expect(await store.consumeCode(email,'123456','secret','browser',null,now)).toBeNull();
      expect(await store.consumeCode(email,'123456','secret','browser',null,now+16*60*1000)).toBeNull();
    } finally {await close();}
  });
  test('a code redeemed in a different browser cannot claim the guest draft',async()=>{
    const {store,repository,close}=await make();
    try {
      const now=2_000_000, guest=await store.createGuest('other@example.test',now);
      await repository.create('auth-other',guest.owner,{ownerId:guest.owner});
      await store.issueCode('other@example.test','123456',guest.token,'secret',now);
      const result=await store.consumeCode('other@example.test','123456','secret','different',guest.owner,now);
      expect(result.sameBrowser).toBe(false);
      expect(await repository.getOwned('auth-other',guest.owner)).not.toBeNull();
      const identity=await store.authIdentity(result.session,now);
      expect(await repository.getOwned('auth-other',identity.owner)).toBeNull();
    } finally {await close();}
  });
}

describe('SQLite repository contract', () => {
  repositoryContract(async()=>{const store=new LocalStore(':memory:');return {store,close:async()=>store.close()};});
  authContract(async()=>{const store=new LocalStore(':memory:');return {store,repository:store,close:async()=>store.close()};});
});

const postgresDescribe=process.env.TEST_DATABASE_URL ? describe : describe.skip;
postgresDescribe('Postgres repository and import', () => {
  let admin:Pool, pool:Pool, second:Pool, objects:MemoryObjects;
  const schema=`comex_test_${randomUUID().replaceAll('-','')}`;
  beforeAll(async()=>{
    admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});
    second=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});
    await applyMigrations(pool); await applyMigrations(pool);
    objects=new MemoryObjects();
  });
  afterAll(async()=>{await pool?.end();await second?.end();if(admin){await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}});
  repositoryContract(async()=>({store:new PostgresRepository(pool,objects),close:async()=>{}}));
  authContract(async()=>({store:new PostgresAuth(pool),repository:new PostgresRepository(pool,objects),close:async()=>{}}));
  test('independent connections enforce cumulative and active caps and claim a provider step only once', async()=>{
    const a=new PostgresProviderBudget(pool,{maxCalls:3,maxConcurrent:1}), b=new PostgresProviderBudget(second,{maxCalls:3,maxConcurrent:1});
    const results=await Promise.allSettled([a.reserve('operation:step'),b.reserve('operation:step')]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    const reservation=(results.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<string>).value;
    await a.finish(reservation,'unknown');
    expect(await b.summary()).toEqual({used:1,active:1,unknown:1});
    await expect(b.reserve('another')).rejects.toMatchObject({code:'concurrency_limit'});
    await b.resolveUnknown(reservation);
    await expect(b.reserve('operation:step')).rejects.toMatchObject({code:'reservation_exists'});
    const next=await b.reserve('another'); await a.finish(next,'completed');
    const third=await a.reserve('third'); await b.finish(third,'completed');
    await expect(a.reserve('fourth')).rejects.toMatchObject({code:'budget_exhausted'});
    expect(await b.summary()).toEqual({used:3,active:0,unknown:0});
  });
  test('simultaneous workers cannot exceed the active shared budget',async()=>{
    await pool.query('TRUNCATE provider_reservations CASCADE');
    const a=new PostgresProviderBudget(pool,{maxCalls:5,maxConcurrent:2}),b=new PostgresProviderBudget(second,{maxCalls:5,maxConcurrent:2});
    const outcomes=await Promise.allSettled(Array.from({length:12},(_,i)=>(i%2 ? a : b).reserve(`distinct:${i}`)));
    expect(outcomes.filter(x=>x.status==='fulfilled')).toHaveLength(2);
    expect(outcomes.filter(x=>x.status==='rejected')).toHaveLength(10);
    expect(await b.summary()).toEqual({used:2,active:2,unknown:0});
  });
  test('separate processes share the same concurrency cap',async()=>{
    await pool.query('TRUNCATE provider_reservations CASCADE');
    const children=Array.from({length:6},(_,i)=>Bun.spawn({cmd:['bun','run','tests/helpers/budget-worker.ts'],stdin:'pipe',stdout:'pipe',stderr:'pipe',env:{...process.env,TEST_SCHEMA:schema,TEST_STEP:`process:${i}`}}));
    for(const child of children) {child.stdin.write('go');child.stdin.end();}
    const outcomes=await Promise.all(children.map(async child=>{
      const [output,error,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
      if(exit!==0) throw new Error(`Budget worker failed: ${error}`);
      return JSON.parse(output) as {ok:boolean;code?:string};
    }));
    expect(outcomes.filter(result=>result.ok)).toHaveLength(2);
    expect(outcomes.filter(result=>result.code==='concurrency_limit')).toHaveLength(4);
    expect(await new PostgresProviderBudget(pool,{maxCalls:10,maxConcurrent:2}).summary()).toEqual({used:2,active:2,unknown:0});
  },30000);
  test('publication checks ownership and revision before uploading bytes',async()=>{
    const store=new PostgresRepository(pool,objects); await store.create('precheck','alice',{});
    const before=objects.data.size;
    expect(await store.publish('precheck','bob',1,{},[{id:'image',data:new Uint8Array([1])}])).toBe(false);
    expect(await store.publish('precheck','alice',2,{},[{id:'image',data:new Uint8Array([1])}])).toBe(false);
    expect(objects.data.size).toBe(before);
  });
  test('the hosted budgeted fetch finalizes completed and unknown outcomes without retrying',async()=>{
    await pool.query('TRUNCATE provider_reservations CASCADE');
    const budget=new PostgresProviderBudget(pool,{maxCalls:4,maxConcurrent:1}); let calls=0;
    const request=createPostgresBudgetedFetch(budget,async()=>{calls++;return new Response('{}',{status:200});});
    const response=await request('https://example.test');
    expect(await budget.summary()).toEqual({used:1,active:1,unknown:0});
    await response.json(); await finalizeBudgetedResponse(response,'completed');
    expect(await budget.summary()).toEqual({used:1,active:0,unknown:0});
    const failed=createPostgresBudgetedFetch(budget,async()=>{calls++;throw new Error('connection lost');});
    await expect(failed('https://example.test')).rejects.toThrow('connection lost');
    await expect(request('https://example.test')).rejects.toMatchObject({code:'concurrency_limit'});
    expect(calls).toBe(2); expect(await budget.summary()).toEqual({used:2,active:1,unknown:1});
  });
  test('the shared provider waits for Postgres completed and unknown finalization',async()=>{
    await pool.query('TRUNCATE provider_reservations CASCADE');
    const budget=new PostgresProviderBudget(pool,{maxCalls:4,maxConcurrent:1});
    const valid=Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({questions:[{id:'q',question:'Where?',suggested_answer:'London'}]})}]}]});
    const service=createAIService({apiKey:'test',fetch:createPostgresBudgetedFetch(budget,async()=>valid)});
    expect(await service.questions({plot:'story',style:'ink',answers:{},limit:1})).toHaveLength(1);
    expect(await budget.summary()).toEqual({used:1,active:0,unknown:0});
    const invalid=createAIService({apiKey:'test',fetch:createPostgresBudgetedFetch(budget,async()=>new Response('{'))});
    await expect(invalid.questions({plot:'story',style:'ink',answers:{},limit:1})).rejects.toMatchObject({code:'unknown_outcome'});
    expect(await budget.summary()).toEqual({used:2,active:1,unknown:1});
  });
  test('shared application retains its guided questions and answers with Postgres',async()=>{
    const repository=new PostgresRepository(pool,objects),assets=new PostgresAssets(pool,objects),inputs:unknown[]=[];
    const provider=()=>({
      async questions(input:unknown) {inputs.push(input);return [{id:'q1',question:'Who gets the key?',suggestedAnswer:'Her brother'}];},
      async characterSuggestions(input:unknown) {inputs.push(input);return [{name:'Mina',role:'courier',appearance:'hair',outfit:'coat'}];},
    }) as unknown as ReturnType<typeof import('../src/lib/ai/service').createAIService>;
    const service=createComicService({repository,assets,provider,budgetFetch:async()=>{throw new Error('unexpected');},id:randomUUID});
    const id=(await service.create('guided-owner',{title:'Courier',plot:'A courier carries a key',style:'ink-manga'})).comic.id;
    await expect(service.get('another-owner',id)).rejects.toMatchObject({code:'not_found'});
    const asked=(await service.initialQuestions('guided-owner',id)).comic;
    expect(asked.questions[0]).toMatchObject({question:'Who gets the key?',suggestedAnswer:'Her brother'});
    await service.update('guided-owner',id,{answers:{[asked.questions[0].id]:'Her brother'}});
    expect((await service.suggestCharacters('guided-owner',id,{})).comic.characterSuggestions[0].name).toBe('Mina');
    expect(inputs[1]).toMatchObject({answers:{'Who gets the key?':'Her brother'}});
  });
  test('private draft assets require membership while edition assets are independently published',async()=>{
    const repository=new PostgresRepository(pool,objects), assets=new PostgresAssets(pool,objects);
    const service=createComicService({repository,assets,provider:()=>({}) as ReturnType<typeof import('../src/lib/ai/service').createAIService>,budgetFetch:async()=>{throw new Error('unexpected');},id:randomUUID});
    const id=(await service.create('asset-owner',{title:'Draft',plot:'A plot',style:'ink-manga'})).comic.id;
    const card=(await service.addCharacter('asset-owner',id,{name:'Mina',role:'courier',appearance:'hair',outfit:'coat'})).comic.characters[0];
    const assetId=await assets.save(Buffer.from([9,8,7]));
    const owned=await repository.getOwned<any>(id,'asset-owner');
    await repository.update(id,'asset-owner',owned!.revision,{...owned!.data,characters:owned!.data.characters.map((c:any)=>c.id===card.id?{...c,referenceAssetId:assetId}:c)});
    await expect(service.getAsset('intruder',id,assetId)).rejects.toMatchObject({code:'not_found'});
    expect(await service.getAsset('asset-owner',id,assetId)).toEqual(Buffer.from([9,8,7]));
    expect(await repository.getPublicationAsset(id,assetId)).toBeNull();
    expect(await repository.getPublished(id)).toBeNull();
  });
  test('repeat import preserves IDs, revision, edition bytes, auth rows, hashes and reservation history without granting access', async()=>{
    const dir=await mkdtemp(join(tmpdir(),'comex-import-fixture-'));
    try {
      const path=join(dir,'source.sqlite'), budgetPath=join(dir,'budget.sqlite'), assetId=randomUUID(), bytes=Buffer.from([5,8,13]);
      const source=new LocalStore(path); const guest=source.createGuest('owner@example.test');
      source.create('imported',guest.owner,{ownerId:guest.owner,assetId});
      expect(source.update('imported',guest.owner,1,{ownerId:guest.owner,assetId,title:'v2'})).toBe(true);
      expect(source.publish('imported',guest.owner,2,{id:'imported',editionId:'ed-1'},[{id:'public-page',data:new Uint8Array([2,4,6])}])).toBe(true);
      expect(source.reserveTextOperation('imported',guest.owner,3)).toBe(true); source.finishTextOperation('imported',guest.owner,true);
      source.issueCode('owner@example.test','123456','browser','secret');
      const other=source.createGuest('account@example.test');
      source.create('account-comic',other.owner,{ownerId:other.owner,title:'account'});
      source.issueCode('account@example.test','654321',other.token,'secret');
      const account=source.consumeCode('account@example.test','654321','secret',other.token,other.owner)!;
      const identity=source.authIdentity(account.session)!;
      const budget=new ProviderBudget(budgetPath,{maxCalls:10,maxConcurrent:3}); const completed=budget.reserve(), unknown=budget.reserve();
      budget.finish(completed,'completed'); budget.finish(unknown,'unknown'); budget.close(); source.close();
      await writeFile(join(dir,`${assetId}.png`),bytes);
      const options={pool,objects,databasePath:path,budgetPath,assetPath:dir,batchId:'fixture-batch'};
      const hostedBudget=new PostgresProviderBudget(pool,{maxCalls:100,maxConcurrent:100});
      const before=await hostedBudget.summary();
      await importSqlite(options); await importSqlite(options);
      expect(await hostedBudget.summary()).toEqual({used:before.used+2,active:before.active+1,unknown:before.unknown+1});
      const row=(await pool.query('SELECT id,owner,revision,draft,edition FROM comics WHERE id=$1',['imported'])).rows[0];
      expect(row).toMatchObject({id:'imported',owner:guest.owner,revision:3,draft:{assetId,title:'v2'},edition:{editionId:'ed-1'}});
      expect((await pool.query('SELECT count(*)::int AS n FROM comics WHERE id=$1',['imported'])).rows[0].n).toBe(1);
      expect((await pool.query('SELECT sha256 FROM assets WHERE id=$1',[assetId])).rows[0].sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
      expect((await pool.query('SELECT count(*)::int AS n FROM auth_guests WHERE owner=$1',[guest.owner])).rows[0].n).toBe(1);
      expect((await pool.query('SELECT count(*)::int AS n FROM auth_codes WHERE email=$1',['owner@example.test'])).rows[0].n).toBe(1);
      expect(await new PostgresAuth(pool).authIdentity(account.session)).toEqual(identity);
      expect((await pool.query('SELECT owner,revision,draft FROM comics WHERE id=$1',['account-comic'])).rows[0]).toMatchObject({owner:identity.owner,revision:2,draft:{ownerId:identity.owner}});
      expect(await new PostgresRepository(pool,objects).getOwned('account-comic',identity.owner)).toBeNull();
      expect(await new PostgresAssets(pool,objects).read(assetId)).toEqual(bytes);
      expect((await pool.query('SELECT state FROM comic_text_operations WHERE comic_id=$1',['imported'])).rows[0].state).toBe('unknown');
      const store=new PostgresRepository(pool,objects);
      expect(await store.getOwned('imported',guest.owner)).toBeNull();
      const stagedLogin=await new PostgresAuth(pool).consumeCode('owner@example.test','123456','secret','browser',guest.owner);
      expect(stagedLogin?.sameBrowser).toBe(true);
      expect(await store.getOwned('imported',guest.owner)).toBeNull();
      expect(await new PostgresAuth(pool).guestIdentity(guest.token)).toMatchObject({owner:guest.owner});
      expect(await store.getPublished('imported')).toEqual({id:'imported',editionId:'ed-1'});
      expect(await store.getPublicationAsset('imported','public-page')).toEqual(new Uint8Array([2,4,6]));
      const counts=(await pool.query("SELECT state,count(*)::int AS n FROM provider_reservations WHERE id=ANY($1) GROUP BY state",[[completed,unknown]])).rows;
      expect(counts.sort((a,b)=>a.state.localeCompare(b.state))).toEqual([{state:'completed',n:1},{state:'unknown',n:1}]);
      await writeFile(join(dir,`${assetId}.png`),Buffer.from([0]));
      await expect(importSqlite(options)).rejects.toThrow('different source data');
      expect(await new PostgresAssets(pool,objects).read(assetId)).toEqual(bytes);
      expect(await hostedBudget.summary()).toEqual({used:before.used+2,active:before.active+1,unknown:before.unknown+1});
    } finally {await rm(dir,{recursive:true,force:true});}
  });
});
