import { describe, expect, test } from 'bun:test';
import { LocalStore } from '../src/lib/local-store';

describe('local draft storage', () => {
  test('persists private drafts and enforces owner and revision checks', () => {
    const store = new LocalStore(':memory:');
    store.create('comic-1', 'owner-a', { title: 'First' });
    expect(store.getOwned('comic-1', 'owner-b')).toBeNull();
    expect(store.getOwned('comic-1', 'owner-a')?.data).toEqual({ title: 'First' });
    expect(store.update('comic-1', 'owner-a', 1, { title: 'Second' })).toBe(true);
    expect(store.update('comic-1', 'owner-a', 1, { title: 'Stale' })).toBe(false);
    expect(store.update('comic-1', 'owner-b', 2, { title: 'Stolen' })).toBe(false);
    expect(store.getOwned('comic-1', 'owner-a')?.data).toEqual({ title: 'Second' });
    store.close();
  });
  test('reference attachment cannot race an active page job', () => {
    const store=new LocalStore(':memory:');
    store.create('comic','owner',{title:'Draft'});
    expect(store.beginPageJob('comic','owner','page','job',1)?.created).toBe(true);
    expect(store.updateWithoutActivePageJob('comic','owner',1,{title:'Uploaded'})).toBe(false);
    expect(store.getOwned('comic','owner')?.data).toEqual({title:'Draft'});
    store.finishPageJob('job','owner','completed',null);
    expect(store.updateWithoutActivePageJob('comic','owner',1,{title:'Uploaded'})).toBe(true);
    store.close();
  });
  test('public reader sees only an explicit published snapshot', () => {
    const store = new LocalStore(':memory:');
    store.create('comic-1', 'owner-a', { title: 'Private' });
    expect(store.listPublished()).toEqual([]);
    expect(store.publish('comic-1', 'owner-b', 1, {title: 'Leaked'})).toBe(false);
    expect(store.publish('comic-1', 'owner-a', 1, {title: 'Public'})).toBe(true);
    expect(store.update('comic-1', 'owner-a', 2, {title: 'Unpublished edit'})).toBe(true);
    expect(store.getPublished('comic-1')).toEqual({title: 'Public'});
    expect(store.publish('comic-1', 'owner-a', 1, {title: 'Stale'})).toBe(false);
    expect(store.withdraw('comic-1', 'owner-a')).toBe(true);
    expect(store.getPublished('comic-1')).toBeNull();
    expect(store.listPublished()).toEqual([]);
    store.close();
  });
});

test('publication swaps assets atomically and rejects another publication from the same revision', () => {
  const store = new LocalStore(':memory:');
  store.create('c', 'owner', {title:'draft'});
  const a = new Uint8Array([1,2,3]), b = new Uint8Array([4,5,6]);
  expect(store.publish('c','owner',1,{title:'first'},[{id:'a',data:a}])).toBe(true);
  expect(store.publish('c','owner',1,{title:'stale'},[{id:'b',data:b}])).toBe(false);
  expect(store.getPublished('c')).toEqual({title:'first'});
  expect(store.getPublicationAsset('c','a')).toEqual(a);
  expect(store.getPublicationAsset('c','b')).toBeNull();
  expect(() => store.publish('c','owner',2,{title:'broken'},[{id:'b',data:b},{id:'b',data:b}])).toThrow();
  expect(store.getOwned('c','owner')!.revision).toBe(2);
  expect(store.getPublished('c')).toEqual({title:'first'});
  expect(store.getPublicationAsset('c','a')).toEqual(a);
  expect(store.publish('c','owner',2,{title:'second'},[{id:'b',data:b}])).toBe(true);
  expect(store.getPublicationAsset('c','a')).toBeNull();
  expect(store.getPublicationAsset('c','b')).toEqual(b);
  expect(store.withdraw('c','owner')).toBe(true);
  expect(store.getPublicationAsset('c','b')).toBeNull();
  store.close();
});

test('withdrawal prevents an in-flight publication from restoring an edition', () => {
  const store = new LocalStore(':memory:');
  store.create('c', 'owner', {title:'draft'});
  expect(store.publish('c', 'owner', 1, {title:'public'})).toBe(true);
  const stale = store.getOwned('c', 'owner')!.revision;
  expect(store.withdraw('c', 'owner')).toBe(true);
  expect(store.publish('c', 'owner', stale, {title:'stale'})).toBe(false);
  expect(store.getPublished('c')).toBeNull();
  store.close();
});

test('story reservation survives reopening and checks owner and draft revision', async () => {
  const {mkdtemp,rm}=await import('node:fs/promises'); const {tmpdir}=await import('node:os'); const {join}=await import('node:path');
  const dir=await mkdtemp(join(tmpdir(),'comex-story-lock-')); const path=join(dir,'db.sqlite');
  try {
    const first=new LocalStore(path); const second=new LocalStore(path);
    first.create('c','owner',{title:'Draft'});
    expect(first.reserveTextOperation('c','other',1)).toBe(false);
    expect(first.reserveTextOperation('c','owner',2)).toBe(false);
    expect(first.reserveTextOperation('c','owner',1)).toBe(true);
    expect(second.reserveTextOperation('c','owner',1)).toBe(false);
    first.close();
    expect(second.reserveTextOperation('c','owner',1)).toBe(false);
    second.finishTextOperation('c','owner',true);
    second.finishTextOperation('c','owner',false);
    expect(second.reserveTextOperation('c','owner',1)).toBe(false);
    second.close();
  } finally {await rm(dir,{recursive:true,force:true});}
});
