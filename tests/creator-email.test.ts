import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import {NextRequest} from 'next/server';
import {randomBytes, randomUUID} from 'node:crypto';
import {LocalStore} from '../src/lib/local-store';
import {handleApi, type BrowserBackend} from '../src/lib/local-api';

const store=new LocalStore(':memory:');
const globals=globalThis as typeof globalThis & {__comexLocalStore?:LocalStore};
let previous:LocalStore|undefined;
beforeAll(()=>{previous=globals.__comexLocalStore;globals.__comexLocalStore=store;});
afterAll(()=>{globals.__comexLocalStore=previous;store.close();});

const request=(path:string, body:unknown, cookie?:string)=>new NextRequest(`https://comex.example/api/${path}`,{
  method:'POST',headers:{host:'comex.example',origin:'https://comex.example','content-type':'application/json',...(cookie?{cookie}:{})},body:JSON.stringify(body),
});
const backend={auth:store,workspaceId:(owner:string)=>owner,validateRequest:()=>true} as unknown as BrowserBackend;

describe('creator email at draft creation',()=>{
  test('a new local creator must provide a valid email and the guest identity stores it',async()=>{
    const body={title:'A comic',plot:'A courier delivers a key',style:'ink-manga'};
    const local=(data:unknown)=>new NextRequest('http://localhost:3000/api/comics',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});
    expect((await handleApi(local(body),['comics'])).status).toBe(400);
    const created=await handleApi(local({...body,email:'Creator@EXAMPLE.test'}),['comics']);
    expect(created.status).toBe(201);
    const token=created.headers.get('set-cookie')!.match(/comex_session=([^;]+)/)![1];
    expect(store.guestIdentity(token)?.email).toBe('Creator@example.test');
  });

  test('a hosted creator cannot start a new guest workspace without an email',async()=>{
    expect((await handleApi(request('auth/guest',{}),['auth','guest'],backend)).status).toBe(400);
    const created=await handleApi(request('auth/guest',{email:'Reader@EXAMPLE.test'}),['auth','guest'],backend);
    expect(created.status).toBe(200);
    const token=created.headers.get('set-cookie')!.match(/comex_session=([^;]+)/)![1];
    expect(store.guestIdentity(token)?.email).toBe('Reader@example.test');
  });

  test('existing email-less hosted guests can add their email without losing their workspace',async()=>{
    const guest=store.createGuest(''),cookie=`comex_session=${guest.token}`;
    const response=await handleApi(request('auth/guest',{email:'existing@example.test'},cookie),['auth','guest'],backend);
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(store.guestIdentity(guest.token)).toEqual({owner:guest.owner,email:'existing@example.test'});
  });

  test('a local email-less guest keeps its original workspace when supplying an email',async()=>{
    const guest=store.createGuest('');
    const body={title:'A comic',plot:'A courier delivers a key',style:'ink-manga',email:'local@example.test'};
    const local=new NextRequest('http://localhost:3000/api/comics',{method:'POST',headers:{'content-type':'application/json',cookie:`comex_session=${guest.token}`},body:JSON.stringify(body)});
    const response=await handleApi(local,['comics']);
    expect(response.status).toBe(201);
    expect(store.guestIdentity(guest.token)).toEqual({owner:guest.owner,email:'local@example.test'});
    expect(store.getOwned((await response.json()).comic.id,guest.owner)).not.toBeNull();
  });

  test('binding an email cannot overwrite one already bound by another request',()=>{
    const guest=store.createGuest('');
    expect(store.bindGuestEmail(guest.token,'first@example.test')).toBe(true);
    expect(store.bindGuestEmail(guest.token,'second@example.test')).toBe(false);
    expect(store.guestIdentity(guest.token)?.email).toBe('first@example.test');
  });

  test('a legacy creator can add email after the exact panel review completed',async()=>{
    const token=randomBytes(32).toString('hex'), id=randomUUID(), asset=randomUUID(), panel=randomUUID();
    store.create(id,token,{ownerId:token,storyRevision:2,pages:[{id:'page',panels:[{id:panel,assetId:asset,storyRevision:2,revision:3,status:'checking'}]}]});
    expect(store.putAdvisoryReview(id,token,`panel:${panel}:${asset}:2:3`,{outcome:'pass',findings:[]})).toBe(true);
    const result=await handleApi(request('auth/guest',{email:'owner@example.test'},`comex_session=${token}`),['auth','guest'],backend);
    expect(result.status).toBe(200);
    const owner=store.guestIdentity(token)!.owner;
    expect(store.getOwned(id,owner)).not.toBeNull();
    expect(store.getAdvisoryReview(id,`panel:${panel}:${asset}:2:3`)).toEqual({outcome:'pass',findings:[]});
  });

  test('an incomplete or stale review and an active page job still block legacy transfer',()=>{
    for (const mode of ['missing','stale','invalid','page-job'] as const) {
      const token=randomBytes(32).toString('hex'), id=randomUUID(), asset=randomUUID(), panel=randomUUID();
      store.create(id,token,{ownerId:token,storyRevision:2,pages:[{id:'page',panels:[{id:panel,assetId:asset,storyRevision:2,revision:3,status:'checking'}]}]});
      if(mode!=='missing') store.putAdvisoryReview(id,token,`panel:${panel}:${asset}:2:${mode==='stale'?2:3}`,mode==='invalid'?{outcome:'pass',findings:'invalid'}:{outcome:'pass',findings:[]});
      if(mode==='page-job') expect(store.beginPageJob(id,token,'page',randomUUID(),1)?.created).toBe(true);
      expect(()=>store.claimLegacyOwner(token,'owner@example.test')).toThrow('Wait for your existing draft generation');
      expect(store.hasLegacyOwner(token)).toBe(true);
    }
  });

  test('a completed legacy page job follows its transferred draft',()=>{
    const token=randomBytes(32).toString('hex'), id=randomUUID(), job=randomUUID();
    store.create(id,token,{ownerId:token,storyRevision:1,pages:[]});
    expect(store.beginPageJob(id,token,'page',job,1)?.created).toBe(true);
    store.finishPageJob(job,token,'completed',null);
    const claimed=store.claimLegacyOwner(token,'owner@example.test')!;
    expect(store.pageJob(id,claimed.owner,'page',job)?.state).toBe('completed');
    expect(store.pageJob(id,token,'page',job)).toBeNull();
  });

  test('concurrent email binding is idempotent for the same email and rejects another email',async()=>{
    for(const bound of ['same@example.test','other@example.test']) {
      const guest=store.createGuest(''), original=store.bindGuestEmail.bind(store);
      store.bindGuestEmail=(token,email)=>{original(token,bound);return false;};
      try {
        const result=await handleApi(request('auth/guest',{email:'same@example.test'},`comex_session=${guest.token}`),['auth','guest'],backend);
        expect(result.status).toBe(bound==='same@example.test'?200:409);
      } finally {store.bindGuestEmail=original;}
    }
  });

  test('an already bound guest cannot silently accept a different submitted email',async()=>{
    const guest=store.createGuest('first@example.test');
    const result=await handleApi(request('auth/guest',{email:'second@example.test'},`comex_session=${guest.token}`),['auth','guest'],backend);
    expect(result.status).toBe(409);
    expect(store.guestIdentity(guest.token)?.email).toBe('first@example.test');
  });

  test('a concurrent legacy claim with another email is not reported as successful',async()=>{
    const token=randomBytes(32).toString('hex'), id=randomUUID();
    store.create(id,token,{ownerId:token,pages:[]});
    const original=store.claimLegacyOwner.bind(store);
    store.claimLegacyOwner=(cookie,_email)=>original(cookie,'other@example.test');
    try {
      const result=await handleApi(request('auth/guest',{email:'same@example.test'},`comex_session=${token}`),['auth','guest'],backend);
      expect(result.status).toBe(409);
      expect(store.guestIdentity(token)?.email).toBe('other@example.test');
    } finally {store.claimLegacyOwner=original;}
  });
});
