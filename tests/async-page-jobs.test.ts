import { expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import sharp from 'sharp';
import { ClaimInProgressError, LocalStore } from '@/src/lib/local-store';
import { acceptPanel, commitPanelRender, createComic } from '@/src/lib/domain/comic';
import {storyFingerprint} from '@/src/lib/application/views';
import type {Draft} from '@/src/lib/application/contracts';
import { handleApi } from '@/src/lib/local-api';

type StoreGlobal = typeof globalThis & { __comexLocalStore?: LocalStore };
const holder = globalThis as StoreGlobal;
const envKeys = ['COMEX_ASSET_PATH', 'COMEX_BUDGET_DB_PATH', 'COMEX_MAX_PROVIDER_CALLS', 'COMEX_MAX_CONCURRENT_CALLS', 'OPENAI_API_KEY'] as const;

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'comex-async-page-'));
  const env = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  const oldFetch = globalThis.fetch, oldStore = holder.__comexLocalStore;
  process.env.COMEX_ASSET_PATH = dir;
  process.env.COMEX_BUDGET_DB_PATH = join(dir, 'budget.sqlite');
  process.env.COMEX_MAX_PROVIDER_CALLS = '40';
  process.env.COMEX_MAX_CONCURRENT_CALLS = '5';
  process.env.OPENAI_API_KEY = 'test-key';
  const path = join(dir, 'drafts.sqlite'), store = new LocalStore(path);
  holder.__comexLocalStore = store;
  const owner = randomBytes(32).toString('hex'), comicId = randomUUID();
  const ref = randomUUID(), png = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#fff' } }).png().toBuffer();
  await writeFile(join(dir, `${ref}.png`), png);
  const domain = createComic({ id: comicId, ownerId: owner, title: 'Async test', creatorName: '', plot: 'Deliver a key', styleId: 'ink-manga', pages: [{ id: 'page1', panels: [{ id: 'p1', beat: 'Mina delivers the key' }] }] });
  const state = { location: 'town', time: 'day', props: [], outfits: [], injuries: [], knowledge: [] };
  const storyboard = { bible: { premise: 'Deliver a key', setting: 'town', rules: [], character_ids: ['mina'] }, pages: [{ index: 1, panels: [{ id: 'p1', index: 1, character_ids: ['mina'], action: 'Mina delivers the key', framing: 'wide', dialogue: [], state_before: state, state_after: state }] }] };
  const draft:Draft={ ...domain, questions: [], answers: {}, characters: [{ id: 'mina', name: 'Mina', role: 'courier', appearance: 'hair', outfit: 'coat', approved: true, referenceAssetId: ref }], storyboard };
  store.create(comicId, owner, {...draft,storyApproval:{storyRevision:draft.storyRevision,fingerprint:storyFingerprint(draft)!}});
  const cookie = `comex_session=${owner}`;
  const requestPage = (pageId: string, suffix: string, method = 'GET', body?: unknown, cookieValue = cookie) => {
    const path = `comics/${comicId}/pages/${pageId}/${suffix}`;
    return handleApi(new NextRequest(`http://localhost:3000/api/${path}`, { method, headers: { cookie: cookieValue, ...(body === undefined ? {} : { 'content-type': 'application/json', origin: 'http://localhost:3000' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), path.split('/'));
  };
  const request = (suffix: string, method = 'GET', body?: unknown, cookieValue = cookie) => requestPage('page1', suffix, method, body, cookieValue);
  const cleanup = async () => {
    globalThis.fetch = oldFetch;
    holder.__comexLocalStore = oldStore;
    store.close();
    for (const key of envKeys) { if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key]; }
    await rm(dir, { recursive: true, force: true });
  };
  return { dir, path, store, owner, comicId, ref, png, request, requestPage, cleanup };
}

async function waitForJob(request: ReturnType<typeof fixture> extends Promise<infer F> ? F extends {request: infer R} ? R : never : never, expected: string) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const response = await request('job');
    expect(response.status).toBe(200);
    const body = await response.json();
    if (body.job?.state === expected) return body;
    await Bun.sleep(10);
  }
  throw new Error(`Job did not reach ${expected}`);
}

test('page job responds promptly, is idempotent across instances and survives reload polling', async () => {
  const f = await fixture();
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const began = new Promise<void>(resolve => { started = resolve; });
  let imageCalls = 0, judgeCalls = 0;
  try {
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).includes('/images/')) { imageCalls++; started(); await gate; return Response.json({ data: [{ b64_json: f.png.toString('base64') }] }); }
      judgeCalls++;
      return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ outcome: 'inconclusive', findings: [] }) }] }] });
    }) as unknown as typeof fetch;
    const requestId = randomUUID();
    const startPromise = f.request('generate-async', 'POST', { requestId, expectedRevision: 1 });
    const response = await Promise.race([startPromise, Bun.sleep(500).then(() => { throw new Error('Start waited on the provider'); })]);
    expect(response.status).toBe(202);
    const startedJob = (await response.json()).job;
    expect(startedJob.id).toBeTruthy();
    await began;
    const secondStore = new LocalStore(f.path);
    try {
      holder.__comexLocalStore = secondStore;
      const duplicate = await f.request('generate-async', 'POST', { requestId, expectedRevision: 1 });
      expect([200, 202]).toContain(duplicate.status);
      expect((await duplicate.json()).job.id).toBe(startedJob.id);
      const competing = await f.request('generate-async', 'POST', { requestId: randomUUID(), expectedRevision: 1 });
      expect(competing.status).toBe(409);
      const other = await f.request('job', 'GET', undefined, `comex_session=${randomBytes(32).toString('hex')}`);
      expect([401, 404]).toContain(other.status);
      expect((await (await f.request('job')).json()).job.state).toBe('running');
      expect(imageCalls).toBe(1);
    } finally { holder.__comexLocalStore = f.store; secondStore.close(); }
    release();
    const done = await waitForJob(f.request, 'completed');
    expect(done.comic.pages[0].panels[0].imageUrl).toBeTruthy();
    expect(imageCalls).toBe(1); expect(judgeCalls).toBe(1);
    const completedReplay = await f.request('generate-async', 'POST', { requestId, expectedRevision: 1 });
    expect([200, 202]).toContain(completedReplay.status);
    expect((await completedReplay.json()).job.id).toBe(startedJob.id);
    expect(imageCalls).toBe(1);
  } finally { release(); await f.cleanup(); }
});

test('failed page job retains failure and replaying its request does not dispatch again', async () => {
  const f = await fixture();
  let imageCalls = 0;
  try {
    globalThis.fetch = (async () => { imageCalls++; return new Response('{}', { status: 400 }); }) as unknown as typeof fetch;
    const requestId = randomUUID();
    const response = await f.request('generate-async', 'POST', { requestId, expectedRevision: 1 });
    expect(response.status).toBe(202);
    const job = (await response.json()).job;
    const failed = await waitForJob(f.request, 'failed');
    expect(failed.job.id).toBe(job.id);
    expect(imageCalls).toBe(1);
    const replay = await f.request('generate-async', 'POST', { requestId, expectedRevision: 1 });
    expect([200, 202]).toContain(replay.status);
    expect((await replay.json()).job.id).toBe(job.id);
    expect(imageCalls).toBe(1);
  } finally { await f.cleanup(); }
});

test('an indeterminate provider outcome blocks a new page job and does not redispatch on replay', async () => {
  const f = await fixture();
  let imageCalls = 0;
  try {
    globalThis.fetch = (async () => { imageCalls++; throw new Error('provider connection lost after dispatch'); }) as unknown as typeof fetch;
    const requestId = randomUUID();
    const response = await f.request('generate-async', 'POST', { requestId, expectedRevision: 1 });
    expect(response.status).toBe(202);
    const job = (await response.json()).job;
    const unknown = await waitForJob(f.request, 'unknown');
    expect(unknown.job.id).toBe(job.id);
    const replay = await f.request('generate-async', 'POST', { requestId, expectedRevision: 1 });
    expect([200,202]).toContain(replay.status);
    expect((await replay.json()).job.id).toBe(job.id);
    const revision = f.store.getOwned(f.comicId,f.owner)!.revision;
    expect((await f.request('generate-async', 'POST', { requestId:randomUUID(), expectedRevision:revision })).status).toBe(409);
    expect(imageCalls).toBe(1);
  } finally {await f.cleanup();}
});

test('a different page cannot start while the preceding page is being regenerated', async () => {
  const f = await fixture();
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const began = new Promise<void>(resolve => { started = resolve; });
  let imageCalls = 0;
  try {
    const original = f.store.getOwned<any>(f.comicId, f.owner)!;
    let domain = createComic({ id:f.comicId, ownerId:f.owner, title:'Two pages', creatorName:'', plot:'Deliver a key', styleId:'ink-manga', pages:[{id:'page1',panels:[{id:'p1',beat:'Mina has the key'}]},{id:'page2',panels:[{id:'p2',beat:'Mina delivers the key'}]}] });
    domain = commitPanelRender(domain, f.owner, 'p1', {storyRevision:1,panelRevision:1}, f.ref, 'uncertain');
    domain = acceptPanel(domain, f.owner, 'p1', f.ref, 1);
    const state = {location:'town',time:'day',props:[],outfits:[],injuries:[],knowledge:[]};
    const spec = (id:string) => ({id,index:1,character_ids:['mina'],action:id,framing:'wide',dialogue:[],state_before:state,state_after:state});
    const storyboard = {bible:{premise:'Deliver',setting:'town',rules:[],character_ids:['mina']},pages:[{index:1,panels:[spec('p1')]},{index:2,panels:[spec('p2')]}]};
    const updated:Draft={...original.data,...domain,storyboard,storyApproval:null};
    expect(f.store.update(f.comicId,f.owner,original.revision,{...updated,storyApproval:{storyRevision:updated.storyRevision,fingerprint:storyFingerprint(updated)!}})).toBe(true);
    globalThis.fetch = (async (url:string|URL|Request) => {
      if (String(url).includes('/images/')) {imageCalls++;started();await gate;return Response.json({data:[{b64_json:f.png.toString('base64')}]});}
      return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({outcome:'inconclusive',findings:[]})}]}]});
    }) as unknown as typeof fetch;
    expect((await f.request('generate-async','POST',{requestId:randomUUID(),expectedRevision:2})).status).toBe(202);
    await began;
    const revision = f.store.getOwned(f.comicId,f.owner)!.revision;
    expect((await f.requestPage('page2','generate-async','POST',{requestId:randomUUID(),expectedRevision:revision})).status).toBe(409);
    expect(imageCalls).toBe(1);
    release();
    await waitForJob(f.request,'completed');
  } finally {release();await f.cleanup();}
});

test('page job reservations are atomic and idempotent across SQLite store instances', async () => {
  const f = await fixture();
  const second = new LocalStore(f.path);
  try {
    const id = randomUUID();
    const first = f.store.beginPageJob(f.comicId,f.owner,'page1',id,1);
    expect(first?.created).toBe(true);
    const replay = second.beginPageJob(f.comicId,f.owner,'page1',id,1);
    expect(replay?.created).toBe(false);
    expect(replay?.job.id).toBe(id);
    expect(second.beginPageJob(f.comicId,f.owner,'page2',randomUUID(),1)).toBeNull();
    f.store.finishPageJob(id,f.owner,'completed',null);
    const replayAfterCompletion = second.beginPageJob(f.comicId,f.owner,'page1',id,1);
    expect(replayAfterCompletion?.created).toBe(false);
    expect(replayAfterCompletion?.job.state).toBe('completed');
  } finally {second.close();await f.cleanup();}
});

test('same-browser account claim waits for a running page job without consuming the sign-in code', async () => {
  const f = await fixture();
  try {
    const email='creator@example.test', secret='test-secret-'.repeat(4), code='12345678';
    const guest = f.store.createGuest(email), comicId = randomUUID();
    const draft = createComic({id:comicId,ownerId:guest.owner,title:'Guest draft',creatorName:'',plot:'Delivery',styleId:'ink-manga',pages:[{id:'page1',panels:[{id:'p1',beat:'Delivery'}]}]});
    f.store.create(comicId,guest.owner,{...draft,questions:[],answers:{},characters:[]});
    const jobId = randomUUID();
    expect(f.store.beginPageJob(comicId,guest.owner,'page1',jobId,1)?.created).toBe(true);
    expect(f.store.issueCode(email,code,guest.token,secret)).toBeTruthy();
    expect(() => f.store.consumeCode(email,code,secret,guest.token,guest.owner)).toThrow(ClaimInProgressError);
    expect(f.store.getOwned(comicId,guest.owner)).not.toBeNull();
    f.store.finishPageJob(jobId,guest.owner,'completed',null);
    const signedIn = f.store.consumeCode(email,code,secret,guest.token,guest.owner);
    expect(signedIn?.sameBrowser).toBe(true);
    const user = f.store.authIdentity(signedIn!.session);
    expect(user).not.toBeNull();
    expect(f.store.getOwned(comicId,user!.owner)).not.toBeNull();
    expect(f.store.getOwned(comicId,guest.owner)).toBeNull();
  } finally {await f.cleanup();}
});

test('operator can reconcile a crashed job without automatically dispatching or refunding work', async () => {
  const f=await fixture();
  try {
    const id=randomUUID();expect(f.store.beginPageJob(f.comicId,f.owner,'page1',id,1)?.created).toBe(true);
    const run=(...args:string[])=>Bun.spawnSync(['bun','scripts/resolve-page-job.ts',...args],{env:{...process.env,COMEX_DB_PATH:f.path},stdout:'pipe',stderr:'pipe'});
    expect(run(id,'--mark-unknown').exitCode).not.toBe(0);
    expect(run(id,'--mark-unknown','--confirm').exitCode).toBe(0);
    expect(f.store.pageJob(f.comicId,f.owner,'page1',id)?.state).toBe('unknown');
    expect(f.store.beginPageJob(f.comicId,f.owner,'page1',randomUUID(),1)).toBeNull();
    const draft=f.store.getOwned<any>(f.comicId,f.owner)!;
    expect(f.store.update(f.comicId,f.owner,draft.revision,{...draft.data,operations:{'panel:p1':'unknown_outcome'}})).toBe(true);
    expect(run(id,'--resolve','--confirm').exitCode).not.toBe(0);
    const reconciled=f.store.getOwned<any>(f.comicId,f.owner)!;
    expect(f.store.update(f.comicId,f.owner,reconciled.revision,{...reconciled.data,operations:{}})).toBe(true);
    expect(run(id,'--resolve','--confirm').exitCode).toBe(0);
    expect(f.store.pageJob(f.comicId,f.owner,'page1',id)?.state).toBe('failed');
    expect(f.store.beginPageJob(f.comicId,f.owner,'page1',randomUUID(),reconciled.revision+1)?.created).toBe(true);
  } finally {await f.cleanup();}
});
