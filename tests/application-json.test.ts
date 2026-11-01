import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {canonicalJson,sameJson} from '../src/lib/application/json';
import {isNarrativeAccepted,narrativeFingerprint,storyFingerprint} from '../src/lib/application/views';
import type {Draft} from '../src/lib/application/contracts';

test('approval fingerprints and comparisons survive JSON object key reordering',()=>{
  const draft={storyRevision:1,plot:'A courier',styleId:'ink-manga',answers:{b:'two',a:'one'},characters:[{id:'mina',name:'Mina',role:'courier',appearance:'hair',outfit:'coat',approved:true,referenceAssetId:'asset'}],pages:[{id:'page',panels:[]}],storyboard:{bible:{premise:'A',setting:'B',rules:[],character_ids:['mina']},pages:[]},storyReview:{outcome:'findings',findings:[{severity:'blocker',dimension:'continuity'}]}} as unknown as Draft;
  const reorder=(value:unknown):unknown=>Array.isArray(value)?value.map(reorder):value && typeof value==='object'?Object.fromEntries(Object.entries(value).reverse().map(([key,item])=>[key,reorder(item)])):value;
  const reordered=reorder(draft) as Draft;
  expect(sameJson(draft,reordered)).toBe(true);
  expect(canonicalJson(draft)).toBe(canonicalJson(reordered));
  expect(storyFingerprint(draft)).toBe(storyFingerprint(reordered));
  expect(narrativeFingerprint(draft)).toBe(narrativeFingerprint(reordered));
  const legacy=createHash('sha256').update(JSON.stringify({revision:draft.storyRevision,storyboard:draft.storyboard,review:draft.storyReview})).digest('hex');
  expect(isNarrativeAccepted({...draft,storyReviewAcceptance:legacy})).toBe(true);
  expect(isNarrativeAccepted({...draft,storyReviewAcceptance:'invalid'})).toBe(false);
});
