import { describe, expect, test } from 'bun:test';
import { createBlankComic, createComic, commitPanelRender, reviseStory, setPageComposition, publishComic, withdrawComic, acceptPanel, getPublicEdition, type ComicDraft } from '../src/lib/domain/comic';

function fixture(): ComicDraft {
  let comic = createComic({ id: 'comic', ownerId: 'alice', title: 'The courier', creatorName: 'Mina', plot: 'Deliver a key', styleId: 'ink', pages: [
    { id: 'page-1', panels: [{ id: 'p1', beat: 'Find key' }, { id: 'p2', beat: 'Give key' }] },
    { id: 'page-2', panels: [{ id: 'p3', beat: 'Open door' }] },
  ] });
  for (const [panelId, assetId] of [['p1', 'a1'], ['p2', 'a2'], ['p3', 'a3']]) {
    comic = commitPanelRender(comic, 'alice', panelId, { storyRevision: 1, panelRevision: 1 }, assetId, 'pass');
  }
  comic = setPageComposition(comic, 'alice', 'page-1', 'page1-image', ['a1', 'a2']);
  return setPageComposition(comic, 'alice', 'page-2', 'page2-image', ['a3']);
}

describe('comic domain', () => {
  test('a blank draft is private and cannot be published', () => {
    const blank = createBlankComic('new', 'alice');
    expect(blank.pages).toEqual([]);
    expect(getPublicEdition(blank)).toBeNull();
    expect(() => publishComic(blank, 'alice', 1, 'edition')).toThrow('incomplete');
  });
  test('artwork replacement affects one panel and invalidates only its composed page', () => {
    const before = fixture();
    const after = commitPanelRender(before, 'alice', 'p2', { storyRevision: 1, panelRevision: 2 }, 'a2-new', 'pass');
    expect(after.pages[0].panels.map(p => p.assetId)).toEqual(['a1', 'a2-new']);
    expect(after.pages[1]).toEqual(before.pages[1]);
    expect(after.pages[0].composition).toBeNull();
    expect(before.pages[0].composition?.assetId).toBe('page1-image');
  });
  test('story revision preserves prefix and invalidates remaining same-page panels and later pages', () => {
    const before = fixture();
    const after = reviseStory(before, 'alice', 1, 'p2', { p2: 'Keep key', p3: 'Mina opens door' });
    expect(after.storyRevision).toBe(2);
    expect(after.pages[0].panels[0].assetId).toBe('a1');
    expect(after.pages[0].panels[0].status).toBe('current');
    expect(after.pages[0].panels[1].status).toBe('outdated');
    expect(after.pages[1].panels[0].status).toBe('outdated');
    expect(after.pages[1].panels[0].assetId).toBe('a3');
    expect(() => commitPanelRender(after, 'alice', 'p2', { storyRevision: 1, panelRevision: 1 }, 'late', 'pass')).toThrow('stale');
    expect(before.pages[0].panels[1].beat).toBe('Give key');
  });
  test('published edition is a snapshot and draft edits stay private until republishing', () => {
    const initial = publishComic(fixture(), 'alice', 1, 'edition-1');
    const edited = reviseStory(initial, 'alice', 1, 'p3', { p3: 'Mina opens door' });
    expect(getPublicEdition(edited)?.id).toBe('edition-1');
    expect(getPublicEdition(edited)?.pages.map(p => p.assetId)).toEqual(['page1-image', 'page2-image']);
    expect(() => publishComic(edited, 'alice', 2, 'edition-2')).toThrow();
    const withdrawn = withdrawComic(edited, 'alice');
    expect(getPublicEdition(withdrawn)).toBeNull();
    expect(getPublicEdition(initial)?.id).toBe('edition-1');
  });
  test('owners alone can modify and publishing rejects stale or mismatched compositions', () => {
    const comic = fixture();
    expect(() => reviseStory(comic, 'bob', 1, 'p2', { p2: 'x', p3: 'y' })).toThrow('not authorized');
    expect(() => publishComic(comic, 'bob', 1, 'edition')).toThrow('not authorized');
    expect(() => publishComic(comic, 'alice', 0, 'edition')).toThrow('stale');
    expect(() => setPageComposition(comic, 'alice', 'page-1', 'wrong', ['a2', 'a1'])).toThrow('composition');
  });
  test('accepted visual blockers remain tied to the exact reviewed image', () => {
    let comic = fixture();
    comic = commitPanelRender(comic, 'alice', 'p2', {storyRevision:1,panelRevision:2}, 'flagged', 'blocker');
    expect(() => publishComic(comic, 'alice', 1, 'edition')).toThrow();
    comic = acceptPanel(comic, 'alice', 'p2', 'flagged', 1);
    const flagged = comic.pages[0].panels[1];
    expect(flagged.evaluation).toBe('blocker');
    expect(flagged.acceptance?.assetId).toBe('flagged');
    const changed = commitPanelRender(comic, 'alice', 'p2', {storyRevision:1,panelRevision:3}, 'replacement', 'blocker');
    expect(() => acceptPanel(changed, 'alice', 'p2', 'flagged', 1)).toThrow('stale');
    expect(changed.pages[0].panels[1].acceptance).toBeNull();
  });
  test('uncertain findings do not block publication and legacy acceptance remains versioned', () => {
    let comic = fixture();
    comic = commitPanelRender(comic, 'alice', 'p2', { storyRevision: 1, panelRevision: 2 }, 'uncertain', 'uncertain');
    comic = setPageComposition(comic, 'alice', 'page-1', 'new-page', ['a1', 'uncertain']);
    expect(publishComic(comic, 'alice', 1, 'edition').published?.id).toBe('edition');
    comic = acceptPanel(comic, 'alice', 'p2', 'uncertain', 1);
    expect(publishComic(comic, 'alice', 1, 'edition').published?.id).toBe('edition');
    const changed = commitPanelRender(comic, 'alice', 'p2', { storyRevision: 1, panelRevision: 3 }, 'next', 'uncertain');
    expect(() => acceptPanel(changed, 'alice', 'p2', 'uncertain', 1)).toThrow('stale');
  });
});
