/** Pure domain operations. Persistence and the session-to-owner identity boundary are the caller's responsibility. */
export type Evaluation = 'pass' | 'warning' | 'uncertain' | 'blocker' | 'pending';
export type PanelStatus = 'planned' | 'current' | 'needs_review' | 'checking' | 'outdated';
export interface Panel {
  id: string;
  beat: string;
  assetId: string | null;
  revision: number;
  storyRevision: number;
  status: PanelStatus;
  evaluation: Evaluation;
  acceptance: { assetId: string; storyRevision: number; panelRevision: number } | null;
}
export interface PageComposition { assetId: string; panelAssetIds: string[] }
export interface Page { id: string; panels: Panel[]; composition: PageComposition | null }
export interface PublishedEdition {
  id: string;
  comicId: string;
  title: string;
  creatorName: string;
  storyRevision: number;
  pages: { id: string; assetId: string }[];
}
export interface ComicDraft {
  id: string;
  ownerId: string;
  title: string;
  creatorName: string;
  plot: string;
  styleId: string;
  storyRevision: number;
  pages: Page[];
  published: PublishedEdition | null;
}
export interface CreateComic {
  id: string;
  ownerId: string;
  title: string;
  creatorName: string;
  plot: string;
  styleId: string;
  pages: { id: string; panels: { id: string; beat: string }[] }[];
}
export type RenderVersion = { storyRevision: number; panelRevision: number };

/** A new private draft is intentionally incomplete until its story is planned. */
export function createBlankComic(id: string, ownerId: string): ComicDraft {
  required(id, 'comic id'); required(ownerId, 'owner id');
  return { id, ownerId, title: 'Untitled comic', creatorName: '', plot: '', styleId: '',
    storyRevision: 1, pages: [], published: null };
}

function required(value: string, label: string): void {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
}
function owned(comic: ComicDraft, ownerId: string): void {
  if (!ownerId || comic.ownerId !== ownerId) throw new Error('not authorized');
}
function findPanel(comic: ComicDraft, panelId: string): { page: Page; panel: Panel } {
  for (const page of comic.pages) {
    const panel = page.panels.find(item => item.id === panelId);
    if (panel) return { page, panel };
  }
  throw new Error('panel not found');
}
export function isPanelReady(panel: Panel): boolean {
  if (!panel.assetId || panel.storyRevision < 1) return false;
  if (panel.status === 'current' && panel.evaluation === 'pass') return true;
  return panel.status === 'needs_review' && (panel.evaluation === 'warning' || panel.evaluation === 'uncertain' || panel.evaluation === 'blocker') &&
    panel.acceptance?.assetId === panel.assetId && panel.acceptance.storyRevision === panel.storyRevision &&
    panel.acceptance.panelRevision === panel.revision;
}

export function createComic(input: CreateComic): ComicDraft {
  required(input.id, 'comic id'); required(input.ownerId, 'owner id'); required(input.title, 'title');
  required(input.plot, 'plot'); required(input.styleId, 'style');
  if (!input.pages.length) throw new Error('at least one page is required');
  const pageIds = new Set<string>(), panelIds = new Set<string>();
  const pages = input.pages.map(page => {
    required(page.id, 'page id');
    if (pageIds.has(page.id)) throw new Error('duplicate page id');
    pageIds.add(page.id);
    if (!page.panels.length) throw new Error('page requires panels');
    return { id: page.id, composition: null, panels: page.panels.map(panel => {
      required(panel.id, 'panel id'); required(panel.beat, 'panel beat');
      if (panelIds.has(panel.id)) throw new Error('duplicate panel id');
      panelIds.add(panel.id);
      return { id: panel.id, beat: panel.beat, assetId: null, revision: 1, storyRevision: 1,
        status: 'planned' as const, evaluation: 'pending' as const, acceptance: null };
    }) };
  });
  return { id: input.id, ownerId: input.ownerId, title: input.title, creatorName: input.creatorName,
    plot: input.plot, styleId: input.styleId, storyRevision: 1, pages, published: null };
}

/** Replace only this panel; caller must atomically compare and persist the returned revision. */
export function commitPanelRender(comic: ComicDraft, ownerId: string, panelId: string, expected: RenderVersion,
  assetId: string, evaluation: Exclude<Evaluation, 'pending'>): ComicDraft {
  owned(comic, ownerId); required(assetId, 'asset id');
  const { panel } = findPanel(comic, panelId);
  if (expected.storyRevision !== comic.storyRevision || panel.storyRevision !== expected.storyRevision ||
      expected.panelRevision !== panel.revision) throw new Error('stale render');
  if (!['pass', 'warning', 'uncertain', 'blocker'].includes(evaluation)) throw new Error('invalid evaluation');
  const pages = comic.pages.map(page => page.panels.some(p => p.id === panelId) ? {
    ...page, composition: null, panels: page.panels.map(p => p.id === panelId ? {
      ...p, assetId, revision: p.revision + 1, status: evaluation === 'pass' ? 'current' as const : 'needs_review' as const,
      evaluation, acceptance: null,
    } : p),
  } : page);
  return { ...comic, pages };
}

/** Replans a conservative suffix, retaining historical images until replacements are ready. */
export function reviseStory(comic: ComicDraft, ownerId: string, expectedRevision: number,
  firstPanelId: string, beats: Record<string, string>): ComicDraft {
  owned(comic, ownerId);
  if (comic.storyRevision !== expectedRevision) throw new Error('stale story revision');
  const ordered = comic.pages.flatMap(page => page.panels);
  const first = ordered.findIndex(panel => panel.id === firstPanelId);
  if (first < 0) throw new Error('panel not found');
  const suffix = ordered.slice(first);
  for (const panel of suffix) required(beats[panel.id], `revised beat for ${panel.id}`);
  const suffixIds = new Set(suffix.map(panel => panel.id));
  const revision = comic.storyRevision + 1;
  const pages = comic.pages.map(page => ({
    ...page,
    composition: page.panels.some(p => suffixIds.has(p.id)) ? null : page.composition,
    panels: page.panels.map(panel => suffixIds.has(panel.id) ? {
      ...panel, beat: beats[panel.id], storyRevision: revision, revision: panel.revision + 1,
      status: 'outdated' as const, evaluation: 'pending' as const, acceptance: null,
    } : { ...panel, storyRevision: revision,
      ...(panel.status === 'checking' ? {status:'needs_review' as const, evaluation:'uncertain' as const} : {}),
      acceptance: panel.acceptance ? { ...panel.acceptance, storyRevision: revision } : null }),
  }));
  return { ...comic, pages, storyRevision: revision };
}

export function acceptPanel(comic: ComicDraft, ownerId: string, panelId: string, assetId: string,
  storyRevision: number): ComicDraft {
  owned(comic, ownerId);
  const { panel } = findPanel(comic, panelId);
  if (storyRevision !== comic.storyRevision || panel.storyRevision !== storyRevision || panel.assetId !== assetId)
    throw new Error('stale acceptance');
  if (panel.status !== 'needs_review' || !['uncertain', 'warning', 'blocker'].includes(panel.evaluation))
    throw new Error('panel is not eligible for acceptance');
  return { ...comic, pages: comic.pages.map(page => ({ ...page, panels: page.panels.map(p => p.id !== panelId ? p : {
    ...p, acceptance: { assetId, storyRevision, panelRevision: p.revision },
  }) })) };
}

export function setPageComposition(comic: ComicDraft, ownerId: string, pageId: string,
  assetId: string, panelAssetIds: string[]): ComicDraft {
  owned(comic, ownerId); required(assetId, 'asset id');
  const page = comic.pages.find(p => p.id === pageId);
  if (!page) throw new Error('page not found');
  if (page.panels.length !== panelAssetIds.length || page.panels.some((p, i) => !p.assetId || p.assetId !== panelAssetIds[i] ||
      p.storyRevision !== comic.storyRevision || p.status === 'outdated' || p.status === 'planned')) throw new Error('stale composition');
  return { ...comic, pages: comic.pages.map(p => p.id !== pageId ? p : {
    ...p, composition: { assetId, panelAssetIds: [...panelAssetIds] },
  }) };
}

export function publishComic(comic: ComicDraft, ownerId: string, expectedRevision: number,
  editionId: string): ComicDraft {
  owned(comic, ownerId); required(editionId, 'edition id');
  if (comic.storyRevision !== expectedRevision) throw new Error('stale publication');
  if (!comic.pages.length || comic.pages.some(page => !page.panels.length))
    throw new Error('comic has incomplete pages');
  const pages = comic.pages.map(page => {
    if (!page.composition || page.panels.some((p, i) => p.storyRevision !== comic.storyRevision || !isPanelReady(p) ||
      page.composition!.panelAssetIds[i] !== p.assetId) || page.composition.panelAssetIds.length !== page.panels.length)
      throw new Error('comic has incomplete or unaccepted pages');
    return { id: page.id, assetId: page.composition.assetId };
  });
  const published: PublishedEdition = { id: editionId, comicId: comic.id, title: comic.title,
    creatorName: comic.creatorName || 'Anonymous', storyRevision: comic.storyRevision, pages };
  return { ...comic, published };
}

export function withdrawComic(comic: ComicDraft, ownerId: string): ComicDraft {
  owned(comic, ownerId);
  return { ...comic, published: null };
}

/** Public representation deliberately excludes all draft, session, reference and job data. */
export function getPublicEdition(comic: ComicDraft): PublishedEdition | null {
  return comic.published ? structuredClone(comic.published) : null;
}
