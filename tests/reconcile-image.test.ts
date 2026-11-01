import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStore } from '../src/lib/local-store';
import { resolveImageOperation } from '../scripts/resolve-image-operation';

test('operator releases only an explicitly selected stuck image operation', async () => {
  const dir=await mkdtemp(join(tmpdir(),'comex-recovery-')); const path=join(dir,'drafts.sqlite');
  const store=new LocalStore(path);
  try {
    store.create('comic','owner',{operations:{'panel:p1':'unknown_outcome','panel:p2':'running','character:c1':'unknown_outcome'}});
    expect(() => resolveImageOperation(path,'comic','panel:missing')).toThrow('No matching');
    resolveImageOperation(path,'comic','panel:p1');
    const draft=store.getOwned<{operations:Record<string,string>}>('comic','owner')!;
    expect(draft.data.operations).toEqual({'panel:p2':'running','character:c1':'unknown_outcome'});
    expect(draft.revision).toBe(2);
    expect(() => resolveImageOperation(path,'comic','panel:p1')).toThrow('No matching');
    expect(() => resolveImageOperation(path,'comic','../other')).toThrow('exact');
  } finally {store.close();await rm(dir,{recursive:true,force:true});}
});
