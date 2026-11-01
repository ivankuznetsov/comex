import {test,expect} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LocalStore} from '@/src/lib/local-store';
import {resolveTextOperation} from '@/scripts/resolve-text-operation';

test('operator recovery preserves a draft and makes interrupted questions explicitly retryable', async () => {
  const dir=await mkdtemp(join(tmpdir(),'comex-text-recovery-'));const path=join(dir,'db.sqlite');
  try {
    const store=new LocalStore(path);store.create('comic','owner',{title:'Kept',initialQuestions:'running'});
    expect(store.reserveTextOperation('comic','owner',1)).toBe(true);store.close();
    resolveTextOperation(path,'comic');
    const reopened=new LocalStore(path);const record=reopened.getOwned<{title:string;initialQuestions:string}>('comic','owner')!;
    expect(record.data).toEqual({title:'Kept',initialQuestions:'failed'});expect(record.revision).toBe(2);
    expect(reopened.reserveTextOperation('comic','owner',2)).toBe(true);reopened.close();
    expect(()=>resolveTextOperation(path,'missing')).toThrow();
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('recovering a text operation preserves publication freshness', async () => {
  const dir=await mkdtemp(join(tmpdir(),'comex-text-publication-'));const path=join(dir,'db.sqlite');
  try {
    const store=new LocalStore(path);store.create('comic','owner',{title:'Kept',initialQuestions:'unknown'});
    expect(store.publish('comic','owner',1,{sourceRevision:2,pages:[]})).toBe(true);
    expect(store.reserveTextOperation('comic','owner',2)).toBe(true);store.close();
    resolveTextOperation(path,'comic');
    const reopened=new LocalStore(path);expect(reopened.getOwned('comic','owner')?.revision).toBe(3);
    expect(reopened.getPublished<{sourceRevision:number}>('comic')?.sourceRevision).toBe(3);reopened.close();
  } finally {await rm(dir,{recursive:true,force:true});}
});
