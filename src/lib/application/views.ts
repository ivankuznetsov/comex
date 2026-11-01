import {createHash} from 'node:crypto';
import {isPanelReady, type ComicDraft} from '../domain/comic';
import type {Draft, Edition, PanelReview} from './contracts';
import {canonicalJson} from './json';

const canonicalDigest=(value:unknown)=>createHash('sha256').update(canonicalJson(value)!).digest('hex');
const legacyJsonDigest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)!).digest('hex');
function storyInputs(draft:Draft) {
  const characters = draft.characters.map(({id,name,role,appearance,outfit,approved,referenceAssetId}) =>
    ({id,name,role,appearance,outfit,approved,referenceAssetId:referenceAssetId ?? null}));
  return {storyRevision:draft.storyRevision,plot:draft.plot,style:draft.styleId,answers:draft.answers,characters,storyboard:draft.storyboard};
}
function narrativeInputs(draft:Draft) {return {revision:draft.storyRevision,storyboard:draft.storyboard,review:draft.storyReview};}

/** Bind approval to story inputs and the exact approved references, not unrelated draft edits. */
export function storyFingerprint(draft: Draft): string | null {
  if (!draft.storyboard || !draft.pages.length) return null;
  return canonicalDigest(storyInputs(draft));
}
export function isStoryApproved(draft: Draft): boolean {
  const fingerprint = storyFingerprint(draft);
  return !!fingerprint && draft.storyApproval?.storyRevision === draft.storyRevision &&
    (draft.storyApproval.fingerprint === fingerprint || draft.storyApproval.fingerprint === legacyJsonDigest(storyInputs(draft)));
}
export function narrativeFingerprint(draft: Draft): string | null {
  if (!draft.storyboard || !draft.storyReview || typeof draft.storyReview !== 'object') return null;
  return canonicalDigest(narrativeInputs(draft));
}
export function isNarrativeAccepted(draft:Draft):boolean {
  const fingerprint=narrativeFingerprint(draft);
  return !!fingerprint && (draft.storyReviewAcceptance===fingerprint || draft.storyReviewAcceptance===legacyJsonDigest(narrativeInputs(draft)));
}
export function rawNarrativeBlocker(draft:Draft):boolean {
  const review=draft.storyReview;
  return !!review && typeof review==='object' && 'findings' in review && Array.isArray(review.findings) && review.findings.some((finding:unknown)=>!!finding && typeof finding==='object' && 'severity' in finding && finding.severity==='blocker');
}
export function hasNarrativeBlocker(draft:Draft):boolean {
  return rawNarrativeBlocker(draft) && !isNarrativeAccepted(draft);
}
export function revisionPreview(draft: Draft, revision: number) {
  const proposal = draft.pendingRevision;
  if (!proposal) return null;
  const pageIndex = draft.pages.findIndex(page => page.panels.some(panel => panel.id === proposal.result.earliest_affected_panel_id));
  const panelIndex = pageIndex < 0 ? -1 : draft.pages[pageIndex].panels.findIndex(panel => panel.id === proposal.result.earliest_affected_panel_id);
  const changes = new Map(proposal.result.revised_suffix.map(panel => [panel.id,panel]));
  const storyboard = draft.storyboard ? {...draft.storyboard,bible:proposal.result.revised_bible,pages:draft.storyboard.pages.map(page => ({...page,panels:page.panels.map(panel => changes.get(panel.id) ?? panel)}))} : null;
  const panels=proposal.result.revised_suffix.flatMap(panel=>{
    const page=draft.pages.findIndex(item=>item.panels.some(existing=>existing.id===panel.id));
    const index=page<0?-1:draft.pages[page].panels.findIndex(existing=>existing.id===panel.id);
    const previous=draft.storyboard?.pages.flatMap(item=>item.panels).find(existing=>existing.id===panel.id);
    if(page<0 || index<0 || !previous)return [];
    return [{id:panel.id,page:page+1,panel:index+1,previousAction:previous.action,action:panel.action,dialogue:panel.dialogue.map(line=>({speaker:draft.characters.find(character=>character.id===line.speaker_id)?.name ?? line.speaker_id,text:line.text}))}];
  });
  return {id:proposal.id,baseRevision:proposal.baseRevision,baseStoryRevision:proposal.baseStoryRevision ?? draft.storyRevision,
    current:proposal.baseRevision === revision && !!draft.storyboard && pageIndex >= 0,
    earliestPanelId:proposal.result.earliest_affected_panel_id,affectedPage:pageIndex + 1,affectedPageId:draft.pages[pageIndex]?.id ?? null,affectedPanel:panelIndex + 1,
    explanation:proposal.result.explanation,panels,revisedBible:proposal.result.revised_bible,revisedSuffix:proposal.result.revised_suffix,storyboard};
}
function reviewOutcome(draft: Draft, panel: ComicDraft['pages'][number]['panels'][number]): PanelReview['outcome'] | null {
  const review = draft.panelReviews?.[panel.id];
  return review && review.assetId === panel.assetId && review.storyRevision === panel.storyRevision && panel.storyRevision === draft.storyRevision &&
    review.panelRevision === panel.revision && (panel.status === 'needs_review' || panel.status === 'current') ? review.outcome : null;
}
/** The same owner-free projection is used by every transport. */
export function view(draft: Draft, published: Edition | null, revision: number) {
  const reviewFingerprint = narrativeFingerprint(draft);
  const fingerprint = storyFingerprint(draft);
  const approved = isStoryApproved(draft);
  const revisionDecision = revisionPreview(draft, revision);
  const choice = draft.pendingArtworkDecision;
  const choicePanel = choice && draft.pages.flatMap(page => page.panels).find(panel => panel.id === choice.panelId);
  const artworkDecision = choice ? {id:choice.id,panelId:choice.panelId,instruction:choice.instruction,reason:choice.reason ?? null,intent:choice.intent ?? 'uncertain',
    reviewedVersion:{assetId:choice.assetId,storyRevision:choice.storyRevision,panelRevision:choice.panelRevision},expiresAt:choice.expiresAt,
    current:choice.expiresAt > Date.now() && !!choicePanel && choicePanel.assetId === choice.assetId && choicePanel.revision === choice.panelRevision && choicePanel.storyRevision === choice.storyRevision && draft.storyRevision === choice.storyRevision,
    choices:choice.intent === 'story' ? ['preview_story'] : ['preview_story','artwork_only']} : null;
  const nextSteps: Array<{action:string; pageId?:string; panelId?:string; characterId?:string; assetId?:string; revision?:number; storyRevision?:number; panelRevision?:number; fingerprint?:string; proposalId?:string; requiresConfirmation?:boolean; retry?:boolean}> = [];
  if (!draft.pages.length) {
    if (draft.initialQuestions === 'pending') nextSteps.push({action:'ask_initial_questions'});
    else if (draft.initialQuestions === 'running') nextSteps.push({action:'wait_for_questions'});
    else if (draft.initialQuestions === 'unknown') nextSteps.push({action:'resolve_questions'});
    else nextSteps.push({action:'answer_questions'},{action:'refresh_questions'});
    if (draft.initialSuggestions === 'running') nextSteps.push({action:'wait_for_character_suggestions'});
    else if (draft.initialSuggestions === 'unknown') nextSteps.push({action:'resolve_character_suggestions'});
    else if (draft.initialQuestions !== 'pending' && draft.initialQuestions !== 'running' && draft.initialQuestions !== 'unknown') nextSteps.push({action:'suggest_characters',retry:draft.initialSuggestions !== 'pending'});
    nextSteps.push({action:'add_character'});
    for (const character of draft.characters) {
      if (draft.operations?.[`character:${character.id}`]) continue;
      if (!character.referenceAssetId) nextSteps.push({action:'generate_reference',characterId:character.id});
      else if (!character.approved && character.referenceUrl) nextSteps.push({action:'approve_reference',characterId:character.id,assetId:character.referenceAssetId});
    }
    if (draft.characters.length && draft.characters.every(character => character.approved && character.referenceAssetId && !draft.operations?.[`character:${character.id}`]) && !['running','unknown'].includes(draft.initialQuestions ?? '') && !['running','unknown'].includes(draft.initialSuggestions ?? '')) nextSteps.push({action:'plan_story'});
  } else {
    if (!approved && fingerprint && draft.characters.every(character => character.approved && character.referenceAssetId)) nextSteps.push({action:'approve_story',revision,storyRevision:draft.storyRevision,fingerprint});
    if (draft.storyboard) nextSteps.push({action:'preview_revision'});
    if (revisionDecision?.current) nextSteps.push({action:'apply_revision',proposalId:revisionDecision.id,requiresConfirmation:true});
    if (artworkDecision?.current && approved && artworkDecision.intent === 'uncertain') nextSteps.push({action:'choose_artwork_only',panelId:artworkDecision.panelId,proposalId:artworkDecision.id,requiresConfirmation:true});
    if (approved) {
      const referencesReady = !!draft.storyboard && draft.storyboard.pages.every(page => page.panels.every(panel => panel.character_ids.every(id => draft.characters.some(character => character.id === id && character.approved && character.referenceAssetId))));
      if (referencesReady) for (const [index,page] of draft.pages.entries()) {
        const previousReady = index === 0 || draft.pages[index-1].panels.every(panel => panel.storyRevision === draft.storyRevision && isPanelReady(panel) && !draft.operations?.[`panel:${panel.id}`]);
        const blockedPanel = page.panels.some(panel => !!draft.operations?.[`panel:${panel.id}`]);
        if (previousReady && !blockedPanel) nextSteps.push({action:'generate_page',pageId:page.id});
      }
    }
  }
  return {
    id: draft.id, title: draft.title, plot: draft.plot, style: draft.styleId, revision, storyRevision:draft.storyRevision,
    panelsPerPage:draft.panelsPerPage ?? 3, pageLayout:draft.pageLayout ?? 'stack',
    characters: draft.characters.map(({referenceAssetId, ...character}) => ({...character,referenceVersion:referenceAssetId ?? null,referenceStatus:draft.operations?.[`character:${character.id}`] ?? (referenceAssetId ? 'ready' : 'missing')})), characterSuggestions:draft.characterSuggestions ?? [], initialSuggestions:draft.initialSuggestions ?? 'idle', questions: draft.questions, initialQuestions:draft.initialQuestions ?? (draft.questions.length ? 'complete' : 'failed'), answers: draft.answers, storyReview: draft.storyReview && typeof draft.storyReview === 'object' ? {...draft.storyReview, fingerprint:reviewFingerprint, accepted:isNarrativeAccepted(draft)} : null,
    storyboard:draft.storyboard ?? null, storyApproval:fingerprint ? {storyRevision:draft.storyRevision,fingerprint,approved} : null,
    pendingRevision:revisionDecision, pendingArtworkDecision:artworkDecision, nextSteps, nextActions:[...new Set(nextSteps.map(step => step.action))],
    pages: draft.pages.map((page, i) => ({id: page.id, index: i + 1, generationPending:draft.pageOperations?.[page.id]?.storyRevision === draft.storyRevision,
      status: page.panels.some(p => p.status === 'outdated') ? 'outdated' : page.panels.every(p => p.storyRevision === draft.storyRevision && isPanelReady(p) && !draft.operations?.[`panel:${p.id}`]) ? 'current' : page.panels.some(p => p.status === 'checking') ? 'checking' : page.panels.some(p => p.status === 'needs_review') ? 'needs_review' : 'planned',
      panels: page.panels.map(p => ({id: p.id, description: p.beat, status: p.status, evaluation: p.evaluation, reviewOutcome:reviewOutcome(draft,p), findings: reviewOutcome(draft,p) ? draft.panelFindings?.[p.id] ?? [] : [], ready: p.storyRevision === draft.storyRevision && isPanelReady(p) && !draft.operations?.[`panel:${p.id}`], accepted: !!p.acceptance && p.acceptance.assetId === p.assetId && p.acceptance.storyRevision === p.storyRevision && p.acceptance.panelRevision === p.revision, imageUrl: p.assetId ? `/api/comics/${encodeURIComponent(draft.id)}/assets/${encodeURIComponent(p.assetId)}` : null, reviewVersion: p.assetId ? {assetId:p.assetId, storyRevision:p.storyRevision, panelRevision:p.revision} : null}))})),
    published: !!published, publication: published ? {editionId:published.editionId,title:published.title, creator:published.creator} : null,
    unpublishedChanges: !!published && published.sourceRevision !== revision,
  };
}
export function publicView(edition:Edition) {
  return {id:edition.id,title:edition.title,creator:edition.creator,editionId:edition.editionId,pages:edition.pages.map(({id,imageUrl}) => ({id,imageUrl}))};
}
