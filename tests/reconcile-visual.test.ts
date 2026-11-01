import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStore } from '../src/lib/local-store';
import { createComic, commitPanelRender, acceptPanel, isPanelReady } from '../src/lib/domain/comic';
import { resolveVisualReview } from '../scripts/resolve-visual-review';

test('operator can recover only a stalled review without approving or replacing the image', async () => {
  const dir=await mkdtemp(join(tmpdir(),'comex-review-recovery-')); const path=join(dir,'drafts.sqlite');
  const store=new LocalStore(path);
  try {
    const asset='11111111-1111-4111-8111-111111111111';
    const base=createComic({id:'comic',ownerId:'owner',title:'Story',plot:'Plot',styleId:'ink-manga',creatorName:'',pages:[{id:'page',panels:[{id:'p1',beat:'Wait'},{id:'p2',beat:'Go'}]}]});
    const rendered=commitPanelRender(base,'owner','p1',{storyRevision:1,panelRevision:1},asset,'uncertain');
    const first=rendered.pages[0].panels[0]; first.status='checking';
    store.create('comic','owner',{...rendered,panelFindings:{p1:[{observed:'old'}]},panelReviews:{p1:{assetId:'old',storyRevision:1,panelRevision:1,outcome:'pass'}}});
    expect(() => resolveVisualReview(path,'comic','p2')).toThrow('not awaiting review');
    resolveVisualReview(path,'comic','p1');
    const recovered=store.getOwned<typeof rendered & {panelFindings:Record<string,unknown[]>;panelReviews:Record<string,unknown>}>('comic','owner')!;
    const panel=recovered.data.pages[0].panels[0];
    expect(panel.assetId).toBe(asset); expect(panel.status).toBe('needs_review'); expect(panel.evaluation).toBe('uncertain');
    expect(panel.acceptance).toBeNull(); expect(isPanelReady(panel)).toBe(true);
    expect(recovered.data.panelFindings.p1).toEqual([]);
    expect(recovered.data.panelReviews.p1).toEqual({assetId:asset,storyRevision:1,panelRevision:2,outcome:'failed'});
    expect(isPanelReady(acceptPanel(recovered.data,'owner','p1',asset,1).pages[0].panels[0])).toBe(true);
    expect(() => resolveVisualReview(path,'comic','p1')).toThrow('not awaiting review');
    expect(recovered.revision).toBe(2);
  } finally {store.close();await rm(dir,{recursive:true,force:true});}
});
