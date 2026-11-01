import {describe,expect,test} from 'bun:test';
import {createBlankComic,createComic} from '../src/lib/domain/comic';
import type {Draft} from '../src/lib/application/contracts';
import {estimateComicCost,squareImageOutputTokens} from '../src/lib/cost-estimate';
import {view} from '../src/lib/application/views';

const models={text:'gpt-6.1-terra',image:'gpt-image-2.5-flare'};
function draft():Draft {
  return {...createBlankComic('cost','owner'),title:'Story',plot:'A trip',styleId:'ink-manga',characters:[],questions:[],answers:{},pageCount:3,panelsPerPage:3};
}
describe('comic cost planning',()=>{
  test('uses official 2.5 output token calculator and direct API rates',()=>{
    expect(squareImageOutputTokens('medium')).toBe(439);
    expect(squareImageOutputTokens('max')).toBe(7024);
    const d=draft();d.pageCount=1;d.panelsPerPage=1;
    const e=estimateComicCost(d,models);
    expect(e.breakdown[0].cost!.low).toBeCloseTo((500*5+439*30)/1e6,10);
    expect(e.breakdown[0].cost!.high).toBeCloseTo((2000*5+7024*30)/1e6,10);
    expect(e.remaining).toEqual(e.total);
  });
  test('page count, panel density and cast increase the prospective budget',()=>{
    const d=draft(),base=estimateComicCost(d,models);
    d.pageCount=5;const longer=estimateComicCost(d,models);
    expect(longer.panels).toBe(15);expect(longer.total!.low).toBeGreaterThan(base.total!.low);
    d.panelsPerPage=4;expect(estimateComicCost(d,models).panels).toBe(20);
    d.characters.push({id:'a',name:'A',role:'hero',appearance:'blue',outfit:'coat',approved:false});
    const cast=estimateComicCost(d,models);expect(cast.remainingReferences).toBe(1);
    expect(cast.total!.high).toBeGreaterThan(longer.total!.high);
    d.characters[0].referenceAssetId='uploaded';
    expect(estimateComicCost(d,models).remainingReferences).toBe(0);
    expect(estimateComicCost(d,models).remaining!.high).toBeLessThan(cast.remaining!.high);
  });
  test('existing artwork is reused; stale panels are counted, advisory findings do not force redraws',()=>{
    const d=draft();const comic=createComic({id:'cost',ownerId:'owner',title:'Story',creatorName:'',plot:'A trip',styleId:'ink-manga',pages:[{id:'page',panels:[{id:'p1',beat:'First'},{id:'p2',beat:'Second'}]}]});
    d.pages=comic.pages;d.storyRevision=comic.storyRevision;d.initialQuestions='complete';d.initialSuggestions='complete';
    const state={location:'town',time:'day',props:[],outfits:[],injuries:[],knowledge:[]};
    d.storyboard={bible:{premise:'Trip',setting:'Town',rules:[],character_ids:[]},pages:[{index:1,panels:d.pages[0].panels.map((p,i)=>({id:p.id,index:i+1,character_ids:[],action:p.beat,framing:'wide',dialogue:[],state_before:state,state_after:state}))}]};
    d.pages[0].panels.forEach(p=>{p.assetId='art-'+p.id;p.status='needs_review';p.storyRevision=d.storyRevision;});
    const before=JSON.stringify(d),done=estimateComicCost(d,models);
    expect(done.panels).toBe(2);expect(done.remainingPanels).toBe(0);expect(done.remaining).toEqual({low:0,high:0});
    expect(JSON.stringify(d)).toBe(before);
    d.pages[0].panels[1].status='outdated';
    const stale=estimateComicCost(d,models);expect(stale.remainingPanels).toBe(1);expect(stale.remaining!.high).toBeGreaterThan(0);
    expect(stale.remaining!.high).toBeLessThan(stale.total!.high);
  });
  test('unknown configured model never produces a misleading zero-dollar quote',()=>{
    const e=estimateComicCost(draft(),{...models,image:'custom-image'});
    expect(e.available).toBe(false);expect(e.total).toBeNull();expect(e.remaining).toBeNull();
    expect(e.models.image).toBe('custom-image');
    expect(estimateComicCost(draft(),{...models,image:'constructor'}).total).toBeNull();
  });
  test('shared API/MCP projection includes a read-only estimate',()=>{
    const d=draft(),before=JSON.stringify(d);const e=view(d,null,1).costEstimate;
    expect(e.panels).toBe(9);expect(e.currency).toBe('USD');expect(JSON.stringify(d)).toBe(before);
  });
});
