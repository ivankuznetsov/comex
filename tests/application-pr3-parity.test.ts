import {expect,test} from 'bun:test';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {LocalStore} from '../src/lib/local-store';
import {createComic} from '../src/lib/domain/comic';
import {createComicService} from '../src/lib/application/comics';
import {revisionPreview} from '../src/lib/application/views';
import type {Draft} from '../src/lib/application/contracts';

const owner='owner',state={location:'town',time:'day',props:[],outfits:[],injuries:[],knowledge:[]};
const spec=(id:string,index:number)=>({id,index,character_ids:['used'],action:`Action ${id}`,framing:'wide',dialogue:[],state_before:state,state_after:state});
const storyboard={bible:{premise:'Delivery',setting:'Town',rules:[],character_ids:['used']},pages:[{index:1,panels:[spec('p1',1)]},{index:2,panels:[spec('p2',1)]}]};
async function fixture(){
  const store=new LocalStore(':memory:'),files=new Map<string,Buffer>(),png=await sharp({create:{width:8,height:8,channels:4,background:'#fff'}}).png().toBuffer();
  const service=createComicService({repository:store,assets:{async read(id){const value=files.get(id);if(!value)throw new Error('missing');return value;},async save(bytes){const id=randomUUID();files.set(id,bytes);return id;},async discard(id){files.delete(id);}},provider:()=>({async characterReference(){return png;},async panel(){return png;},async visualJudge(){return {outcome:'pass',findings:[]};}}) as any,budgetFetch:async()=>{throw new Error('unexpected network');},id:randomUUID});
  const id=(await service.create(owner,{title:'Courier',plot:'A key',style:'ink-manga'})).comic.id,ref=randomUUID(),image=randomUUID();files.set(ref,png);files.set(image,png);
  const row=store.getOwned<Draft>(id,owner)!;
  const comic=createComic({id,ownerId:owner,title:'Courier',creatorName:'',plot:'A key',styleId:'ink-manga',pages:[{id:'page1',panels:[{id:'p1',beat:'Action p1'}]},{id:'page2',panels:[{id:'p2',beat:'Action p2'}]}]});
  comic.pages[0].panels[0]={...comic.pages[0].panels[0],assetId:image,revision:2,status:'needs_review',evaluation:'blocker'};
  store.update(id,owner,row.revision,{...row.data,...comic,storyboard,characters:[{id:'used',name:'Mina',role:'courier',appearance:'hair',outfit:'coat',approved:true,referenceAssetId:ref,referenceUrl:'/ref'}],panelReviews:{p1:{assetId:image,storyRevision:1,panelRevision:2,outcome:'findings'}},panelFindings:{p1:[{severity:'blocker'}]}});
  const view=(await service.get(owner,id)).comic;await service.approveStory(owner,id,{revision:view.revision,storyRevision:view.storyRevision,fingerprint:view.storyApproval!.fingerprint});
  return {store,service,id,image,png,files};
}
test('review findings remain visible without gating the next page',async()=>{
  const f=await fixture();try{
    const view=(await f.service.get(owner,f.id)).comic,panel=view.pages[0].panels[0];
    expect(panel.ready).toBe(true);expect(panel.reviewed).toBe(true);expect(panel.accepted).toBe(false);expect(view.nextActions).toContain('accept_panel');expect(view.nextSteps.some(step=>step.action==='generate_page'&&step.pageId==='page2')).toBe(true);
    const next=(await f.service.generatePage(owner,f.id,'page2')).comic.pages[1].panels[0];expect(next.reviewOutcome).toBe('pass');expect(next.reviewed).toBe(true);expect(next.accepted).toBe(false);
    const accepted=(await f.service.acceptPanel(owner,f.id,'p1',panel.reviewVersion!)).comic;expect(accepted.pages[0].panels[0].accepted).toBe(true);
  }finally{f.store.close();}
});
test('characters unused by the story remain editable and story approval stays valid',async()=>{
  const f=await fixture();try{
    const added=(await f.service.addCharacter(owner,f.id,{name:'Tao',role:'bystander',appearance:'hair',outfit:'jacket'})).comic;
    expect(added.storyApproval?.approved).toBe(true);expect(added.characters.find(c=>c.id==='used')?.lockedByStory).toBe(true);
    const extra=added.characters.find(c=>c.name==='Tao')!;expect(extra.lockedByStory).toBe(false);
    await expect(f.service.editCharacter(owner,f.id,'used',{name:'Mina',role:'courier',appearance:'hair',outfit:'jacket'})).rejects.toMatchObject({code:'conflict'});
    const changed=(await f.service.editCharacter(owner,f.id,extra.id,{name:'Tao',role:'bystander',appearance:'hair',outfit:'hat'})).comic;expect(changed.storyApproval?.approved).toBe(true);
    expect((await f.service.generateReference(owner,f.id,extra.id)).comic.characters.find(c=>c.id===extra.id)?.referenceVersion).toBeTruthy();
  }finally{f.store.close();}
});
test('revision preview preserves the instruction and labels affected panels',async()=>{
  const f=await fixture();try{
    const row=f.store.getOwned<Draft>(f.id,owner)!,result={earliest_affected_panel_id:'p2',explanation:'Update p2',revised_bible:storyboard.bible,revised_suffix:[{...spec('p2',1),action:'Keep the key'}]};
    const preview=revisionPreview({...row.data,pendingRevision:{id:'proposal',baseRevision:row.revision,result,instruction:'Keep the key'}},row.revision)!;
    expect(preview.instruction).toBe('Keep the key');expect(preview.explanation).toBe('Update page 2, panel 1');expect(preview.panels[0]).toMatchObject({id:'p2',page:2,panel:1,previousAction:'Action p2',action:'Keep the key'});
  }finally{f.store.close();}
});
test('publication permits unaccepted advisory findings and snapshots a separate cover asset',async()=>{
  const f=await fixture();try{
    const row=f.store.getOwned<Draft>(f.id,owner)!,image2=randomUUID();f.files.set(image2,f.png);f.store.update(f.id,owner,row.revision,{...row.data,pages:row.data.pages.map((page,index)=>index?{...page,panels:page.panels.map(panel=>({...panel,assetId:image2,revision:2,status:'checking' as const,evaluation:'uncertain' as const}))}:page)});
    const draft=(await f.service.get(owner,f.id)).comic,panel=draft.pages[0].panels[0];expect(panel.accepted).toBe(false);expect(draft.pages[1].panels[0].reviewed).toBe(false);
    await f.service.publish(owner,f.id,{title:'Public',creator:'Mina'});
    const listing=await f.service.listPublished(),coverUrl=listing.comics[0].coverUrl!;const cover=new URL(coverUrl,'http://localhost');
    expect(coverUrl).not.toBe((await f.service.getPublished(f.id)).comic.pages[0].imageUrl);
    expect(await f.service.getPublishedAsset(f.id,cover.pathname.split('/').pop()!,cover.searchParams.get('edition'))).toEqual(f.png);
  }finally{f.store.close();}
});
