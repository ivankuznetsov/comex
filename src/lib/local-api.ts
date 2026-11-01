import { wrapDialogue } from './lettering';
import { randomUUID, randomBytes, randomInt, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { createAIService, AIError, type Storyboard, type Reference, type RevisionResult } from './ai/service';
import stylePresets from '../../prompts/styles.json';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import sharp from 'sharp';
import { LocalStore, ClaimInProgressError } from './local-store';
import { createBudgetedFetch, BudgetError } from './budget';
import { createBlankComic, createComic, commitPanelRender, acceptPanel, reviseStory, publishComic, isPanelReady, type ComicDraft } from './domain/comic';

type Character = {id: string; name: string; role: string; appearance: string; outfit: string; referenceUrl?: string; referenceAssetId?: string; approved: boolean};
type PanelReview = {assetId:string; storyRevision:number; panelRevision:number; outcome:'pass' | 'findings' | 'inconclusive' | 'failed'};
type SuggestedCharacter = {id:string; name:string; role:string; appearance:string; outfit:string};
type Draft = ComicDraft & {characters: Character[]; answers: Record<string,string>; questions: {id: string; question: string; suggestedAnswer?: string}[]; initialQuestions?: 'pending' | 'running' | 'complete' | 'failed' | 'unknown'; characterSuggestions?: SuggestedCharacter[]; initialSuggestions?: 'pending' | 'running' | 'complete' | 'failed' | 'unknown'; panelsPerPage?: number; pageLayout?: 'stack' | 'grid'; storyboard?: Storyboard; storyReview?: unknown; storyReviewAcceptance?: string; pageOperations?: Record<string, {storyRevision:number; baseline:Record<string,number>}>; pendingRevision?: {id:string; baseRevision:number; result:RevisionResult}; pendingArtworkDecision?: {id:string;panelId:string;instruction:string;assetId:string;storyRevision:number;panelRevision:number;expiresAt:number}; panelFindings?: Record<string, unknown[]>; panelReviews?: Record<string, PanelReview>; operations?: Record<string, 'running' | 'unknown_outcome'>};
type Edition = {id: string; title: string; creator: string; editionId: string; sourceRevision: number; pages: {id: string; imageUrl: string; storage?: 'sqlite'}[]};
const globalStore = globalThis as typeof globalThis & { __comexLocalStore?: LocalStore };
const getStore = () => globalStore.__comexLocalStore ??= new LocalStore(process.env.COMEX_DB_PATH || resolve(process.cwd(), 'data/comex.sqlite'));
const ai = () => createAIService({fetch:createBudgetedFetch(process.env.COMEX_BUDGET_DB_PATH || process.env.COMEX_DB_PATH || resolve(process.cwd(),'data/comex.sqlite'))});
const styles = z.enum(['clear-line-adventure', 'ink-manga', 'painted-storybook']);
const short = z.string().trim().min(1).max(300);
const createSchema = z.object({title: short, plot: z.string().trim().min(1).max(4000), style: styles, email:z.string().trim().email().max(254).optional()}).strict();
const patchSchema = z.object({title: short.optional(), plot: z.string().trim().min(1).max(4000).optional(), style: styles.optional(), answers: z.record(z.string().max(100), z.string().max(1000)).optional(), panelsPerPage:z.number().int().min(2).max(4).optional(), pageLayout:z.enum(['stack','grid']).optional()}).strict();
const characterSchema = z.object({name: short, role: short, appearance: z.string().trim().min(1).max(1000), outfit: z.string().trim().min(1).max(1000)}).strict();
const panelVersionSchema = z.object({assetId:z.string().uuid(),storyRevision:z.number().int().positive(),panelRevision:z.number().int().positive()}).strict();
const publishSchema = z.object({title: short, creator: z.string().trim().max(100)}).strict();
class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
function reply(data: unknown, status = 200) { return NextResponse.json(data, {status, headers: {'Cache-Control': 'no-store'}}); }
function owner(request: NextRequest): string | null {
  const authenticated = request.cookies.get('comex_auth')?.value;
  if (authenticated && /^[a-f0-9]{64}$/.test(authenticated)) {
    const identity = getStore().authIdentity(authenticated);
    if (identity) return identity.owner;
  }
  const guest=request.cookies.get('comex_session')?.value;
  if (!guest || !/^[a-f0-9]{64}$/.test(guest)) return null;
  const store=getStore();
  const identity=store.guestIdentity(guest);
  if (identity) return identity.owner;
  // Existing drafts used the original random browser cookie as their owner.
  // Do not revive expired guests or treat current internal owner IDs as cookies.
  return !store.hasGuestToken(guest) && store.hasLegacyOwner(guest) ? guest : null;
}
function assertMutation(request: NextRequest) {
  const origin = request.headers.get('origin');
  if (origin) {
    let supplied: URL;
    try { supplied = new URL(origin); } catch { throw new HttpError(403, 'Cross-origin requests are not allowed.'); }
    const host = request.headers.get('host') ?? request.nextUrl.host;
    if (supplied.host !== host || supplied.protocol !== request.nextUrl.protocol) throw new HttpError(403, 'Cross-origin requests are not allowed.');
  }
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Send JSON data.');
}
async function input<T>(request: NextRequest, schema: z.ZodType<T>): Promise<T> {
  assertMutation(request);
  const text = await request.text();
  if (Buffer.byteLength(text, 'utf8') > 32_000) throw new HttpError(413, 'Request is too large.');
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw new HttpError(400, 'Invalid JSON.'); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, 'Please check the supplied fields.');
  return parsed.data;
}
function owned(request: NextRequest, id: string) {
  const session = owner(request);
  if (!session) throw new HttpError(404, 'Comic not found.');
  const store = getStore();
  const record = store.getOwned<Draft>(id, session);
  if (!record) throw new HttpError(404, 'Comic not found.');
  return {session, store, ...record};
}
function reviewOutcome(draft: Draft, panel: ComicDraft['pages'][number]['panels'][number]): PanelReview['outcome'] | null {
  const review = draft.panelReviews?.[panel.id];
  return review && review.assetId === panel.assetId && review.storyRevision === panel.storyRevision && panel.storyRevision === draft.storyRevision &&
    review.panelRevision === panel.revision && (panel.status === 'needs_review' || panel.status === 'current') ? review.outcome : null;
}
function view(draft: Draft, published: Edition | null, revision: number) {
  const reviewFingerprint = narrativeFingerprint(draft);
  return {
    id: draft.id, title: draft.title, plot: draft.plot, style: draft.styleId, panelsPerPage:draft.panelsPerPage ?? 3, pageLayout:draft.pageLayout ?? 'stack',
    characters: draft.characters.map(({referenceAssetId, ...character}) => ({...character,referenceVersion:referenceAssetId ?? null,referenceStatus:draft.operations?.[`character:${character.id}`] ?? (referenceAssetId ? 'ready' : 'missing')})), characterSuggestions:draft.characterSuggestions ?? [], initialSuggestions:draft.initialSuggestions ?? 'idle', questions: draft.questions, initialQuestions:draft.initialQuestions ?? (draft.questions.length ? 'complete' : 'failed'), answers: draft.answers, storyReview: draft.storyReview && typeof draft.storyReview === 'object' ? {...draft.storyReview, fingerprint:reviewFingerprint, accepted:!!reviewFingerprint && draft.storyReviewAcceptance === reviewFingerprint} : null,
    pages: draft.pages.map((page, i) => ({id: page.id, index: i + 1,
      status: page.panels.some(p => p.status === 'outdated') ? 'outdated' : page.panels.every(p => p.storyRevision === draft.storyRevision && isPanelReady(p)) ? 'current' : page.panels.some(p => p.status === 'checking') ? 'checking' : page.panels.some(p => p.status === 'needs_review') ? 'needs_review' : 'planned',
      panels: page.panels.map(p => ({id: p.id, description: p.beat, status: p.status, evaluation: p.evaluation, reviewOutcome:reviewOutcome(draft,p), findings: reviewOutcome(draft,p) ? draft.panelFindings?.[p.id] ?? [] : [], accepted: isPanelReady(p) && p.status === 'needs_review', imageUrl: p.assetId ? `/api/comics/${encodeURIComponent(draft.id)}/assets/${encodeURIComponent(p.assetId)}` : null, reviewVersion: p.assetId ? {assetId:p.assetId, storyRevision:p.storyRevision, panelRevision:p.revision} : null}))})),
    published: !!published, publication: published ? {title:published.title, creator:published.creator} : null,
    unpublishedChanges: !!published && published.sourceRevision !== revision,
  };
}
function save(store: LocalStore, session: string, revision: number, draft: Draft) {
  if (!store.update(draft.id, session, revision, draft)) throw new HttpError(409, 'This draft changed. Refresh and try again.');
  return view(draft, store.getPublished<Edition>(draft.id), revision + 1);
}

/** Give each saved answer its question context, never just an opaque model ID. */
function answeredQuestions(draft: Draft): Record<string,string> {
  return Object.fromEntries(draft.questions.filter(question => draft.answers[question.id]?.trim()).map(question => [question.question, draft.answers[question.id].trim()]));
}
/** The reservation is persisted separately so a crash cannot silently cause a duplicate paid dispatch. */
async function withTextOperation<T>(store: LocalStore, session: string, id: string, revision: number, task: () => Promise<T>): Promise<T> {
  if (!store.reserveTextOperation(id,session,revision)) throw new HttpError(409, 'A story request is already running, has an unknown outcome, or the draft changed.');
  let unknown = false;
  try { return await task(); }
  catch (error) {
    unknown = error instanceof AIError && (error.code === 'unknown_outcome' || error.code === 'invalid_response');
    throw error;
  } finally { store.finishTextOperation(id,session,unknown); }
}
function inconclusiveReview(error: unknown) {
  if (error instanceof AIError && (error.code === 'unknown_outcome' || error.code === 'invalid_response')) throw error;
  return {outcome:'inconclusive',findings:[]};
}
type StoryPanel = Storyboard['pages'][number]['panels'][number];
type StoryState = StoryPanel['state_before'];

/** Remove only byte-for-byte repeated facts; conflicting values still fail validation. */
function normalizeState(state: StoryState): StoryState {
  const unique = (facts: StoryState['props']) => {
    const seen = new Map<string, Set<string>>();
    return facts.filter(({key,value}) => {
      const values = seen.get(key) ?? new Set<string>();
      if (values.has(value)) return false;
      values.add(value); seen.set(key,values); return true;
    });
  };
  return {...state, props:unique(state.props), outfits:unique(state.outfits), injuries:unique(state.injuries), knowledge:unique(state.knowledge)};
}
function normalizePanelLedger(panel: StoryPanel): StoryPanel {
  return {...panel,state_before:normalizeState(panel.state_before),state_after:normalizeState(panel.state_after)};
}

/** Deterministic checks cannot infer a transfer from prose; they enforce the explicit state ledger. */
export function validateStoryLedger(storyboard: Storyboard): string[] {
  const errors: string[] = [];
  const panels = storyboard.pages.flatMap(page => page.panels);
  const facts = ['props', 'outfits', 'injuries', 'knowledge'] as const;
  for (let i = 0; i < panels.length; i++) {
    const panel = panels[i];
    for (const state of [panel.state_before,panel.state_after]) {
      if (!state.location.trim() || !state.time.trim()) errors.push(`${panel.id}: location and time are required`);
      for (const field of facts) {
        const keys = state[field].map(item => item.key);
        if (keys.some(key => !key.trim()) || new Set(keys).size !== keys.length) errors.push(`${panel.id}: invalid or duplicate ${field} state`);
      }
    }
    if (i) {
      const earlier = panels[i-1].state_after, next = panel.state_before;
      if (earlier.location !== next.location || earlier.time !== next.time) errors.push(`${panel.id}: incoming scene state does not match the previous panel`);
      for (const field of facts) {
        const a = new Map(earlier[field].map(item => [item.key,item.value]));
        if (a.size !== next[field].length || next[field].some(item => a.get(item.key) !== item.value)) errors.push(`${panel.id}: incoming ${field} does not match the previous panel`);
      }
    }
  }
  return errors;
}
function styleRules(id: string): string {
  const style = stylePresets.styles.find(s => s.id === id);
  if (!style) throw new HttpError(400, 'Unknown comic style.');
  return style.rules;
}
const assetRoot = () => resolve(process.env.COMEX_ASSET_PATH || resolve(process.cwd(), 'data/assets'));
async function saveAsset(bytes: Buffer): Promise<string> {
  if (!bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new HttpError(502, 'Image provider did not return a PNG.');
  const id = randomUUID(); await mkdir(assetRoot(), {recursive: true});
  const path = resolve(assetRoot(), `${id}.png`);
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(bytes); await file.close(); }
  catch (error) { await file.close().catch(() => {}); await unlink(path).catch(() => {}); throw error; }
  return id;
}
async function discardAsset(id: string): Promise<void> {
  await unlink(resolve(assetRoot(), `${id}.png`)).catch(() => {});
}
async function asset(id: string): Promise<Buffer> {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new HttpError(404, 'Image not found.');
  try { return await readFile(resolve(assetRoot(), `${id}.png`)); } catch { throw new HttpError(404, 'Image not found.'); }
}
function narrativeFingerprint(draft: Draft): string | null {
  if (!draft.storyboard || !draft.storyReview || typeof draft.storyReview !== 'object') return null;
  return createHash('sha256').update(JSON.stringify({revision:draft.storyRevision,storyboard:draft.storyboard,review:draft.storyReview})).digest('hex');
}
function rawNarrativeBlocker(draft: Draft): boolean {
  const review = draft.storyReview;
  if (!review || typeof review !== 'object' || !('findings' in review) || !Array.isArray(review.findings)) return false;
  return review.findings.some((finding: unknown) => !!finding && typeof finding === 'object' && 'severity' in finding && finding.severity === 'blocker');
}
function hasNarrativeBlocker(draft: Draft): boolean {
  const fingerprint = narrativeFingerprint(draft);
  return rawNarrativeBlocker(draft) && (!fingerprint || draft.storyReviewAcceptance !== fingerprint);
}
function requireClearNarrative(draft: Draft): void {
  if (hasNarrativeBlocker(draft)) throw new HttpError(409, 'Resolve the story review blockers before generating artwork.');
}
async function renderPanel(store: LocalStore, session: string, comicId: string, panelId: string, editInstruction?: string, expectedVersion?: z.infer<typeof panelVersionSchema>): Promise<void> {
  const record = store.getOwned<Draft>(comicId, session);
  if (!record || !record.data.storyboard) throw new HttpError(409, 'Plan the story first.');
  const draft = record.data;
  requireClearNarrative(draft);
  const storyboard = draft.storyboard!;
  const panels = draft.pages.flatMap(page => page.panels);
  const index = panels.findIndex(p => p.id === panelId);
  if (index < 0) throw new HttpError(404, 'Panel not found.');
  const panel = panels[index];
  if (panel.status === 'checking') throw new HttpError(409, 'Wait for the panel review to finish.');
  if (expectedVersion && (panel.assetId !== expectedVersion.assetId || panel.revision !== expectedVersion.panelRevision || panel.storyRevision !== expectedVersion.storyRevision || draft.storyRevision !== expectedVersion.storyRevision)) throw new HttpError(409, 'Panel changed while planning the edit; refresh and review it again.');
  const previous = index > 0 ? panels[index - 1] : undefined;
  if (previous && (!previous.assetId || previous.storyRevision !== draft.storyRevision || ['outdated','planned','checking'].includes(previous.status))) throw new HttpError(409, 'Generate and review earlier panels first.');
  if (previous?.evaluation === 'blocker' && !isPanelReady(previous)) throw new HttpError(409, 'Review the preceding panel before generating this one.');
  const spec = storyboard.pages.flatMap(p => p.panels).find(p => p.id === panelId);
  if (!spec) throw new HttpError(409, 'The storyboard does not match this panel.');
  // Dialogue is added later during page composition; raw art must remain unlettered.
  const {dialogue: _dialogue, ...visualSpec} = spec; void _dialogue;
  const characters = draft.characters.filter(c => spec.character_ids.includes(c.id));
  if (characters.length !== spec.character_ids.length || characters.some(c => !c.approved || !c.referenceAssetId)) throw new HttpError(409, 'Approve all character references first.');
  const anchorCharacters = characters.length ? characters : draft.characters.filter(c => c.approved && c.referenceAssetId).slice(0,1);
  const references: Reference[] = await Promise.all(anchorCharacters.map(async c => ({role:'approved character', id:c.id, bytes:await asset(c.referenceAssetId!), mimeType:'image/png' as const})));
  if (previous?.assetId) references.push({role:'previous panel',id:previous.id,bytes:await asset(previous.assetId),mimeType:'image/png'});
  const op = `panel:${panelId}`;
  if (draft.operations?.[op]) throw new HttpError(409, 'This panel request is already running or has an unknown outcome.');
  const reserved: Draft = {...draft,operations:{...draft.operations,[op]:'running'}};
  if (!store.update(comicId,session,record.revision,reserved)) throw new HttpError(409,'Draft changed; refresh and try again.');
  let assetId: string | undefined;
  let assetCommitted = false;
  try {
    const bytes = editInstruction
      ? await ai().editPanel({change:editInstruction,preserve:JSON.stringify({style:styleRules(draft.styleId),panel:visualSpec,characters}),references:[{role:'target panel',id:panelId,bytes:await asset(panel.assetId!),mimeType:'image/png'},...references]})
      : await ai().panel({styleRules:styleRules(draft.styleId),panelSpec:JSON.stringify(visualSpec),sceneBefore:JSON.stringify(spec.state_before),characters,references});
    assetId = await saveAsset(bytes);
    for (let attempt = 0; attempt < 3; attempt++) {
      const latest = store.getOwned<Draft>(comicId,session);
      const currentPanels = latest?.data.pages.flatMap(page => page.panels) ?? [];
      const currentIndex = currentPanels.findIndex(current => current.id === panelId);
      const current = currentPanels[currentIndex];
      const currentPrevious = currentIndex > 0 ? currentPanels[currentIndex - 1] : undefined;
      if (!latest || latest.data.operations?.[op] !== 'running' || latest.data.storyRevision !== draft.storyRevision ||
          latest.data.styleId !== draft.styleId || JSON.stringify(latest.data.storyboard) !== JSON.stringify(storyboard) ||
          JSON.stringify(latest.data.characters) !== JSON.stringify(draft.characters) ||
          JSON.stringify(current) !== JSON.stringify(panel) || JSON.stringify(currentPrevious) !== JSON.stringify(previous) ||
          hasNarrativeBlocker(latest.data)) throw new HttpError(409,'Panel inputs changed while rendering; the result was not applied.');
      const updated = commitPanelRender(latest.data,session,panelId,{storyRevision:draft.storyRevision,panelRevision:panel.revision},assetId,'uncertain') as Draft;
      const { [op]: ignored, ...operations } = updated.operations ?? {}; void ignored;
      const checkingPages = updated.pages.map(page => ({...page,panels:page.panels.map(p => p.id === panelId ? {...p,status:'checking' as const} : p)}));
      const { [panelId]: oldReview, ...panelReviews } = updated.panelReviews ?? {}; void oldReview;
      if (store.update(comicId,session,latest.revision,{...updated,pages:checkingPages,panelFindings:{...updated.panelFindings,[panelId]:[]},panelReviews,operations})) { assetCommitted = true; break; }
    }
    if (!assetCommitted) throw new HttpError(409,'Draft changed while saving the panel.');
  } catch (error) {
    if (assetId && !assetCommitted) await discardAsset(assetId);
    const latest = store.getOwned<Draft>(comicId,session);
    if (latest?.data.operations?.[op] === 'running') {
      const operations = {...latest.data.operations};
      if (error instanceof AIError && error.code === 'unknown_outcome') operations[op] = 'unknown_outcome'; else delete operations[op];
      store.update(comicId,session,latest.revision,{...latest.data,operations});
    }
    throw error;
  }
  if (!assetId) throw new Error('Panel image was not saved.');
  // An unsuccessful or uncalibrated review remains uncertain and requires creator acceptance.
  let findings: Awaited<ReturnType<ReturnType<typeof ai>['visualJudge']>>['findings'] = [];
  let outcome: PanelReview['outcome'] = 'failed';
  try {
    const result = await ai().visualJudge({bible:storyboard.bible,styleRules:styleRules(draft.styleId),beats:visualSpec,
      references:[...references,{role:'generated panel',id:panelId,bytes:await asset(assetId),mimeType:'image/png'}]});
    findings = result.findings;
    outcome = result.outcome;
  } catch { /* Keep the image and surface an uncertain result. */ }
  const latest = store.getOwned<Draft>(comicId,session);
  if (!latest) return;
  const current = latest.data.pages.flatMap(p => p.panels).find(p => p.id === panelId);
  if (!current || current.assetId !== assetId || current.storyRevision !== draft.storyRevision || current.revision !== panel.revision + 1 || current.status !== 'checking') return;
  const evaluation = findings.some(f => f.severity === 'blocker') ? 'blocker' : findings.some(f => f.severity === 'warning') ? 'warning' : 'uncertain';
  const pages = latest.data.pages.map(page => ({...page,panels:page.panels.map(p => p.id === panelId ? {...p,evaluation,status:'needs_review' as const,acceptance:null} : p)}));
  const panelFindings = {...latest.data.panelFindings,[panelId]:findings};
  const panelReviews = {...latest.data.panelReviews,[panelId]:{assetId,storyRevision:draft.storyRevision,panelRevision:current.revision,outcome}};
  if (!store.update(comicId,session,latest.revision,{...latest.data,pages,panelFindings,panelReviews})) throw new HttpError(409,'Draft changed while saving the review; refresh and try again.');
}
function xml(value: string): string { if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(value)) throw new HttpError(400,'Dialogue includes a character that cannot be rendered.'); return value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;'); }
async function composePages(draft: Draft): Promise<{id: string; image: Buffer}[]> {
  if (!draft.storyboard) throw new HttpError(409, 'The storyboard is missing.');
  const grid = draft.pageLayout === 'grid';
  const panelWidth = grid ? 480 : 980;
  const panelHeight = grid ? 260 : 420;
  const orderedSpecs = new Map(draft.storyboard.pages.flatMap(p => p.panels).map(p => [p.id,p]));
  const result: {id:string;image:Buffer}[] = [];
  for (const page of draft.pages) {
    const sections: {image:Buffer; lines: string[]}[] = [];
    for (const panel of page.panels) {
      const spec = orderedSpecs.get(panel.id);
      if (!panel.assetId || !spec) throw new HttpError(409, 'A page is missing its current panel.');
      const image = await sharp(await asset(panel.assetId)).resize(panelWidth,panelHeight,{fit:'contain',background:'#fffef8'}).png().toBuffer();
      const lines: string[] = [];
      for (const dialogue of spec.dialogue) {
        const name = draft.characters.find(c => c.id === dialogue.speaker_id)?.name ?? dialogue.speaker_id;
        lines.push(...wrapDialogue(`${name}: ${dialogue.text}`, grid ? 17 : 25));
      }
      sections.push({image,lines});
    }
    const rows = grid ? Array.from({length:Math.ceil(sections.length/2)},(_,i)=>sections.slice(i*2,i*2+2)) : sections.map(section=>[section]);
    const height = 20 + rows.reduce((sum,row) => sum + Math.max(...row.map(s => panelHeight + (s.lines.length ? s.lines.length*30+24 : 0))) + 20,0);
    if (height > 12000) throw new HttpError(400,'The page has too much dialogue to compose.');
    const composites: {input:Buffer;top:number;left:number}[] = [];
    let y = 20;
    for (const row of rows) {
      let rowHeight = panelHeight;
      row.forEach((section,column) => {
        const x = 20 + column * (panelWidth + 20);
        composites.push({input:section.image,top:y,left:x});
        if (section.lines.length) {
          const h = section.lines.length*30+24;
          const lines = section.lines.map((line,i) => `<text x="12" y="${26+i*30}" font-family="sans-serif" font-size="22" fill="#171717" xml:space="preserve">${xml(line)}</text>`).join('');
          const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${panelWidth}" height="${h}"><rect width="${panelWidth}" height="${h}" fill="white" stroke="#171717" stroke-width="3"/>${lines}</svg>`);
          composites.push({input:svg,top:y+panelHeight,left:x});
          rowHeight = Math.max(rowHeight,panelHeight+h);
        }
      });
      y += rowHeight + 20;
    }
    const image = await sharp({create:{width:1020,height,channels:4,background:'#fff8e8'}}).composite(composites).png().toBuffer();
    result.push({id:page.id,image});
  }
  return result;
}
function aiUnavailable() { throw new HttpError(503, 'AI generation is not configured yet. Add an OpenAI API key to the local environment and complete the AI integration.'); }
// Host validation mitigates DNS rebinding; the loopback server binding is the network boundary.
function ensureLocal(request: NextRequest) {
  const rawHost = request.headers.get('host') ?? request.nextUrl.host;
  let parsedHost: URL;
  try { parsedHost = new URL(`${request.nextUrl.protocol}//${rawHost}`); } catch { throw new HttpError(403, 'Invalid local host.'); }
  const validHost = ['localhost','127.0.0.1','[::1]'].includes(parsedHost.hostname) && !parsedHost.username && !parsedHost.password && parsedHost.host === rawHost && parsedHost.port === request.nextUrl.port;
  if (process.env.VERCEL || !validHost) throw new HttpError(403, 'Local storage is available only on localhost.');
}
export async function handleApi(request: NextRequest, segments: string[]) {
  try {
    ensureLocal(request);
    const store = getStore();
    const method = request.method;
    if (segments[0] === 'auth') {
      if (segments.length === 2 && segments[1] === 'session' && method === 'GET') {
        const token = request.cookies.get('comex_auth')?.value;
        const identity = token && /^[a-f0-9]{64}$/.test(token) ? store.authIdentity(token) : null;
        const guestToken=request.cookies.get('comex_session')?.value;
        const guest=guestToken && /^[a-f0-9]{64}$/.test(guestToken) ? store.guestIdentity(guestToken) : null;
        return reply({user: identity ? {email: identity.email} : null, guest:guest ? {email:guest.email} : null});
      }
      // Require Origin for these endpoints; never derive an email link from the Host header.
      const requestOrigin = `${request.nextUrl.protocol}//${request.headers.get('host') ?? request.nextUrl.host}`;
      if (method === 'POST' && (!request.headers.get('origin') || request.headers.get('origin') !== requestOrigin)) throw new HttpError(403, 'Cross-origin requests are not allowed.');
      if (segments.length === 2 && segments[1] === 'request' && method === 'POST') {
        const {email: rawEmail,claimGuest} = await input(request, z.object({email:z.string().trim().email().max(254),claimGuest:z.boolean().optional()}).strict());
        const at = rawEmail.lastIndexOf('@');
        const email = `${rawEmail.slice(0,at)}@${rawEmail.slice(at+1).toLowerCase()}`;
        const configuredUrl=process.env.COMEX_APP_URL, apiKey=process.env.RESEND_API_KEY, from=process.env.COMEX_EMAIL_FROM, secret=process.env.COMEX_AUTH_SECRET;
        if (!configuredUrl || !apiKey || !from || !secret || secret.length<32) throw new HttpError(503,'Email sign-in is not configured yet.');
        let base:URL;
        try {base=new URL(configuredUrl);} catch {throw new HttpError(503,'Email sign-in is not configured yet.');}
        if ((base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(base.hostname))) || base.username || base.password || base.pathname !== '/' || base.search || base.hash || base.origin !== requestOrigin) throw new HttpError(503,'Email sign-in is not configured for this address.');
        const existingBrowser=request.cookies.get('comex_login')?.value;
        const browser=existingBrowser && /^[a-f0-9]{64}$/.test(existingBrowser) ? existingBrowser : randomBytes(32).toString('hex');
        const guestToken=request.cookies.get('comex_session')?.value;
        const validGuestToken=guestToken && /^[a-f0-9]{64}$/.test(guestToken) ? guestToken : null;
        // An explicit choice from the browser owning the guest cookie permits
        // correcting its email; account access still requires the emailed code.
        if (claimGuest && (!validGuestToken || !store.updateGuestEmail(validGuestToken,email))) throw new HttpError(409,'This browser draft session has expired.');
        const guestIdentity=validGuestToken ? store.guestIdentity(validGuestToken) : null;
        const mayClaim=!!validGuestToken && (guestIdentity ? guestIdentity.email===email : !store.hasGuestToken(validGuestToken) && store.hasLegacyOwner(validGuestToken));
        // The existing guest cookie is stable across simultaneous requests,
        // unlike login cookies whose responses can arrive out of order.
        const claimProof=mayClaim ? validGuestToken! : browser;
        const code=randomInt(100000000).toString().padStart(8,'0');
        const issued=store.issueCode(email,code,claimProof,secret);
        if (!issued) throw new HttpError(429,'Too many sign-in requests. Please try again later.');
        let delivered=false, knownRejected=false;
        try {
          const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},body:JSON.stringify({from,to:[email],subject:'Your Comex sign-in code',text:`Your Comex sign-in code is ${code}. It expires in 15 minutes.\n\nIf you did not request it, ignore this email.`})});
          delivered=response.ok;
          knownRejected=response.status>=400 && response.status<500 && response.status!==408;
        } catch { /* Never log credentials or codes. */ }
        if (!delivered) {store.invalidateCode(email,issued,knownRejected);throw new HttpError(502,'Could not send the sign-in email. Please try again.');}
        const response=reply({message:'If the address can receive email, a sign-in code is on its way.'});
        response.cookies.set('comex_login',browser,{httpOnly:true,sameSite:'lax',secure:base.protocol==='https:',path:'/',maxAge:15*60});
        return response;
      }
      if (segments.length === 2 && segments[1] === 'verify' && method === 'POST') {
        const {email:rawEmail,code}=await input(request,z.object({email:z.string().trim().email().max(254),code:z.string().regex(/^\d{8}$/)}).strict());
        const at=rawEmail.lastIndexOf('@'); const email=`${rawEmail.slice(0,at)}@${rawEmail.slice(at+1).toLowerCase()}`;
        const secret=process.env.COMEX_AUTH_SECRET;
        if (!secret || secret.length<32) throw new HttpError(503,'Email sign-in is not configured yet.');
        const browser=request.cookies.get('comex_login')?.value, guest=request.cookies.get('comex_session')?.value;
        const validGuest=guest && /^[a-f0-9]{64}$/.test(guest) ? guest : null;
        const identity=validGuest ? store.guestIdentity(validGuest) : null;
        const anonymous=validGuest ? identity ? identity.email===email ? identity.owner : null : !store.hasGuestToken(validGuest) && store.hasLegacyOwner(validGuest) ? validGuest : null : null;
        const claimProof=anonymous && validGuest ? validGuest : browser && /^[a-f0-9]{64}$/.test(browser) ? browser : null;
        const result=store.consumeCode(email,code,secret,claimProof,anonymous);
        if (!result) throw new HttpError(400,'This code is invalid, expired, or has already been used. Request a new code.');
        const response=reply({user:{email:result.email}});
        response.cookies.set('comex_auth',result.session,{httpOnly:true,sameSite:'lax',secure:request.nextUrl.protocol==='https:',path:'/',maxAge:30*24*60*60});
        if (result.sameBrowser) {
          response.cookies.set('comex_login','',{httpOnly:true,sameSite:'lax',secure:request.nextUrl.protocol==='https:',path:'/',maxAge:0});
          if (anonymous) response.cookies.set('comex_session','',{httpOnly:true,sameSite:'strict',secure:request.nextUrl.protocol==='https:',path:'/',maxAge:0});
        }
        return response;
      }
      if (segments.length === 2 && segments[1] === 'sign-out' && method === 'POST') {
        await input(request,z.object({}).strict());
        const token = request.cookies.get('comex_auth')?.value;
        if (token && /^[a-f0-9]{64}$/.test(token)) store.signOut(token);
        const response = reply({ok:true});
        response.cookies.set('comex_auth','',{httpOnly:true,sameSite:'lax',secure:request.nextUrl.protocol === 'https:',path:'/',maxAge:0});
        return response;
      }
      throw new HttpError(404, 'Not found.');
    }
    if (segments[0] === 'published' && method === 'GET') {
      if (segments.length === 4 && segments[2] === 'assets') {
        const edition = store.getPublished<Edition>(segments[1]);
        if (!edition || request.nextUrl.searchParams.get('edition') !== edition.editionId) throw new HttpError(404, 'This edition is unavailable. Reload the comic.');
        const imageUrl = `/api/published/${encodeURIComponent(edition.id)}/assets/${encodeURIComponent(segments[3])}?edition=${encodeURIComponent(edition.editionId)}`;
        const page = edition.pages.find(p => p.imageUrl === imageUrl);
        if (!page) throw new HttpError(404, 'Image not found.');
        // Older editions used files. New editions and their images commit together in SQLite.
        const bytes = page.storage === 'sqlite' ? store.getPublicationAsset(edition.id, segments[3]) : await asset(segments[3]);
        if (!bytes) throw new HttpError(404, 'Image not found.');
        return new NextResponse(new Uint8Array(bytes), {headers: {'Content-Type':'image/png', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff'}});
      }
      if (segments.length === 1) {
        const comics = store.listPublished<Edition>().map(e => ({id: e.id, title: e.title, creator: e.creator, pageCount: e.pages.length, coverUrl: e.pages[0]?.imageUrl ?? null}));
        return reply({comics});
      }
      if (segments.length === 2) {
        const edition = store.getPublished<Edition>(segments[1]);
        if (!edition) throw new HttpError(404, 'This comic is unavailable.');
        return reply({comic: {id: edition.id, title: edition.title, creator: edition.creator, editionId: edition.editionId, pages: edition.pages.map(({id,imageUrl}) => ({id,imageUrl}))}});
      }
    }
    if (segments[0] !== 'comics') throw new HttpError(404, 'Not found.');
    if (segments.length === 1 && method === 'GET') {
      const session = owner(request);
      if (!session) throw new HttpError(401, 'Sign in to see your drafts.');
      return reply({comics: store.listOwned<Draft>(session).map(d => ({id: d.id, title: d.title, plot: d.plot, published: !!store.getPublished<Edition>(d.id)}))});
    }
    if (segments.length === 1 && method === 'POST') {
      const body = await input(request, createSchema);
      let session = owner(request);
      let guestToken: string | null = null;
      if (!session) {
        if (!body.email) throw new HttpError(401, 'Enter your email to start creating.');
        const at=body.email.lastIndexOf('@'); const email=`${body.email.slice(0,at)}@${body.email.slice(at+1).toLowerCase()}`;
        const guest=store.createGuest(email); session=guest.owner; guestToken=guest.token;
      }
      const id = randomUUID();
      const draft: Draft = {...createBlankComic(id, session), title: body.title, plot: body.plot, styleId: body.style, characters: [], answers: {}, questions: [], initialQuestions:'pending',initialSuggestions:'pending'};
      store.create(id, session, draft);
      const response=reply({comic: {id}}, 201);
      if (guestToken) response.cookies.set('comex_session',guestToken,{httpOnly:true,sameSite:'strict',secure:request.nextUrl.protocol==='https:',path:'/',maxAge:30*24*60*60});
      return response;
    }
    if (segments.length < 2) throw new HttpError(404, 'Not found.');
    const id = segments[1];
    const {session, data, revision} = owned(request, id);
    if (segments[2] === 'assets' && segments.length === 4 && method === 'GET') {
      const assetId = segments[3];
      if (!data.characters.some(c => c.referenceAssetId === assetId) && !data.pages.some(page => page.panels.some(p => p.assetId === assetId))) throw new HttpError(404, 'Image not found.');
      return new NextResponse(new Uint8Array(await asset(assetId)), {headers: {'Content-Type':'image/png', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff'}});
    }
    if (segments.length === 2 && method === 'GET') return reply({comic: view(data, store.getPublished<Edition>(id), revision)});
    if (segments.length === 2 && method === 'PATCH') {
      const body = await input(request, patchSchema);
      if (data.pages.length && ((body.plot !== undefined && body.plot !== data.plot) || (body.style !== undefined && body.style !== data.styleId) || (body.answers !== undefined && JSON.stringify(body.answers) !== JSON.stringify(data.answers))))
        throw new HttpError(409, 'Change the story through the revision flow so later pages can be updated.');
      if (data.pages.length && body.panelsPerPage !== undefined && body.panelsPerPage !== (data.panelsPerPage ?? 3)) throw new HttpError(409, 'Choose the number of panels before planning the story.');
      const updated: Draft = {...data, title: body.title ?? data.title, plot: body.plot ?? data.plot, styleId: body.style ?? data.styleId, answers: body.answers ?? data.answers, panelsPerPage:body.panelsPerPage ?? data.panelsPerPage, pageLayout:body.pageLayout ?? data.pageLayout};
      return reply({comic: save(store, session, revision, updated)});
    }
    if (segments[2] === 'questions' && segments[3] === 'initial' && segments.length === 4 && method === 'POST') {
      await input(request, z.object({}).strict());
      if (data.initialQuestions !== 'pending') return reply({comic:view(data,store.getPublished<Edition>(id),revision)});
      return await withTextOperation(store,session,id,revision,async () => {
        if (!store.update(id,session,revision,{...data,initialQuestions:'running'})) throw new HttpError(409,'Draft changed before asking questions.');
        try {
          const generated = await ai().questions({plot:data.plot,style:data.styleId,answers:answeredQuestions(data),limit:5});
          const seen = new Set<string>();
          const questions = generated.filter(question => {const key=question.question.trim().toLocaleLowerCase('en-US');if(seen.has(key))return false;seen.add(key);return true;}).map(question => ({...question,id:randomUUID()}));
          for (let attempt=0;attempt<3;attempt++) {
            const latest=store.getOwned<Draft>(id,session);
            if (!latest || latest.data.initialQuestions !== 'running' || latest.data.plot !== data.plot || latest.data.styleId !== data.styleId || JSON.stringify(latest.data.questions) !== JSON.stringify(data.questions) || JSON.stringify(latest.data.answers) !== JSON.stringify(data.answers)) throw new HttpError(409,'Story changed while finding questions.');
            const updated={...latest.data,questions,initialQuestions:'complete' as const};
            if (store.update(id,session,latest.revision,updated)) return reply({comic:view(updated,store.getPublished<Edition>(id),latest.revision+1)});
          }
          throw new HttpError(409,'Draft changed while saving questions.');
        } catch(error) {
          const latest=store.getOwned<Draft>(id,session);
          if (latest?.data.initialQuestions === 'running') {
            const unknown=error instanceof AIError && (error.code === 'unknown_outcome' || error.code === 'invalid_response');
            store.update(id,session,latest.revision,{...latest.data,initialQuestions:unknown?'unknown':'failed'});
          }
          throw error;
        }
      });
    }
    if (segments[2] === 'questions' && segments.length === 3 && method === 'POST') {
      await input(request, z.object({}).strict());
      try { return await withTextOperation(store,session,id,revision,async () => {
      const answered = data.questions.filter(question => data.answers[question.id]?.trim());
      const limit = Math.max(0, 5 - answered.length);
      const additions = limit ? await ai().questions({plot:data.plot, style:data.styleId, answers:answeredQuestions(data), limit}) : [];
      const seen = new Set(answered.map(question => question.question.trim().toLocaleLowerCase('en-US')));
      const questions = [...answered];
      for (const question of additions) {
        const key = question.question.trim().toLocaleLowerCase('en-US');
        if (!seen.has(key)) { seen.add(key); questions.push({...question,id:randomUUID()}); }
      }
      const answers = Object.fromEntries(answered.map(question => [question.id,data.answers[question.id]]));
      return reply({comic: save(store, session, revision, {...data, questions, answers, initialQuestions:'complete'})});
      }); } catch(error) {
        if (error instanceof AIError && (error.code === 'unknown_outcome' || error.code === 'invalid_response')) {
          const latest=store.getOwned<Draft>(id,session);
          if (latest) store.update(id,session,latest.revision,{...latest.data,initialQuestions:'unknown'});
        }
        throw error;
      }
    }
    if (segments[2] === 'characters' && segments[3] === 'suggestions' && segments.length === 4 && method === 'POST') {
      const body = await input(request,z.object({retry:z.boolean().optional()}).strict());
      if (data.pages.length) throw new HttpError(409,'Character changes require a story revision.');
      if (data.initialQuestions === 'running' || data.initialQuestions === 'pending') throw new HttpError(409,'Wait for story questions first.');
      if (data.initialSuggestions === 'unknown') throw new HttpError(409,'Resolve the previous character suggestion request before trying again.');
      if (data.initialSuggestions === 'running' || (data.initialSuggestions === 'complete' && !body.retry)) return reply({comic:view(data,store.getPublished<Edition>(id),revision)});
      if (data.initialSuggestions !== 'pending' && !body.retry) return reply({comic:view(data,store.getPublished<Edition>(id),revision)});
      return await withTextOperation(store,session,id,revision,async () => {
        if (!store.update(id,session,revision,{...data,initialSuggestions:'running'})) throw new HttpError(409,'Draft changed before suggesting characters.');
        try {
          const generated = await ai().characterSuggestions({plot:data.plot,style:data.styleId,answers:answeredQuestions(data),existingCharacters:data.characters.map(({name,role}) => ({name,role}))});
          const seen=new Set<string>();
          const characterSuggestions=generated.filter(card => {const key=card.name.toLocaleLowerCase('en-US');if(seen.has(key))return false;seen.add(key);return true;}).map(card => ({id:randomUUID(),...card}));
          for (let attempt=0;attempt<3;attempt++) {
            const latest=store.getOwned<Draft>(id,session);
            if (!latest || latest.data.initialSuggestions !== 'running' || latest.data.pages.length || latest.data.plot !== data.plot || latest.data.styleId !== data.styleId || JSON.stringify(latest.data.questions) !== JSON.stringify(data.questions) || JSON.stringify(latest.data.answers) !== JSON.stringify(data.answers)) throw new HttpError(409,'Story changed while suggesting characters.');
            const updated={...latest.data,characterSuggestions,initialSuggestions:'complete' as const};
            if (store.update(id,session,latest.revision,updated)) return reply({comic:view(updated,store.getPublished<Edition>(id),latest.revision+1)});
          }
          throw new HttpError(409,'Draft changed while saving character suggestions.');
        } catch(error) {
          const latest=store.getOwned<Draft>(id,session);
          if (latest?.data.initialSuggestions === 'running') {
            const unknown=error instanceof AIError && (error.code === 'unknown_outcome' || error.code === 'invalid_response');
            store.update(id,session,latest.revision,{...latest.data,initialSuggestions:unknown?'unknown':'failed'});
          }
          throw error;
        }
      });
    }
    if (segments[2] === 'story' && segments[3] === 'accept' && segments.length === 4 && method === 'POST') {
      const body = await input(request,z.object({fingerprint:z.string().regex(/^[a-f0-9]{64}$/)}).strict());
      const fingerprint = narrativeFingerprint(data);
      if (!fingerprint || body.fingerprint !== fingerprint || !rawNarrativeBlocker(data) || !data.storyReview || typeof data.storyReview !== 'object' || !('outcome' in data.storyReview) || data.storyReview.outcome !== 'findings') throw new HttpError(409,'This story review has changed or is not eligible for acceptance.');
      return await withTextOperation(store,session,id,revision,async () => reply({comic:save(store,session,revision,{...data,storyReviewAcceptance:fingerprint})}));
    }
    if (segments[2] === 'story' && segments[3] === 'plan' && segments.length === 4 && method === 'POST') {
      await input(request, z.object({}).strict());
      if (data.pages.length) throw new HttpError(409, 'Use story revision to change existing pages.');
      if (!data.characters.length || data.characters.some(c => !c.approved || !c.referenceAssetId)) throw new HttpError(409, 'Approve reference images for every selected character first.');
      if (data.characters.some(c => data.operations?.[`character:${c.id}`])) throw new HttpError(409, 'Resolve character reference requests before planning the story.');
      return await withTextOperation(store,session,id,revision,async () => {
      const generated = await ai().storyboard({plot:data.plot, answers:answeredQuestions(data), styleRules:styleRules(data.styleId), characters:data.characters, pageCount:3, panelsPerPage:data.panelsPerPage ?? 3});
      const storyboard = {...generated,pages:generated.pages.map(page => ({...page,panels:page.panels.map(normalizePanelLedger)}))};
      const ledgerErrors = validateStoryLedger(storyboard);
      if (ledgerErrors.length) throw new HttpError(422, `Story state needs correction: ${ledgerErrors[0]}`);
      const planned = createComic({id, ownerId:session, title:data.title, creatorName:data.creatorName, plot:data.plot, styleId:data.styleId,
        pages:storyboard.pages.map(p => ({id:randomUUID(), panels:p.panels.map(panel => ({id:panel.id, beat:panel.action}))}))});
      let storyReview: unknown;
      try { storyReview = await ai().narrativeJudge({creatorGoal:data.plot,answers:answeredQuestions(data),bible:storyboard.bible,beats:storyboard.pages}); }
      catch (error) { storyReview = inconclusiveReview(error); }
      return reply({comic: save(store, session, revision, {...data, ...planned, storyboard, storyReview, storyReviewAcceptance:undefined})});
      });
    }
    if (segments[2] === 'characters' && segments.length === 5 && segments[4] === 'reference' && method === 'POST') {
      await input(request, z.object({}).strict());
      if (data.pages.length) throw new HttpError(409, 'Character changes require a story revision.');
      const character = data.characters.find(c => c.id === segments[3]);
      if (!character) throw new HttpError(404, 'Character not found.');
      const op = `character:${character.id}`;
      if (data.operations?.[op]) throw new HttpError(409, 'This image request is already running or has an unknown outcome.');
      const reserved: Draft = {...data, operations:{...data.operations,[op]:'running'}};
      if (!store.update(id, session, revision, reserved)) throw new HttpError(409, 'Draft changed; refresh and try again.');
      let assetId: string | undefined;
      let assetCommitted = false;
      try {
        const bytes = await ai().characterReference({character,styleRules:styleRules(data.styleId)});
        assetId = await saveAsset(bytes);
        for (let attempt = 0; attempt < 3; attempt++) {
          const latest = store.getOwned<Draft>(id,session);
          const current = latest?.data.characters.find(c => c.id === character.id);
          if (!latest || latest.data.operations?.[op] !== 'running' || latest.data.pages.length || latest.data.styleId !== data.styleId || JSON.stringify(current) !== JSON.stringify(character))
            throw new HttpError(409, 'Character inputs changed while rendering; the result was not applied.');
          const { [op]: ignored, ...operations } = latest.data.operations ?? {}; void ignored;
          const characters = latest.data.characters.map(c => c.id === character.id ? {...c, approved:false, referenceAssetId:assetId, referenceUrl:`/api/comics/${encodeURIComponent(id)}/assets/${assetId}`} : c);
          const updated = {...latest.data,characters,operations};
          if (store.update(id,session,latest.revision,updated)) {
            assetCommitted = true;
            return reply({comic:view(updated,store.getPublished<Edition>(id),latest.revision + 1)});
          }
        }
        throw new HttpError(409, 'Draft changed while saving the reference.');
      } catch (error) {
        if (assetId && !assetCommitted) await discardAsset(assetId);
        const latest = store.getOwned<Draft>(id,session);
        if (latest?.data.operations?.[op] === 'running') {
          const operations = {...latest.data.operations};
          if (error instanceof AIError && error.code === 'unknown_outcome') operations[op] = 'unknown_outcome'; else delete operations[op];
          store.update(id,session,latest.revision,{...latest.data,operations});
        }
        throw error;
      }
    }
    if (segments[2] === 'characters' && segments.length === 3 && method === 'POST') {
      const body = await input(request, characterSchema);
      if (data.pages.length) throw new HttpError(409, 'Revise the story before changing characters on planned pages.');
      const character: Character = {...body, id: randomUUID(), approved: false};
      return reply({comic: save(store, session, revision, {...data, characters: [...data.characters, character]})});
    }
    if (segments[2] === 'characters' && segments.length === 4 && (method === 'PATCH' || method === 'DELETE')) {
      const body = method === 'PATCH' ? await input(request, characterSchema) : await input(request, z.object({}).strict());
      if (data.pages.length) throw new HttpError(409, 'Character changes require a story revision.');
      const character = data.characters.find(c => c.id === segments[3]);
      if (!character) throw new HttpError(404, 'Character not found.');
      if (data.operations?.[`character:${character.id}`]) throw new HttpError(409, 'Wait until the character reference request is resolved before changing this card.');
      if (method === 'DELETE') return reply({comic: save(store, session, revision, {...data, characters: data.characters.filter(c => c.id !== character.id)})});
      const values = body as z.infer<typeof characterSchema>;
      const changed = (['name','role','appearance','outfit'] as const).some(key => values[key] !== character[key]);
      const replacement = changed ? {id:character.id, ...values, approved:false} : character;
      return reply({comic: save(store, session, revision, {...data, characters: data.characters.map(c => c.id === character.id ? replacement : c)})});
    }
    if (segments[2] === 'characters' && segments.length === 5 && segments[4] === 'approve' && method === 'POST') {
      const {assetId} = await input(request, z.object({assetId:z.string().uuid()}).strict());
      const character = data.characters.find(c => c.id === segments[3]);
      if (!character) throw new HttpError(404, 'Character not found.');
      if (data.operations?.[`character:${character.id}`]) throw new HttpError(409, 'Resolve the character reference request before approval.');
      if (!character.referenceUrl || !character.referenceAssetId) throw new HttpError(409, 'Create a reference image before approval.');
      if (character.referenceAssetId !== assetId) throw new HttpError(409, 'This reference changed since you reviewed it. Refresh and review the current image.');
      return reply({comic: save(store, session, revision, {...data, characters: data.characters.map(c => c.id === character.id ? {...c, approved: true} : c)})});
    }
    if (segments[2] === 'revisions' && segments[3] === 'preview' && segments.length === 4 && method === 'POST') {
      const body = await input(request, z.object({panelId:short,instruction:z.string().trim().min(1).max(4000),reviewedVersion:panelVersionSchema.optional()}).strict());
      if (!data.storyboard) throw new HttpError(409,'Plan the story before revising it.');
      if (body.reviewedVersion) {
        const reviewed = data.pages.flatMap(page => page.panels).find(panel => panel.id === body.panelId);
        if (!reviewed || reviewed.assetId !== body.reviewedVersion.assetId || reviewed.storyRevision !== body.reviewedVersion.storyRevision || reviewed.revision !== body.reviewedVersion.panelRevision || data.storyRevision !== body.reviewedVersion.storyRevision) throw new HttpError(409, 'This panel changed since you viewed it. Refresh and review the current image.');
      }
      const currentStoryboard = data.storyboard;
      return await withTextOperation(store,session,id,revision,async () => {
      const generated = await ai().revision({storyboard:currentStoryboard,firstPanelId:body.panelId,instruction:body.instruction,characters:data.characters});
      const result = {...generated,revised_suffix:generated.revised_suffix.map(normalizePanelLedger)};
      const changed = new Map(result.revised_suffix.map(panel => [panel.id,panel]));
      const proposed: Storyboard = {...currentStoryboard,bible:result.revised_bible,pages:currentStoryboard.pages.map(page => ({...page,panels:page.panels.map(panel => changed.get(panel.id) ?? panel)}))};
      const errors = validateStoryLedger(proposed);
      if (errors.length) throw new HttpError(422, `Revised story state needs correction: ${errors[0]}`);
      const pageIndex = data.pages.findIndex(page => page.panels.some(panel => panel.id === result.earliest_affected_panel_id));
      if (pageIndex < 0) throw new HttpError(422,'Revision points to a missing panel.');
      const affectedPanel = data.pages[pageIndex].panels.findIndex(panel => panel.id === result.earliest_affected_panel_id) + 1;
      const proposal = {id:randomUUID(),baseRevision:revision+1,result};
      if (!store.update(id,session,revision,{...data,pendingRevision:proposal})) throw new HttpError(409,'Draft changed while planning the revision; refresh and try again.');
      return reply({proposal:{id:proposal.id,earliestPanelId:result.earliest_affected_panel_id,affectedPage:pageIndex+1,affectedPanel,explanation:result.explanation}});
      });
    }
    if (segments[2] === 'revisions' && segments.length === 3 && method === 'POST') {
      const body = await input(request,z.object({proposalId:short}).strict());
      const proposal = data.pendingRevision;
      if (!proposal || proposal.id !== body.proposalId || proposal.baseRevision !== revision || !data.storyboard) throw new HttpError(409,'Revision preview expired. Preview the changes again.');
      const next = await withTextOperation(store,session,id,revision,async () => {
      const changed = new Map(proposal.result.revised_suffix.map(panel => [panel.id,panel]));
      const storyboard: Storyboard = {...data.storyboard!,bible:proposal.result.revised_bible,pages:data.storyboard!.pages.map(page => ({...page,panels:page.panels.map(panel => changed.get(panel.id) ?? panel)}))};
      const errors = validateStoryLedger(storyboard);
      if (errors.length) throw new HttpError(422, `Revised story state needs correction: ${errors[0]}`);
      const beats = Object.fromEntries(proposal.result.revised_suffix.map(panel => [panel.id,panel.action]));
      const updated = reviseStory(data,session,data.storyRevision,proposal.result.earliest_affected_panel_id,beats) as Draft;
      let storyReview: unknown;
      try { storyReview = await ai().narrativeJudge({creatorGoal:data.plot,answers:answeredQuestions(data),bible:storyboard.bible,beats:storyboard.pages}); }
      catch (error) { storyReview = inconclusiveReview(error); }
      const next: Draft = {...updated,storyboard,storyReview,storyReviewAcceptance:undefined,pendingRevision:undefined,pageOperations:undefined};
      if (!store.update(id,session,revision,next)) throw new HttpError(409,'Draft changed while applying revision; preview it again.');
      return next;
      });
      const firstPage = next.pages.findIndex(page => page.panels.some(panel => panel.id === proposal.result.earliest_affected_panel_id));
      const previousPageReady = firstPage === 0 || next.pages[firstPage-1].panels.every(p => p.storyRevision === next.storyRevision && isPanelReady(p));
      let pausedNotice = '';
      if (previousPageReady && !hasNarrativeBlocker(next)) {
        const pagePanels = next.pages[firstPage].panels;
        const affected = pagePanels.findIndex(panel => panel.id === proposal.result.earliest_affected_panel_id);
        const firstIncomplete = pagePanels.findIndex(panel => !panel.assetId || panel.status === 'outdated' || panel.status === 'planned');
        const first = firstIncomplete >= 0 ? Math.min(firstIncomplete, affected) : affected;
        for (const panel of pagePanels.slice(first)) {
          try { await renderPanel(store,session,id,panel.id); }
          catch { pausedNotice = 'Story change saved, but artwork did not finish. Review the page and resolve any outstanding operation before continuing.'; break; }
          const currentPanel = store.getOwned<Draft>(id,session)?.data.pages[firstPage].panels.find(p => p.id === panel.id);
          if (!currentPanel || (currentPanel.evaluation === 'blocker' && !isPanelReady(currentPanel))) {
            pausedNotice = 'Story change saved. Review the panel blocker before continuing the page.';
            break;
          }
        }
      }
      const latest = store.getOwned<Draft>(id,session)!;
      return reply({comic:view(latest.data,store.getPublished<Edition>(id),latest.revision),notice:pausedNotice || (hasNarrativeBlocker(next) ? 'Resolve the story review blockers before generating artwork.' : 'Later pages remain outdated until you review the preceding page and generate them.')});
    }
    if (segments[2] === 'pages' && segments.length === 5 && segments[4] === 'download' && method === 'GET') {
      const page = data.pages.find(p => p.id === segments[3]);
      if (!page) throw new HttpError(404, 'Page not found.');
      if (!page.panels.length || page.panels.some(p => !p.assetId || p.storyRevision !== data.storyRevision || !isPanelReady(p))) throw new HttpError(409,'Generate and review every panel on this page before downloading.');
      const [composed] = await composePages({...data,pages:[page]});
      if (store.getOwned<Draft>(id,session)?.revision !== revision) throw new HttpError(409,'Draft changed while composing; try again.');
      return new NextResponse(new Uint8Array(composed.image),{headers:{'Content-Type':'image/png','Content-Disposition':`attachment; filename="comex-page-${encodeURIComponent(page.id)}.png"`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
    }
    if (segments[2] === 'pages' && segments.length === 5 && segments[4] === 'generate' && method === 'POST') {
      await input(request, z.object({}).strict());
      requireClearNarrative(data);
      const pageIndex = data.pages.findIndex(p => p.id === segments[3]);
      if (pageIndex < 0) throw new HttpError(404, 'Page not found.');
      if (pageIndex > 0 && data.pages[pageIndex-1].panels.some(p => p.storyRevision !== data.storyRevision || !isPanelReady(p))) throw new HttpError(409, 'Review and accept the preceding page first.');
      const requestedPage = data.pages[pageIndex];
      if (requestedPage.panels.some(p => p.status === 'checking')) throw new HttpError(409, 'Wait for the panel review to finish.');
      let operation = data.pageOperations?.[requestedPage.id];
      if (operation && operation.storyRevision !== data.storyRevision) operation = undefined;
      if (!operation) {
        // A complete page click explicitly regenerates all panels. An incomplete page resumes missing/outdated panels.
        const fullyRendered = requestedPage.panels.every(p => !!p.assetId && p.storyRevision === data.storyRevision && (p.status === 'current' || p.status === 'needs_review'));
        const firstIncomplete = requestedPage.panels.findIndex(p => !p.assetId || p.storyRevision !== data.storyRevision || !['current','needs_review'].includes(p.status));
        const targets = fullyRendered ? requestedPage.panels : requestedPage.panels.slice(firstIncomplete);
        operation = {storyRevision:data.storyRevision,baseline:Object.fromEntries(targets.map(p => [p.id,p.revision]))};
        if (!store.update(id,session,revision,{...data,pageOperations:{...data.pageOperations,[requestedPage.id]:operation}})) throw new HttpError(409,'Draft changed; refresh and try again.');
      }
      for (const [panelId,baseline] of Object.entries(operation.baseline)) {
        const current = store.getOwned<Draft>(id,session);
        if (!current || current.data.storyRevision !== operation.storyRevision) throw new HttpError(409,'Story changed while drawing the page.');
        const panel = current.data.pages.flatMap(p => p.panels).find(p => p.id === panelId);
        if (!panel) throw new HttpError(409,'Panel no longer exists.');
        if (panel.revision !== baseline) {
          if (panel.evaluation === 'blocker' && !isPanelReady(panel)) return reply({comic:view(current.data,store.getPublished<Edition>(id),current.revision),notice:'Page generation paused. Repair or explicitly accept the flagged panel before continuing.'});
          if (panel.storyRevision === operation.storyRevision && panel.assetId && ['current','needs_review'].includes(panel.status)) continue;
          throw new HttpError(409,'Panel changed while drawing the page.');
        }
        await renderPanel(store,session,id,panelId);
        const reviewed = store.getOwned<Draft>(id,session);
        const finishedPanel = reviewed?.data.pages.flatMap(p => p.panels).find(p => p.id === panelId);
        if (reviewed && finishedPanel?.evaluation === 'blocker' && !isPanelReady(finishedPanel)) return reply({comic:view(reviewed.data,store.getPublished<Edition>(id),reviewed.revision),notice:'Page generation paused. Repair or explicitly accept the flagged panel before continuing.'});
      }
      const latest = store.getOwned<Draft>(id,session)!;
      const { [requestedPage.id]: finished, ...pageOperations } = latest.data.pageOperations ?? {}; void finished;
      if (!store.update(id,session,latest.revision,{...latest.data,pageOperations})) throw new HttpError(409,'Draft changed; refresh to see page progress.');
      return reply({comic:view(latest.data,store.getPublished<Edition>(id),latest.revision+1)});
    }
    if (segments[2] === 'panels' && segments.length === 5 && segments[4] === 'edit' && method === 'POST') {
      const body = await input(request,z.union([
        panelVersionSchema.extend({instruction:z.string().trim().min(1).max(2000)}).strict(),
        z.object({proposalId:z.string().uuid(),decision:z.literal('artwork_only')}).strict(),
      ]));
      requireClearNarrative(data);
      const panel = data.pages.flatMap(page => page.panels).find(panel => panel.id === segments[3]);
      if (!panel || !panel.assetId || panel.storyRevision !== data.storyRevision || (panel.status === 'outdated' || panel.status === 'checking')) throw new HttpError(409,'Generate the current panel before editing its artwork.');
      let instruction:string, reviewed:z.infer<typeof panelVersionSchema>;
      if ('proposalId' in body) {
        const proposal=data.pendingArtworkDecision;
        if (!proposal || proposal.id !== body.proposalId || proposal.panelId !== panel.id || proposal.expiresAt <= Date.now()) throw new HttpError(409,'This edit choice has expired. Review the edit again.');
        reviewed={assetId:proposal.assetId,storyRevision:proposal.storyRevision,panelRevision:proposal.panelRevision}; instruction=proposal.instruction;
        if (panel.assetId !== reviewed.assetId || panel.revision !== reviewed.panelRevision || panel.storyRevision !== reviewed.storyRevision) throw new HttpError(409,'This panel changed since you viewed it. Refresh and review the current image.');
        const {pendingArtworkDecision: _, ...rest}=data; void _;
        if (!store.update(id,session,revision,rest)) throw new HttpError(409,'This draft changed. Refresh and review the edit again.');
      } else {
        reviewed={assetId:body.assetId,storyRevision:body.storyRevision,panelRevision:body.panelRevision}; instruction=body.instruction;
        if (panel.assetId !== reviewed.assetId || panel.revision !== reviewed.panelRevision || panel.storyRevision !== reviewed.storyRevision) throw new HttpError(409,'This panel changed since you viewed it. Refresh and review the current image.');
        const spec=data.storyboard?.pages.flatMap(page=>page.panels).find(item=>item.id===panel.id);
        const intent=await withTextOperation(store,session,id,revision,async()=>{
          const decision=await ai().classifyEdit({instruction,panelContext:JSON.stringify({beat:panel.beat,bible:data.storyboard?.bible,scene:spec})});
          const latest=store.getOwned<Draft>(id,session);
          const current=latest?.data.pages.flatMap(page=>page.panels).find(item=>item.id===panel.id);
          if (!latest || !current || current.assetId !== reviewed.assetId || current.revision !== reviewed.panelRevision || current.storyRevision !== reviewed.storyRevision || latest.data.storyRevision !== reviewed.storyRevision) throw new HttpError(409,'This panel changed while checking the edit. Refresh and review the current image.');
          if (decision.intent === 'uncertain') {
            const proposal={id:randomUUID(),panelId:panel.id,instruction,...reviewed,expiresAt:Date.now()+15*60*1000};
            if (!store.update(id,session,latest.revision,{...latest.data,pendingArtworkDecision:proposal})) throw new HttpError(409,'Draft changed while checking the edit. Refresh and try again.');
            return {...decision,proposalId:proposal.id};
          }
          return decision;
        });
        if (intent.intent !== 'artwork') return reply({editDecision:{...intent,panelId:panel.id,reviewedVersion:reviewed}});
      }
      await renderPanel(store,session,id,panel.id,instruction,reviewed);
      const latest = store.getOwned<Draft>(id,session)!;
      return reply({comic:view(latest.data,store.getPublished<Edition>(id),latest.revision)});
    }
    if (segments[2] === 'panels' && segments.length === 5 && segments[4] === 'accept' && method === 'POST') {
      const reviewed = await input(request,panelVersionSchema);
      const panel = data.pages.flatMap(p => p.panels).find(p => p.id === segments[3]);
      if (!panel || !panel.assetId) throw new HttpError(404,'Panel image not found.');
      if (panel.assetId !== reviewed.assetId || panel.revision !== reviewed.panelRevision || panel.storyRevision !== reviewed.storyRevision || data.storyRevision !== reviewed.storyRevision) throw new HttpError(409,'This panel changed since you reviewed it. Refresh and review the current image.');
      let updated: Draft;
      try { updated = acceptPanel(data,session,panel.id,reviewed.assetId,reviewed.storyRevision) as Draft; }
      catch { throw new HttpError(409,'This panel cannot be accepted in its current state.'); }
      return reply({comic:save(store,session,revision,updated)});
    }
    if (segments[2] === 'publish' && segments.length === 3 && method === 'POST') {
      const body = await input(request, publishSchema);
      const updated = {...data, title: body.title, creatorName: body.creator};
      if (!updated.pages.length || updated.pages.some(page => !page.panels.length || page.panels.some(p => !p.assetId || p.storyRevision !== updated.storyRevision || !isPanelReady(p)))) throw new HttpError(409, 'All current panels must be generated and reviewed before publishing.');
      const pageImages = await composePages(updated);
      const pages = pageImages.map(page => ({id:page.id,assetId:randomUUID(),image:page.image}));
      const composed = {...updated,pages:updated.pages.map((page,i) => ({...page,composition:{assetId:pages[i].assetId,panelAssetIds:page.panels.map(panel => panel.assetId!)}}))};
      const editionId = randomUUID();
      const validated = publishComic(composed, session, updated.storyRevision, editionId);
      if (!validated.published) throw new HttpError(409, 'This comic is not ready to publish.');
      const edition: Edition = {id,title:body.title,creator:body.creator || 'Anonymous',editionId,sourceRevision:revision + 1,
        pages:pages.map(p => ({id:p.id,imageUrl:`/api/published/${encodeURIComponent(id)}/assets/${encodeURIComponent(p.assetId)}?edition=${encodeURIComponent(editionId)}`,storage:'sqlite'}))};
      if (!store.publish(id,session,revision,edition,pages.map(p => ({id:p.assetId,data:p.image})))) throw new HttpError(409,'Draft changed while publishing; refresh and try again.');
      return reply({comic:view(data,edition,revision + 1)});
    }
    if (segments[2] === 'unpublish' && segments.length === 3 && method === 'POST') {
      await input(request, z.object({}).strict());
      store.withdraw(id, session);
      return reply({comic: view(data, null, revision + 1)});
    }
    if (method === 'POST') { assertMutation(request); aiUnavailable(); }
    throw new HttpError(404, 'Not found.');
  } catch (error) {
    if (error instanceof HttpError) return reply({error: error.message}, error.status);
    if (error instanceof ClaimInProgressError) return reply({error:error.message},409);
    if (error instanceof BudgetError) return reply({error: error.message, code:error.code}, error.code === 'budget_not_configured' ? 503 : 429);
    if (error instanceof AIError) return reply({error: error.message, code: error.code}, error.code === 'missing_key' ? 503 : error.code === 'invalid_input' ? 400 : 502);
    if (error instanceof Error && /incomplete|unaccepted|stale publication/.test(error.message)) return reply({error: error.message}, 409);
    console.error('Local API error:', error instanceof Error ? error.message : 'unknown error');
    return reply({error: 'The local server could not complete the request.'}, 500);
  }
}
