import { describe, expect, test } from 'bun:test';
import { createComic, commitPanelRender, isPanelReady, publishComic, setPageComposition } from '../src/lib/domain/comic';

describe('advisory reviews', () => {
  test('a completed image is usable while review is pending or flagged, without inventing acceptance', () => {
    for (const evaluation of ['warning', 'uncertain', 'blocker'] as const) {
      let draft = createComic({id:'comic',ownerId:'owner',title:'Story',creatorName:'',plot:'Plot',styleId:'ink-manga',pages:[{id:'page',panels:[{id:'panel',beat:'A story beat'}]}]});
      draft = commitPanelRender(draft,'owner','panel',{storyRevision:1,panelRevision:1},'image',evaluation);
      const panel = draft.pages[0].panels[0];
      expect(panel.acceptance).toBeNull();
      expect(isPanelReady(panel)).toBe(true);
      expect(isPanelReady({...panel,status:'checking'})).toBe(true);
      draft = setPageComposition(draft,'owner','page','composite',['image']);
      expect(publishComic(draft,'owner',1,'edition').published?.id).toBe('edition');
      expect(isPanelReady({...panel,assetId:null})).toBe(false);
      expect(isPanelReady({...panel,status:'outdated'})).toBe(false);
      expect(isPanelReady({...panel,status:'planned'})).toBe(false);
    }
  });
});
