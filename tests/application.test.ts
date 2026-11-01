import {describe, expect, test} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {LocalStore} from '../src/lib/local-store';
import {createComic} from '../src/lib/domain/comic';
import sharp from 'sharp';
import {NextRequest} from 'next/server';
import {handleApi} from '../src/lib/local-api';
import {createComicService} from '../src/lib/application/comics';

function fixture(overrides:Record<string,unknown> = {}, local = new LocalStore(':memory:')) {
  // Every repository operation returns a promise, including reads, reservations,
  // and writes. This exercises the same contract a hosted store will implement.
  const repository = new Proxy(local, {get(target, key) {
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? async (...args: unknown[]) => value.apply(target, args) : value;
  }});
  const files = new Map<string, Buffer>();
  let providerCalls = 0;
  const inputs: unknown[] = [];
  const provider = () => ({
    async questions(input: unknown) { providerCalls++; inputs.push(input); return [{id:'ignored', question:'Who gets the key?', suggestedAnswer:'Her brother'}]; },
    async characterSuggestions(input: unknown) { providerCalls++; inputs.push(input); return [{name:'Mina',role:'courier',appearance:'curly hair',outfit:'coat'}]; },
    ...overrides,
  }) as unknown as ReturnType<typeof import('../src/lib/ai/service').createAIService>;
  const service = createComicService({repository, assets: {
    async read(id: string) { const bytes = files.get(id); if (!bytes) throw new Error('missing asset'); return bytes; },
    async save(bytes: Buffer) { const id=randomUUID(); files.set(id,bytes); return id; },
    async discard(id: string) { files.delete(id); },
  }, provider, budgetFetch: async () => { throw new Error('unexpected budget fetch'); }, id: randomUUID});
  return {local, service, inputs, calls: () => providerCalls, files};
}

const alice = 'alice';
const bob = 'bob';
const creation = {title:'The courier',plot:'A courier carries a key',style:'ink-manga'};

describe('shared comic application', () => {
  test('async repository preserves guided questions, suggested answers and character suggestions for the same owner', async () => {
    const {local,service,inputs,calls} = fixture();
    try {
      const created=await service.create(alice,creation);
      const id=created.comic.id;
      expect(calls()).toBe(0);
      expect(service.listStyles().styles.map(style => style.id)).toEqual(['clear-line-adventure','ink-manga','painted-storybook']);
      expect(JSON.stringify(service.listStyles())).not.toContain('rules');
      expect((await service.list(alice)).comics.map(c => c.id)).toEqual([id]);
      expect((await service.list(bob)).comics).toEqual([]);
      await expect(service.get(bob,id)).rejects.toMatchObject({code:'not_found'});
      const initial=(await service.initialQuestions(alice,id)).comic;
      expect(initial.initialQuestions).toBe('complete');
      expect(initial.questions[0]).toMatchObject({question:'Who gets the key?',suggestedAnswer:'Her brother'});
      const q=initial.questions[0].id;
      await service.update(alice,id,{answers:{[q]:'Her brother'}});
      const suggested=(await service.suggestCharacters(alice,id,{})).comic;
      expect(suggested.characterSuggestions[0]).toMatchObject({name:'Mina',role:'courier'});
      expect(inputs[1]).toMatchObject({answers:{'Who gets the key?':'Her brother'}});
      const viewed=(await service.get(alice,id)).comic;
      expect(viewed.answers[q]).toBe('Her brother');
      expect(JSON.stringify(viewed)).not.toContain('ownerId');
      expect(viewed.revision).toBeGreaterThan(1);
      expect(viewed.storyRevision).toBe(1);
      expect(calls()).toBe(2);
    } finally { local.close(); }
  });

  test('private assets and versioned character approval are owned and stay within the shared service', async () => {
    const {local,service,files} = fixture();
    try {
      const id=(await service.create(alice,creation)).comic.id;
      const card=(await service.addCharacter(alice,id,{name:'Mina',role:'courier',appearance:'hair',outfit:'coat'})).comic.characters[0];
      const assetId=randomUUID(); const bytes=Buffer.from('private image'); files.set(assetId,bytes);
      const saved=local.getOwned<any>(id,alice)!;
      local.update(id,alice,saved.revision,{...saved.data,characters:[{...saved.data.characters[0],referenceAssetId:assetId,referenceUrl:`/api/comics/${id}/assets/${assetId}`} ]});
      await expect(service.getAsset(bob,id,assetId)).rejects.toMatchObject({code:'not_found'});
      expect(await service.getAsset(alice,id,assetId)).toEqual(bytes);
      await expect(service.approveCharacter(alice,id,card.id,{assetId:randomUUID()})).rejects.toMatchObject({code:'conflict'});
      expect((await service.approveCharacter(alice,id,card.id,{assetId})).comic.characters[0].approved).toBe(true);
      const changed=(await service.editCharacter(alice,id,card.id,{name:'Mina',role:'courier',appearance:'new hair',outfit:'coat'})).comic.characters[0];
      expect(changed.approved).toBe(false);
      expect(changed.referenceVersion).toBeNull();
    } finally { local.close(); }
  });

  test('invalid inputs are rejected before storage or provider work', async () => {
    const {local,service,calls} = fixture();
    try {
      await expect(service.create(alice,{...creation,title:''})).rejects.toMatchObject({code:'invalid_input'});
      expect((await service.list(alice)).comics).toEqual([]);
      expect(calls()).toBe(0);
    } finally { local.close(); }
  });

  test('async workflow preserves panel review, edition snapshots and revision impact', async () => {
    const png=await sharp({create:{width:8,height:8,channels:4,background:'#fff'}}).png().toBuffer();
    const state={location:'town',time:'day',props:[],outfits:[],injuries:[],knowledge:[]};
    const spec=(id:string,index:number,action:string) => ({id,index,character_ids:['mina'],action,framing:'wide',dialogue:[{speaker_id:'mina',text:'The key'}],state_before:state,state_after:state});
    const panels=[spec('p1',1,'Find the key'),spec('p2',2,'Give the key'),spec('p3',1,'Open the door')];
    const bible={premise:'Delivery',setting:'Town',rules:[],character_ids:['mina']};
    const storyboard={bible,pages:[{index:1,panels:panels.slice(0,2)},{index:2,panels:panels.slice(2)}]};
    let imageCalls=0, reviewCalls=0;
    const finding={severity:'blocker',dimension:'continuity',panel_id:'p1',character_id:null,reference_id:null,expected:'key',observed:'missing key',correction:'add key'};
    const overrides={
      async panel() {imageCalls++; return png;},
      async editPanel() {imageCalls++; return png;},
      async visualJudge() {reviewCalls++; return reviewCalls===1 ? {outcome:'findings',findings:[finding]} : {outcome:'inconclusive',findings:[]};},
      async classifyEdit() {return {intent:'artwork',reason:'Change the colours'};},
      async revision() {return {earliest_affected_panel_id:'p2',explanation:'Mina keeps the key',revised_bible:bible,revised_suffix:[{...panels[1],action:'Keep the key'},{...panels[2],action:'Use the key'}]};},
      async narrativeJudge() {return {outcome:'findings',findings:[finding]};},
    };
    const {local,service,files}=fixture(overrides);
    try {
      const id=(await service.create(alice,creation)).comic.id;
      const reference=randomUUID(); files.set(reference,png);
      const record=local.getOwned<any>(id,alice)!;
      const comic=createComic({id,ownerId:alice,title:creation.title,creatorName:'',plot:creation.plot,styleId:creation.style,
        pages:[{id:'page1',panels:panels.slice(0,2).map(p=>({id:p.id,beat:p.action}))},{id:'page2',panels:[{id:'p3',beat:panels[2].action}]}]});
      local.update(id,alice,record.revision,{...record.data,...comic,storyboard,characters:[{id:'mina',name:'Mina',role:'courier',appearance:'hair',outfit:'coat',approved:true,referenceAssetId:reference}]});

      const paused=await service.generatePage(alice,id,'page1');
      expect('notice' in paused && paused.notice).toContain('paused');
      expect(imageCalls).toBe(1);
      const flagged=paused.comic.pages[0].panels[0];
      expect(flagged.evaluation).toBe('blocker');
      expect(flagged.findings).toHaveLength(1);
      await service.acceptPanel(alice,id,'p1',flagged.reviewVersion);
      const resumed=await service.generatePage(alice,id,'page1');
      expect(imageCalls).toBe(2);
      await service.acceptPanel(alice,id,'p2',resumed.comic.pages[0].panels[1].reviewVersion);
      const last=await service.generatePage(alice,id,'page2');
      await service.acceptPanel(alice,id,'p3',last.comic.pages[1].panels[0].reviewVersion);
      const ready=(await service.get(alice,id)).comic;
      expect(ready.storyboard?.pages[0].panels[0].dialogue[0].text).toBe('The key');
      expect((await service.downloadPage(alice,id,'page1')).subarray(0,8)).toEqual(png.subarray(0,8));
      await service.publish(alice,id,{title:'Public story',creator:'Mina'});
      const edition=(await service.getPublished(id)).comic;
      const url=new URL(edition.pages[0].imageUrl,'http://localhost');
      const publicBytes=await service.getPublishedAsset(id,url.pathname.split('/').pop()!,url.searchParams.get('edition'));
      await service.update(alice,id,{title:'Private revision'});
      expect((await service.getPublished(id)).comic).toEqual(edition);
      expect(await service.getPublishedAsset(id,url.pathname.split('/').pop()!,url.searchParams.get('edition'))).toEqual(publicBytes);

      const beforeEdit=(await service.get(alice,id)).comic;
      const originalFirst=beforeEdit.pages[0].panels[0];
      const edit=await service.editPanel(alice,id,'p2',{instruction:'Make the sky blue',...beforeEdit.pages[0].panels[1].reviewVersion});
      if (!edit.comic) throw new Error('expected artwork result');
      expect(edit.comic.pages[0].panels[0]).toEqual(originalFirst);
      expect(edit.comic.pages[0].panels[1].reviewVersion?.assetId).not.toBe(beforeEdit.pages[0].panels[1].reviewVersion?.assetId);
      const proposal=await service.previewRevision(alice,id,{panelId:'p2',instruction:'Mina keeps the key'});
      expect(proposal.proposal).toMatchObject({earliestPanelId:'p2',affectedPage:1,affectedPanel:2});
      const applied=await service.applyRevision(alice,id,{proposalId:proposal.proposal.id});
      expect(applied.comic.storyRevision).toBe(2);
      expect(applied.comic.pages[0].panels[0].reviewVersion?.assetId).toBe(originalFirst.reviewVersion?.assetId);
      expect(applied.comic.pages[0].panels[1].status).toBe('outdated');
      expect(applied.comic.pages[1].status).toBe('outdated');
      expect(applied.comic.storyReview?.accepted).toBe(false);
      const fingerprint=applied.comic.storyReview?.fingerprint;
      expect(fingerprint).toBeTruthy();
      expect((await service.acceptStoryReview(alice,id,{fingerprint})).comic.storyReview?.accepted).toBe(true);
      expect((await service.getPublished(id)).comic).toEqual(edition);
      await service.withdraw(alice,id,{});
      await expect(service.getPublished(id)).rejects.toMatchObject({code:'not_found'});
      await expect(service.getPublishedAsset(id,url.pathname.split('/').pop()!,url.searchParams.get('edition'))).rejects.toMatchObject({code:'not_found'});
    } finally { local.close(); }
  });


  test('browser and direct service continue the same guest draft and questions', async () => {
    const local=new LocalStore(':memory:');
    const globals=globalThis as typeof globalThis & {__comexLocalStore?:LocalStore};
    const previous=globals.__comexLocalStore;
    globals.__comexLocalStore=local;
    try {
      const guest=local.createGuest('creator@example.test');
      const cookie=`comex_session=${guest.token}`;
      const createRequest=new NextRequest('http://localhost:3000/api/comics',{
        method:'POST',headers:{host:'localhost:3000',cookie,'content-type':'application/json'},body:JSON.stringify(creation),
      });
      const response=await handleApi(createRequest,['comics']);
      expect(response.status).toBe(201);
      const id=(await response.json()).comic.id;
      const {service}=fixture({},local);
      const question=(await service.initialQuestions(guest.owner,id)).comic.questions[0];
      await service.update(guest.owner,id,{answers:{[question.id]:'A friend'}});
      const getRequest=new NextRequest(`http://localhost:3000/api/comics/${id}`,{headers:{host:'localhost:3000',cookie}});
      const browser=(await (await handleApi(getRequest,['comics',id])).json()).comic;
      expect(browser.questions[0]).toMatchObject({id:question.id,question:'Who gets the key?',suggestedAnswer:'Her brother'});
      expect(browser.answers[question.id]).toBe('A friend');
      await expect(service.get(bob,id)).rejects.toMatchObject({code:'not_found'});
    } finally {
      globals.__comexLocalStore=previous;
      local.close();
    }
  });


  test('browser mutations reject a draft changed while the request body is arriving', async () => {
    const local=new LocalStore(':memory:');
    const globals=globalThis as typeof globalThis & {__comexLocalStore?:LocalStore};
    const previous=globals.__comexLocalStore;
    globals.__comexLocalStore=local;
    try {
      const guest=local.createGuest('creator@example.test');
      const {service}=fixture({},local);
      const id=(await service.create(guest.owner,creation)).comic.id;
      const headers={host:'localhost:3000',cookie:`comex_session=${guest.token}`,'content-type':'application/json'};
      let release!:()=>void, started!:()=>void;
      const gate=new Promise<void>(resolve=>release=resolve), reading=new Promise<void>(resolve=>started=resolve);
      const slow=new NextRequest(`http://localhost:3000/api/comics/${id}`,{method:'PATCH',headers,body:JSON.stringify({title:'Old edit'})});
      Object.defineProperty(slow,'text',{value:async () => {started(); await gate; return JSON.stringify({title:'Old edit'});}});
      const pending=handleApi(slow,['comics',id]);
      await reading;
      const fast=new NextRequest(`http://localhost:3000/api/comics/${id}`,{method:'PATCH',headers,body:JSON.stringify({title:'New edit'})});
      expect((await handleApi(fast,['comics',id])).status).toBe(200);
      release();
      expect((await pending).status).toBe(409);
      expect((await service.get(guest.owner,id)).comic.title).toBe('New edit');
    } finally {
      globals.__comexLocalStore=previous;
      local.close();
    }
  });

});
