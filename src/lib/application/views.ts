import {createHash} from 'node:crypto';
import {isPanelReady, type ComicDraft} from '../domain/comic';
import type {Draft, Edition, PanelReview} from './contracts';

export function narrativeFingerprint(draft: Draft): string | null {
  if (!draft.storyboard || !draft.storyReview || typeof draft.storyReview !== 'object') return null;
  return createHash('sha256').update(JSON.stringify({revision:draft.storyRevision,storyboard:draft.storyboard,review:draft.storyReview})).digest('hex');
}
function reviewOutcome(draft: Draft, panel: ComicDraft['pages'][number]['panels'][number]): PanelReview['outcome'] | null {
  const review = draft.panelReviews?.[panel.id];
  return review && review.assetId === panel.assetId && review.storyRevision === panel.storyRevision && panel.storyRevision === draft.storyRevision &&
    review.panelRevision === panel.revision && (panel.status === 'needs_review' || panel.status === 'current') ? review.outcome : null;
}
/** The same owner-free projection is used by every transport. */
export function view(draft: Draft, published: Edition | null, revision: number) {
  const reviewFingerprint = narrativeFingerprint(draft);
  return {
    id: draft.id, title: draft.title, plot: draft.plot, style: draft.styleId, revision, storyRevision:draft.storyRevision,
    panelsPerPage:draft.panelsPerPage ?? 3, pageLayout:draft.pageLayout ?? 'stack',
    characters: draft.characters.map(({referenceAssetId, ...character}) => ({...character,referenceVersion:referenceAssetId ?? null,referenceStatus:draft.operations?.[`character:${character.id}`] ?? (referenceAssetId ? 'ready' : 'missing')})), characterSuggestions:draft.characterSuggestions ?? [], initialSuggestions:draft.initialSuggestions ?? 'idle', questions: draft.questions, initialQuestions:draft.initialQuestions ?? (draft.questions.length ? 'complete' : 'failed'), answers: draft.answers, storyReview: draft.storyReview && typeof draft.storyReview === 'object' ? {...draft.storyReview, fingerprint:reviewFingerprint, accepted:!!reviewFingerprint && draft.storyReviewAcceptance === reviewFingerprint} : null,
    storyboard:draft.storyboard ?? null,
    pages: draft.pages.map((page, i) => ({id: page.id, index: i + 1,
      status: page.panels.some(p => p.status === 'outdated') ? 'outdated' : page.panels.every(p => p.storyRevision === draft.storyRevision && isPanelReady(p)) ? 'current' : page.panels.some(p => p.status === 'checking') ? 'checking' : page.panels.some(p => p.status === 'needs_review') ? 'needs_review' : 'planned',
      panels: page.panels.map(p => ({id: p.id, description: p.beat, status: p.status, evaluation: p.evaluation, reviewOutcome:reviewOutcome(draft,p), findings: reviewOutcome(draft,p) ? draft.panelFindings?.[p.id] ?? [] : [], accepted: isPanelReady(p) && p.status === 'needs_review', imageUrl: p.assetId ? `/api/comics/${encodeURIComponent(draft.id)}/assets/${encodeURIComponent(p.assetId)}` : null, reviewVersion: p.assetId ? {assetId:p.assetId, storyRevision:p.storyRevision, panelRevision:p.revision} : null}))})),
    published: !!published, publication: published ? {title:published.title, creator:published.creator} : null,
    unpublishedChanges: !!published && published.sourceRevision !== revision,
  };
}
export function publicView(edition:Edition) {
  return {id:edition.id,title:edition.title,creator:edition.creator,editionId:edition.editionId,pages:edition.pages.map(({id,imageUrl}) => ({id,imageUrl}))};
}
