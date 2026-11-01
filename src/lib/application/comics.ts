import { z } from 'zod';
import sharp from 'sharp';
import { AIError, type Storyboard, type Reference } from '../ai/service';
import stylePresets from '../../../prompts/styles.json';
import { wrapDialogue } from '../lettering';
import { createBlankComic, createComic, commitPanelRender, acceptPanel as acceptPanelInDomain, reviseStory, publishComic, isPanelReady } from '../domain/comic';
import { ApplicationError, parse, short, createSchema, patchSchema, characterSchema, panelVersionSchema, publishSchema, type Actor, type Character, type ComicDependencies, type ComicRepository, type Draft, type Edition, type PanelReview } from './contracts';
import { narrativeFingerprint, publicView, view } from './views';
import {styles as comicStyles} from '../styles';
type StoryPanel = Storyboard['pages'][number]['panels'][number];
type StoryState = StoryPanel['state_before'];
function answeredQuestions(draft: Draft): Record<string, string> {
    return Object.fromEntries(draft.questions.filter(question => draft.answers[question.id]?.trim()).map(question => [question.question, draft.answers[question.id].trim()]));
}
function inconclusiveReview(error: unknown) {
    if (error instanceof AIError && (error.code === 'unknown_outcome' || error.code === 'invalid_response'))
        throw error;
    return { outcome: 'inconclusive', findings: [] };
}
function normalizeState(state: StoryState): StoryState {
    const unique = (facts: StoryState['props']) => {
        const seen = new Map<string, Set<string>>();
        return facts.filter(({ key, value }) => {
            const values = seen.get(key) ?? new Set<string>();
            if (values.has(value))
                return false;
            values.add(value);
            seen.set(key, values);
            return true;
        });
    };
    return { ...state, props: unique(state.props), outfits: unique(state.outfits), injuries: unique(state.injuries), knowledge: unique(state.knowledge) };
}
function normalizePanelLedger(panel: StoryPanel): StoryPanel {
    return { ...panel, state_before: normalizeState(panel.state_before), state_after: normalizeState(panel.state_after) };
}
export function validateStoryLedger(storyboard: Storyboard): string[] {
    const errors: string[] = [];
    const panels = storyboard.pages.flatMap(page => page.panels);
    const facts = ['props', 'outfits', 'injuries', 'knowledge'] as const;
    for (let i = 0; i < panels.length; i++) {
        const panel = panels[i];
        for (const state of [panel.state_before, panel.state_after]) {
            if (!state.location.trim() || !state.time.trim())
                errors.push(`${panel.id}: location and time are required`);
            for (const field of facts) {
                const keys = state[field].map(item => item.key);
                if (keys.some(key => !key.trim()) || new Set(keys).size !== keys.length)
                    errors.push(`${panel.id}: invalid or duplicate ${field} state`);
            }
        }
        if (i) {
            const earlier = panels[i - 1].state_after, next = panel.state_before;
            if (earlier.location !== next.location || earlier.time !== next.time)
                errors.push(`${panel.id}: incoming scene state does not match the previous panel`);
            for (const field of facts) {
                const a = new Map(earlier[field].map(item => [item.key, item.value]));
                if (a.size !== next[field].length || next[field].some(item => a.get(item.key) !== item.value))
                    errors.push(`${panel.id}: incoming ${field} does not match the previous panel`);
            }
        }
    }
    return errors;
}
function styleRules(id: string): string {
    const style = stylePresets.styles.find(s => s.id === id);
    if (!style)
        throw new ApplicationError('invalid_input', 'Unknown comic style.');
    return style.rules;
}
function rawNarrativeBlocker(draft: Draft): boolean {
    const review = draft.storyReview;
    if (!review || typeof review !== 'object' || !('findings' in review) || !Array.isArray(review.findings))
        return false;
    return review.findings.some((finding: unknown) => !!finding && typeof finding === 'object' && 'severity' in finding && finding.severity === 'blocker');
}
function hasNarrativeBlocker(draft: Draft): boolean {
    const fingerprint = narrativeFingerprint(draft);
    return rawNarrativeBlocker(draft) && (!fingerprint || draft.storyReviewAcceptance !== fingerprint);
}
function requireClearNarrative(draft: Draft): void {
    if (hasNarrativeBlocker(draft))
        throw new ApplicationError('conflict', 'Resolve the story review blockers before generating artwork.');
}
function xml(value: string): string { if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(value))
    throw new ApplicationError('invalid_input', 'Dialogue includes a character that cannot be rendered.'); return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;'); }
/** Domain orchestration with no request, cookie, or HTTP response dependency. */
export function createComicService(deps: ComicDependencies) {
    const store = deps.repository;
    const ai = () => deps.provider({ fetch: deps.budgetFetch });
    const asset = async (id: string) => await deps.assets.read(id);
    const saveAsset = async (bytes: Buffer) => {
        if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
            throw new ApplicationError('invalid_provider_response', 'Image provider did not return a PNG.');
        return await deps.assets.save(bytes);
    };
    const discardAsset = async (id: string) => await deps.assets.discard(id);
    async function owned(session: Actor, id: string, expectedRevision?: number) {
        const record = (await store.getOwned<Draft>(id, session));
        if (!record)
            throw new ApplicationError('not_found', 'Comic not found.');
        if (expectedRevision !== undefined && record.revision !== expectedRevision)
            throw new ApplicationError('conflict', 'This draft changed. Refresh and try again.');
        return record;
    }
    async function save(store: ComicRepository, session: Actor, revision: number, draft: Draft) {
        if (!(await store.update(draft.id, session, revision, draft)))
            throw new ApplicationError('conflict', 'This draft changed. Refresh and try again.');
        return view(draft, (await store.getPublished<Edition>(draft.id)), revision + 1);
    }
    async function withTextOperation<T>(store: ComicRepository, session: string, id: string, revision: number, task: () => Promise<T>): Promise<T> {
        if (!(await store.reserveTextOperation(id, session, revision)))
            throw new ApplicationError('conflict', 'A story request is already running, has an unknown outcome, or the draft changed.');
        let unknown = false;
        try {
            return await task();
        }
        catch (error) {
            unknown = error instanceof AIError && (error.code === 'unknown_outcome' || error.code === 'invalid_response');
            throw error;
        }
        finally {
            (await store.finishTextOperation(id, session, unknown));
        }
    }
    async function renderPanel(store: ComicRepository, session: string, comicId: string, panelId: string, editInstruction?: string, expectedVersion?: z.infer<typeof panelVersionSchema>): Promise<void> {
        const record = (await store.getOwned<Draft>(comicId, session));
        if (!record || !record.data.storyboard)
            throw new ApplicationError('conflict', 'Plan the story first.');
        const draft = record.data;
        requireClearNarrative(draft);
        const storyboard = draft.storyboard!;
        const panels = draft.pages.flatMap(page => page.panels);
        const index = panels.findIndex(p => p.id === panelId);
        if (index < 0)
            throw new ApplicationError('not_found', 'Panel not found.');
        const panel = panels[index];
        if (panel.status === 'checking')
            throw new ApplicationError('conflict', 'Wait for the panel review to finish.');
        if (expectedVersion && (panel.assetId !== expectedVersion.assetId || panel.revision !== expectedVersion.panelRevision || panel.storyRevision !== expectedVersion.storyRevision || draft.storyRevision !== expectedVersion.storyRevision))
            throw new ApplicationError('conflict', 'Panel changed while planning the edit; refresh and review it again.');
        const previous = index > 0 ? panels[index - 1] : undefined;
        if (previous && (!previous.assetId || previous.storyRevision !== draft.storyRevision || ['outdated', 'planned', 'checking'].includes(previous.status)))
            throw new ApplicationError('conflict', 'Generate and review earlier panels first.');
        if (previous?.evaluation === 'blocker' && !isPanelReady(previous))
            throw new ApplicationError('conflict', 'Review the preceding panel before generating this one.');
        const spec = storyboard.pages.flatMap(p => p.panels).find(p => p.id === panelId);
        if (!spec)
            throw new ApplicationError('conflict', 'The storyboard does not match this panel.');
        // Dialogue is added later during page composition; raw art must remain unlettered.
        const { dialogue: _dialogue, ...visualSpec } = spec;
        void _dialogue;
        const characters = draft.characters.filter(c => spec.character_ids.includes(c.id));
        if (characters.length !== spec.character_ids.length || characters.some(c => !c.approved || !c.referenceAssetId))
            throw new ApplicationError('conflict', 'Approve all character references first.');
        const anchorCharacters = characters.length ? characters : draft.characters.filter(c => c.approved && c.referenceAssetId).slice(0, 1);
        const references: Reference[] = await Promise.all(anchorCharacters.map(async (c) => ({ role: 'approved character', id: c.id, bytes: await asset(c.referenceAssetId!), mimeType: 'image/png' as const })));
        if (previous?.assetId)
            references.push({ role: 'previous panel', id: previous.id, bytes: await asset(previous.assetId), mimeType: 'image/png' });
        const op = `panel:${panelId}`;
        if (draft.operations?.[op])
            throw new ApplicationError('conflict', 'This panel request is already running or has an unknown outcome.');
        const reserved: Draft = { ...draft, operations: { ...draft.operations, [op]: 'running' } };
        if (!(await store.update(comicId, session, record.revision, reserved)))
            throw new ApplicationError('conflict', 'Draft changed; refresh and try again.');
        let assetId: string | undefined;
        let assetCommitted = false;
        try {
            const bytes = editInstruction
                ? await ai().editPanel({ change: editInstruction, preserve: JSON.stringify({ style: styleRules(draft.styleId), panel: visualSpec, characters }), references: [{ role: 'target panel', id: panelId, bytes: await asset(panel.assetId!), mimeType: 'image/png' }, ...references] })
                : await ai().panel({ styleRules: styleRules(draft.styleId), panelSpec: JSON.stringify(visualSpec), sceneBefore: JSON.stringify(spec.state_before), characters, references });
            assetId = await saveAsset(bytes);
            for (let attempt = 0; attempt < 3; attempt++) {
                const latest = (await store.getOwned<Draft>(comicId, session));
                const currentPanels = latest?.data.pages.flatMap(page => page.panels) ?? [];
                const currentIndex = currentPanels.findIndex(current => current.id === panelId);
                const current = currentPanels[currentIndex];
                const currentPrevious = currentIndex > 0 ? currentPanels[currentIndex - 1] : undefined;
                if (!latest || latest.data.operations?.[op] !== 'running' || latest.data.storyRevision !== draft.storyRevision ||
                    latest.data.styleId !== draft.styleId || JSON.stringify(latest.data.storyboard) !== JSON.stringify(storyboard) ||
                    JSON.stringify(latest.data.characters) !== JSON.stringify(draft.characters) ||
                    JSON.stringify(current) !== JSON.stringify(panel) || JSON.stringify(currentPrevious) !== JSON.stringify(previous) ||
                    hasNarrativeBlocker(latest.data))
                    throw new ApplicationError('conflict', 'Panel inputs changed while rendering; the result was not applied.');
                const updated = commitPanelRender(latest.data, session, panelId, { storyRevision: draft.storyRevision, panelRevision: panel.revision }, assetId, 'uncertain') as Draft;
                const { [op]: ignored, ...operations } = updated.operations ?? {};
                void ignored;
                const checkingPages = updated.pages.map(page => ({ ...page, panels: page.panels.map(p => p.id === panelId ? { ...p, status: 'checking' as const } : p) }));
                const { [panelId]: oldReview, ...panelReviews } = updated.panelReviews ?? {};
                void oldReview;
                if ((await store.update(comicId, session, latest.revision, { ...updated, pages: checkingPages, panelFindings: { ...updated.panelFindings, [panelId]: [] }, panelReviews, operations }))) {
                    assetCommitted = true;
                    break;
                }
            }
            if (!assetCommitted)
                throw new ApplicationError('conflict', 'Draft changed while saving the panel.');
        }
        catch (error) {
            if (assetId && !assetCommitted)
                await discardAsset(assetId);
            const latest = (await store.getOwned<Draft>(comicId, session));
            if (latest?.data.operations?.[op] === 'running') {
                const operations = { ...latest.data.operations };
                if (error instanceof AIError && error.code === 'unknown_outcome')
                    operations[op] = 'unknown_outcome';
                else
                    delete operations[op];
                (await store.update(comicId, session, latest.revision, { ...latest.data, operations }));
            }
            throw error;
        }
        if (!assetId)
            throw new Error('Panel image was not saved.');
        // An unsuccessful or uncalibrated review remains uncertain and requires creator acceptance.
        let findings: Awaited<ReturnType<ReturnType<typeof ai>['visualJudge']>>['findings'] = [];
        let outcome: PanelReview['outcome'] = 'failed';
        try {
            const result = await ai().visualJudge({ bible: storyboard.bible, styleRules: styleRules(draft.styleId), beats: visualSpec,
                references: [...references, { role: 'generated panel', id: panelId, bytes: await asset(assetId), mimeType: 'image/png' }] });
            findings = result.findings;
            outcome = result.outcome;
        }
        catch { /* Keep the image and surface an uncertain result. */ }
        const latest = (await store.getOwned<Draft>(comicId, session));
        if (!latest)
            return;
        const current = latest.data.pages.flatMap(p => p.panels).find(p => p.id === panelId);
        if (!current || current.assetId !== assetId || current.storyRevision !== draft.storyRevision || current.revision !== panel.revision + 1 || current.status !== 'checking')
            return;
        const evaluation = findings.some(f => f.severity === 'blocker') ? 'blocker' : findings.some(f => f.severity === 'warning') ? 'warning' : 'uncertain';
        const pages = latest.data.pages.map(page => ({ ...page, panels: page.panels.map(p => p.id === panelId ? { ...p, evaluation, status: 'needs_review' as const, acceptance: null } : p) }));
        const panelFindings = { ...latest.data.panelFindings, [panelId]: findings };
        const panelReviews = { ...latest.data.panelReviews, [panelId]: { assetId, storyRevision: draft.storyRevision, panelRevision: current.revision, outcome } };
        if (!(await store.update(comicId, session, latest.revision, { ...latest.data, pages, panelFindings, panelReviews })))
            throw new ApplicationError('conflict', 'Draft changed while saving the review; refresh and try again.');
    }
    async function composePages(draft: Draft): Promise<{
        id: string;
        image: Buffer;
    }[]> {
        if (!draft.storyboard)
            throw new ApplicationError('conflict', 'The storyboard is missing.');
        const grid = draft.pageLayout === 'grid';
        const panelWidth = grid ? 480 : 980;
        const panelHeight = grid ? 260 : 420;
        const orderedSpecs = new Map(draft.storyboard.pages.flatMap(p => p.panels).map(p => [p.id, p]));
        const result: {
            id: string;
            image: Buffer;
        }[] = [];
        for (const page of draft.pages) {
            const sections: {
                image: Buffer;
                lines: string[];
            }[] = [];
            for (const panel of page.panels) {
                const spec = orderedSpecs.get(panel.id);
                if (!panel.assetId || !spec)
                    throw new ApplicationError('conflict', 'A page is missing its current panel.');
                const image = await sharp(await asset(panel.assetId)).resize(panelWidth, panelHeight, { fit: 'contain', background: '#fffef8' }).png().toBuffer();
                const lines: string[] = [];
                for (const dialogue of spec.dialogue) {
                    const name = draft.characters.find(c => c.id === dialogue.speaker_id)?.name ?? dialogue.speaker_id;
                    lines.push(...wrapDialogue(`${name}: ${dialogue.text}`, grid ? 17 : 25));
                }
                sections.push({ image, lines });
            }
            const rows = grid ? Array.from({ length: Math.ceil(sections.length / 2) }, (_, i) => sections.slice(i * 2, i * 2 + 2)) : sections.map(section => [section]);
            const height = 20 + rows.reduce((sum, row) => sum + Math.max(...row.map(s => panelHeight + (s.lines.length ? s.lines.length * 30 + 24 : 0))) + 20, 0);
            if (height > 12000)
                throw new ApplicationError('invalid_input', 'The page has too much dialogue to compose.');
            const composites: {
                input: Buffer;
                top: number;
                left: number;
            }[] = [];
            let y = 20;
            for (const row of rows) {
                let rowHeight = panelHeight;
                row.forEach((section, column) => {
                    const x = 20 + column * (panelWidth + 20);
                    composites.push({ input: section.image, top: y, left: x });
                    if (section.lines.length) {
                        const h = section.lines.length * 30 + 24;
                        const lines = section.lines.map((line, i) => `<text x="12" y="${26 + i * 30}" font-family="sans-serif" font-size="22" fill="#171717" xml:space="preserve">${xml(line)}</text>`).join('');
                        const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${panelWidth}" height="${h}"><rect width="${panelWidth}" height="${h}" fill="white" stroke="#171717" stroke-width="3"/>${lines}</svg>`);
                        composites.push({ input: svg, top: y + panelHeight, left: x });
                        rowHeight = Math.max(rowHeight, panelHeight + h);
                    }
                });
                y += rowHeight + 20;
            }
            const image = await sharp({ create: { width: 1020, height, channels: 4, background: '#fff8e8' } }).composite(composites).png().toBuffer();
            result.push({ id: page.id, image });
        }
        return result;
    }
    function listStyles() {
        return {styles:comicStyles.map(({id,name,description}) => ({id,name,description}))};
    }
    async function create(session: Actor, payload: unknown) {
        const body = parse(payload, createSchema);
        const id = deps.id();
        const draft: Draft = { ...createBlankComic(id, session), title: body.title, plot: body.plot, styleId: body.style, characters: [], answers: {}, questions: [], initialQuestions: 'pending', initialSuggestions: 'pending' };
        (await store.create(id, session, draft));
        return { comic: { id } };
    }
    async function list(session: Actor) {
        const drafts = (await store.listOwned<Draft>(session));
        return { comics: await Promise.all(drafts.map(async (d) => ({ id: d.id, title: d.title, plot: d.plot, published: !!(await store.getPublished<Edition>(d.id)) }))) };
    }
    async function get(session: Actor, id: string) {
        const { data, revision } = await owned(session, id);
        return { comic: view(data, (await store.getPublished<Edition>(id)), revision) };
    }
    async function getAsset(session: Actor, id: string, itemId: string) {
        const { data } = await owned(session, id);
        if (!data.characters.some(c => c.referenceAssetId === itemId) && !data.pages.some(page => page.panels.some(p => p.assetId === itemId)))
            throw new ApplicationError('not_found', 'Image not found.');
        return await asset(itemId);
    }
    async function listPublished() {
        const editions = (await store.listPublished<Edition>());
        return { comics: editions.map(e => ({ id: e.id, title: e.title, creator: e.creator, pageCount: e.pages.length, coverUrl: e.pages[0]?.imageUrl ?? null })) };
    }
    async function getPublished(id: string) {
        const edition = (await store.getPublished<Edition>(id));
        if (!edition)
            throw new ApplicationError('not_found', 'This comic is unavailable.');
        return { comic: publicView(edition) };
    }
    async function getPublishedAsset(id: string, itemId: string, editionId: string | null) {
        const edition = (await store.getPublished<Edition>(id));
        if (!edition || editionId !== edition.editionId)
            throw new ApplicationError('not_found', 'This edition is unavailable. Reload the comic.');
        const imageUrl = `/api/published/${encodeURIComponent(edition.id)}/assets/${encodeURIComponent(itemId)}?edition=${encodeURIComponent(edition.editionId)}`;
        const page = edition.pages.find(p => p.imageUrl === imageUrl);
        if (!page)
            throw new ApplicationError('not_found', 'Image not found.');
        const bytes = page.storage === 'sqlite' ? (await store.getPublicationAsset(edition.id, itemId)) : await asset(itemId);
        if (!bytes)
            throw new ApplicationError('not_found', 'Image not found.');
        return bytes;
    }
    async function update(session: Actor, id: string, payload: unknown = {}, expectedRevision?: number) {
        const { data, revision } = await owned(session, id, expectedRevision);
        const body = parse(payload, patchSchema);
        if (data.pages.length && ((body.plot !== undefined && body.plot !== data.plot) || (body.style !== undefined && body.style !== data.styleId) || (body.answers !== undefined && JSON.stringify(body.answers) !== JSON.stringify(data.answers))))
            throw new ApplicationError('conflict', 'Change the story through the revision flow so later pages can be updated.');
        if (data.pages.length && body.panelsPerPage !== undefined && body.panelsPerPage !== (data.panelsPerPage ?? 3))
            throw new ApplicationError('conflict', 'Choose the number of panels before planning the story.');
        const updated: Draft = { ...data, title: body.title ?? data.title, plot: body.plot ?? data.plot, styleId: body.style ?? data.styleId, answers: body.answers ?? data.answers, panelsPerPage: body.panelsPerPage ?? data.panelsPerPage, pageLayout: body.pageLayout ?? data.pageLayout };
        return ({ comic: (await save(store, session, revision, updated)) });
    }
    async function initialQuestions(session: Actor, id: string, payload: unknown = {}, expectedRevision?: number) {
        const { data, revision } = await owned(session, id, expectedRevision);
        parse(payload, z.object({}).strict());
        if (data.initialQuestions !== 'pending')
            return ({ comic: view(data, (await store.getPublished<Edition>(id)), revision) });
        return await withTextOperation(store, session, id, revision, async () => {
            if (!(await store.update(id, session, revision, { ...data, initialQuestions: 'running' })))
                throw new ApplicationError('conflict', 'Draft changed before asking questions.');
            try {
                const generated = await ai().questions({ plot: data.plot, style: data.styleId, answers: answeredQuestions(data), limit: 5 });
                const seen = new Set<string>();
                const questions = generated.filter(question => { const key = question.question.trim().toLocaleLowerCase('en-US'); if (seen.has(key))
                    return false; seen.add(key); return true; }).map(question => ({ ...question, id: deps.id() }));
                for (let attempt = 0; attempt < 3; attempt++) {
                    const latest = (await store.getOwned<Draft>(id, session));
                    if (!latest || latest.data.initialQuestions !== 'running' || latest.data.plot !== data.plot || latest.data.styleId !== data.styleId || JSON.stringify(latest.data.questions) !== JSON.stringify(data.questions) || JSON.stringify(latest.data.answers) !== JSON.stringify(data.answers))
                        throw new ApplicationError('conflict', 'Story changed while finding questions.');
                    const updated = { ...latest.data, questions, initialQuestions: 'complete' as const };
                    if ((await store.update(id, session, latest.revision, updated)))
                        return ({ comic: view(updated, (await store.getPublished<Edition>(id)), latest.revision + 1) });
                }
                throw new ApplicationError('conflict', 'Draft changed while saving questions.');
            }
            catch (error) {
                const latest = (await store.getOwned<Draft>(id, session));
                if (latest?.data.initialQuestions === 'running') {
                    const unknown = error instanceof AIError && (error.code === 'unknown_outcome' || error.code === 'invalid_response');
                    (await store.update(id, session, latest.revision, { ...latest.data, initialQuestions: unknown ? 'unknown' : 'failed' }));
                }
                throw error;
            }
        });
    }
    async function refreshQuestions(session: Actor, id: string, payload: unknown = {}, expectedRevision?: number) {
        const { data, revision } = await owned(session, id, expectedRevision);
        parse(payload, z.object({}).strict());
        try {
            return await withTextOperation(store, session, id, revision, async () => {
                const answered = data.questions.filter(question => data.answers[question.id]?.trim());
                const limit = Math.max(0, 5 - answered.length);
                const additions = limit ? await ai().questions({ plot: data.plot, style: data.styleId, answers: answeredQuestions(data), limit }) : [];
                const seen = new Set(answered.map(question => question.question.trim().toLocaleLowerCase('en-US')));
                const questions = [...answered];
                for (const question of additions) {
                    const key = question.question.trim().toLocaleLowerCase('en-US');
                    if (!seen.has(key)) {
                        seen.add(key);
                        questions.push({ ...question, id: deps.id() });
                    }
                }
                const answers = Object.fromEntries(answered.map(question => [question.id, data.answers[question.id]]));
                return ({ comic: (await save(store, session, revision, { ...data, questions, answers, initialQuestions: 'complete' })) });
            });
        }
        catch (error) {
            if (error instanceof AIError && (error.code === 'unknown_outcome' || error.code === 'invalid_response')) {
                const latest = (await store.getOwned<Draft>(id, session));
                if (latest)
                    (await store.update(id, session, latest.revision, { ...latest.data, initialQuestions: 'unknown' }));
            }
            throw error;
        }
    }
    async function suggestCharacters(session: Actor, id: string, payload: unknown = {}, expectedRevision?: number) {
        const { data, revision } = await owned(session, id, expectedRevision);
        const body = parse(payload, z.object({ retry: z.boolean().optional() }).strict());
        if (data.pages.length)
            throw new ApplicationError('conflict', 'Character changes require a story revision.');
        if (data.initialQuestions === 'running' || data.initialQuestions === 'pending')
            throw new ApplicationError('conflict', 'Wait for story questions first.');
        if (data.initialSuggestions === 'unknown')
            throw new ApplicationError('conflict', 'Resolve the previous character suggestion request before trying again.');
        if (data.initialSuggestions === 'running' || (data.initialSuggestions === 'complete' && !body.retry))
            return ({ comic: view(data, (await store.getPublished<Edition>(id)), revision) });
        if (data.initialSuggestions !== 'pending' && !body.retry)
            return ({ comic: view(data, (await store.getPublished<Edition>(id)), revision) });
        return await withTextOperation(store, session, id, revision, async () => {
            if (!(await store.update(id, session, revision, { ...data, initialSuggestions: 'running' })))
                throw new ApplicationError('conflict', 'Draft changed before suggesting characters.');
            try {
                const generated = await ai().characterSuggestions({ plot: data.plot, style: data.styleId, answers: answeredQuestions(data), existingCharacters: data.characters.map(({ name, role }) => ({ name, role })) });
                const seen = new Set<string>();
                const characterSuggestions = generated.filter(card => { const key = card.name.toLocaleLowerCase('en-US'); if (seen.has(key))
                    return false; seen.add(key); return true; }).map(card => ({ id: deps.id(), ...card }));
                for (let attempt = 0; attempt < 3; attempt++) {
                    const latest = (await store.getOwned<Draft>(id, session));
                    if (!latest || latest.data.initialSuggestions !== 'running' || latest.data.pages.length || latest.data.plot !== data.plot || latest.data.styleId !== data.styleId || JSON.stringify(latest.data.questions) !== JSON.stringify(data.questions) || JSON.stringify(latest.data.answers) !== JSON.stringify(data.answers))
                        throw new ApplicationError('conflict', 'Story changed while suggesting characters.');
                    const updated = { ...latest.data, characterSuggestions, initialSuggestions: 'complete' as const };
                    if ((await store.update(id, session, latest.revision, updated)))
                        return ({ comic: view(updated, (await store.getPublished<Edition>(id)), latest.revision + 1) });
                }
                throw new ApplicationError('conflict', 'Draft changed while saving character suggestions.');
            }
            catch (error) {
                const latest = (await store.getOwned<Draft>(id, session));
                if (latest?.data.initialSuggestions === 'running') {
                    const unknown = error instanceof AIError && (error.code === 'unknown_outcome' || error.code === 'invalid_response');
                    (await store.update(id, session, latest.revision, { ...latest.data, initialSuggestions: unknown ? 'unknown' : 'failed' }));
                }
                throw error;
            }
        });
    }
    async function acceptStoryReview(session: Actor, id: string, payload: unknown = {}, expectedRevision?: number) {
        const { data, revision } = await owned(session, id, expectedRevision);
        const body = parse(payload, z.object({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict());
        const fingerprint = narrativeFingerprint(data);
        if (!fingerprint || body.fingerprint !== fingerprint || !rawNarrativeBlocker(data) || !data.storyReview || typeof data.storyReview !== 'object' || !('outcome' in data.storyReview) || data.storyReview.outcome !== 'findings')
            throw new ApplicationError('conflict', 'This story review has changed or is not eligible for acceptance.');
        return await withTextOperation(store, session, id, revision, async () => ({ comic: (await save(store, session, revision, { ...data, storyReviewAcceptance: fingerprint })) }));
    }
    async function planStory(session: Actor, id: string, payload: unknown = {}, expectedRevision?: number) {
        const { data, revision } = await owned(session, id, expectedRevision);
        parse(payload, z.object({}).strict());
        if (data.pages.length)
            throw new ApplicationError('conflict', 'Use story revision to change existing pages.');
        if (!data.characters.length || data.characters.some(c => !c.approved || !c.referenceAssetId))
            throw new ApplicationError('conflict', 'Approve reference images for every selected character first.');
        if (data.characters.some(c => data.operations?.[`character:${c.id}`]))
            throw new ApplicationError('conflict', 'Resolve character reference requests before planning the story.');
        return await withTextOperation(store, session, id, revision, async () => {
            const generated = await ai().storyboard({ plot: data.plot, answers: answeredQuestions(data), styleRules: styleRules(data.styleId), characters: data.characters, pageCount: 3, panelsPerPage: data.panelsPerPage ?? 3 });
            const storyboard = { ...generated, pages: generated.pages.map(page => ({ ...page, panels: page.panels.map(normalizePanelLedger) })) };
            const ledgerErrors = validateStoryLedger(storyboard);
            if (ledgerErrors.length)
                throw new ApplicationError('invalid_story', `Story state needs correction: ${ledgerErrors[0]}`);
            const planned = createComic({ id, ownerId: session, title: data.title, creatorName: data.creatorName, plot: data.plot, styleId: data.styleId,
                pages: storyboard.pages.map(p => ({ id: deps.id(), panels: p.panels.map(panel => ({ id: panel.id, beat: panel.action })) })) });
            let storyReview: unknown;
            try {
                storyReview = await ai().narrativeJudge({ creatorGoal: data.plot, answers: answeredQuestions(data), bible: storyboard.bible, beats: storyboard.pages });
            }
            catch (error) {
                storyReview = inconclusiveReview(error);
            }
            return ({ comic: (await save(store, session, revision, { ...data, ...planned, storyboard, storyReview, storyReviewAcceptance: undefined })) });
        });
    }
    async function generateReference(session: Actor, id: string, itemId: string, payload: unknown = {}, expectedRevision?: number) {
        const { data, revision } = await owned(session, id, expectedRevision);
        parse(payload, z.object({}).strict());
        if (data.pages.length)
            throw new ApplicationError('conflict', 'Character changes require a story revision.');
        const character = data.characters.find(c => c.id === itemId);
        if (!character)
            throw new ApplicationError('not_found', 'Character not found.');
        const op = `character:${character.id}`;
        if (data.operations?.[op])
            throw new ApplicationError('conflict', 'This image request is already running or has an unknown outcome.');
        const reserved: Draft = { ...data, operations: { ...data.operations, [op]: 'running' } };
        if (!(await store.update(id, session, revision, reserved)))
            throw new ApplicationError('conflict', 'Draft changed; refresh and try again.');
        let assetId: string | undefined;
        let assetCommitted = false;
        try {
            const bytes = await ai().characterReference({ character, styleRules: styleRules(data.styleId) });
            assetId = await saveAsset(bytes);
            for (let attempt = 0; attempt < 3; attempt++) {
                const latest = (await store.getOwned<Draft>(id, session));
                const current = latest?.data.characters.find(c => c.id === character.id);
                if (!latest || latest.data.operations?.[op] !== 'running' || latest.data.pages.length || latest.data.styleId !== data.styleId || JSON.stringify(current) !== JSON.stringify(character))
                    throw new ApplicationError('conflict', 'Character inputs changed while rendering; the result was not applied.');
                const { [op]: ignored, ...operations } = latest.data.operations ?? {};
                void ignored;
                const characters = latest.data.characters.map(c => c.id === character.id ? { ...c, approved: false, referenceAssetId: assetId, referenceUrl: `/api/comics/${encodeURIComponent(id)}/assets/${assetId}` } : c);
                const updated = { ...latest.data, characters, operations };
                if ((await store.update(id, session, latest.revision, updated))) {
                    assetCommitted = true;
                    return ({ comic: view(updated, (await store.getPublished<Edition>(id)), latest.revision + 1) });
                }
            }
            throw new ApplicationError('conflict', 'Draft changed while saving the reference.');
        }
        catch (error) {
            if (assetId && !assetCommitted)
                await discardAsset(assetId);
            const latest = (await store.getOwned<Draft>(id, session));
            if (latest?.data.operations?.[op] === 'running') {
                const operations = { ...latest.data.operations };
                if (error instanceof AIError && error.code === 'unknown_outcome')
                    operations[op] = 'unknown_outcome';
                else
                    delete operations[op];
                (await store.update(id, session, latest.revision, { ...latest.data, operations }));
            }
            throw error;
        }
    }
    async function addCharacter(session: Actor, id: string, payload: unknown = {}, expectedRevision?: number) {
        const { data, revision } = await owned(session, id, expectedRevision);
        const body = parse(payload, characterSchema);
        if (data.pages.length)
            throw new ApplicationError('conflict', 'Revise the story before changing characters on planned pages.');
        const character: Character = { ...body, id: deps.id(), approved: false };
        return ({ comic: (await save(store, session, revision, { ...data, characters: [...data.characters, character] })) });
    }
    async function changeCharacter(session: Actor, id: string, itemId: string, payload: unknown = {}, method: 'PATCH' | 'DELETE' = 'PATCH', expectedRevision?: number) {
        const { data, revision } = await owned(session, id, expectedRevision);
        const body = method === 'PATCH' ? parse(payload, characterSchema) : parse(payload, z.object({}).strict());
        if (data.pages.length)
            throw new ApplicationError('conflict', 'Character changes require a story revision.');
        const character = data.characters.find(c => c.id === itemId);
        if (!character)
            throw new ApplicationError('not_found', 'Character not found.');
        if (data.operations?.[`character:${character.id}`])
            throw new ApplicationError('conflict', 'Wait until the character reference request is resolved before changing this card.');
        if (method === 'DELETE')
            return ({ comic: (await save(store, session, revision, { ...data, characters: data.characters.filter(c => c.id !== character.id) })) });
        const values = body as z.infer<typeof characterSchema>;
        const changed = (['name', 'role', 'appearance', 'outfit'] as const).some(key => values[key] !== character[key]);
        const replacement = changed ? { id: character.id, ...values, approved: false } : character;
        return ({ comic: (await save(store, session, revision, { ...data, characters: data.characters.map(c => c.id === character.id ? replacement : c) })) });
    }
    async function approveCharacter(session: Actor, id: string, itemId: string, payload: unknown = {}, expectedRevision?: number) {
        const { data, revision } = await owned(session, id, expectedRevision);
        const { assetId } = parse(payload, z.object({ assetId: z.string().uuid() }).strict());
        const character = data.characters.find(c => c.id === itemId);
        if (!character)
            throw new ApplicationError('not_found', 'Character not found.');
        if (data.operations?.[`character:${character.id}`])
            throw new ApplicationError('conflict', 'Resolve the character reference request before approval.');
        if (!character.referenceUrl || !character.referenceAssetId)
            throw new ApplicationError('conflict', 'Create a reference image before approval.');
        if (character.referenceAssetId !== assetId)
            throw new ApplicationError('conflict', 'This reference changed since you reviewed it. Refresh and review the current image.');
        return ({ comic: (await save(store, session, revision, { ...data, characters: data.characters.map(c => c.id === character.id ? { ...c, approved: true } : c) })) });
    }
    async function previewRevision(session: Actor, id: string, payload: unknown = {}, expectedRevision?: number) {
        const { data, revision } = await owned(session, id, expectedRevision);
        const body = parse(payload, z.object({ panelId: short, instruction: z.string().trim().min(1).max(4000), reviewedVersion: panelVersionSchema.optional() }).strict());
        if (!data.storyboard)
            throw new ApplicationError('conflict', 'Plan the story before revising it.');
        if (body.reviewedVersion) {
            const reviewed = data.pages.flatMap(page => page.panels).find(panel => panel.id === body.panelId);
            if (!reviewed || reviewed.assetId !== body.reviewedVersion.assetId || reviewed.storyRevision !== body.reviewedVersion.storyRevision || reviewed.revision !== body.reviewedVersion.panelRevision || data.storyRevision !== body.reviewedVersion.storyRevision)
                throw new ApplicationError('conflict', 'This panel changed since you viewed it. Refresh and review the current image.');
        }
        const currentStoryboard = data.storyboard;
        return await withTextOperation(store, session, id, revision, async () => {
            const generated = await ai().revision({ storyboard: currentStoryboard, firstPanelId: body.panelId, instruction: body.instruction, characters: data.characters });
            const result = { ...generated, revised_suffix: generated.revised_suffix.map(normalizePanelLedger) };
            const changed = new Map(result.revised_suffix.map(panel => [panel.id, panel]));
            const proposed: Storyboard = { ...currentStoryboard, bible: result.revised_bible, pages: currentStoryboard.pages.map(page => ({ ...page, panels: page.panels.map(panel => changed.get(panel.id) ?? panel) })) };
            const errors = validateStoryLedger(proposed);
            if (errors.length)
                throw new ApplicationError('invalid_story', `Revised story state needs correction: ${errors[0]}`);
            const pageIndex = data.pages.findIndex(page => page.panels.some(panel => panel.id === result.earliest_affected_panel_id));
            if (pageIndex < 0)
                throw new ApplicationError('invalid_story', 'Revision points to a missing panel.');
            const affectedPanel = data.pages[pageIndex].panels.findIndex(panel => panel.id === result.earliest_affected_panel_id) + 1;
            const proposal = { id: deps.id(), baseRevision: revision + 1, result };
            if (!(await store.update(id, session, revision, { ...data, pendingRevision: proposal })))
                throw new ApplicationError('conflict', 'Draft changed while planning the revision; refresh and try again.');
            return ({ proposal: { id: proposal.id, earliestPanelId: result.earliest_affected_panel_id, affectedPage: pageIndex + 1, affectedPanel, explanation: result.explanation } });
        });
    }
    async function applyRevision(session: Actor, id: string, payload: unknown = {}, expectedRevision?: number) {
        const { data, revision } = await owned(session, id, expectedRevision);
        const body = parse(payload, z.object({ proposalId: short }).strict());
        const proposal = data.pendingRevision;
        if (!proposal || proposal.id !== body.proposalId || proposal.baseRevision !== revision || !data.storyboard)
            throw new ApplicationError('conflict', 'Revision preview expired. Preview the changes again.');
        const next = await withTextOperation(store, session, id, revision, async () => {
            const changed = new Map(proposal.result.revised_suffix.map(panel => [panel.id, panel]));
            const storyboard: Storyboard = { ...data.storyboard!, bible: proposal.result.revised_bible, pages: data.storyboard!.pages.map(page => ({ ...page, panels: page.panels.map(panel => changed.get(panel.id) ?? panel) })) };
            const errors = validateStoryLedger(storyboard);
            if (errors.length)
                throw new ApplicationError('invalid_story', `Revised story state needs correction: ${errors[0]}`);
            const beats = Object.fromEntries(proposal.result.revised_suffix.map(panel => [panel.id, panel.action]));
            const updated = reviseStory(data, session, data.storyRevision, proposal.result.earliest_affected_panel_id, beats) as Draft;
            let storyReview: unknown;
            try {
                storyReview = await ai().narrativeJudge({ creatorGoal: data.plot, answers: answeredQuestions(data), bible: storyboard.bible, beats: storyboard.pages });
            }
            catch (error) {
                storyReview = inconclusiveReview(error);
            }
            const next: Draft = { ...updated, storyboard, storyReview, storyReviewAcceptance: undefined, pendingRevision: undefined, pageOperations: undefined };
            if (!(await store.update(id, session, revision, next)))
                throw new ApplicationError('conflict', 'Draft changed while applying revision; preview it again.');
            return next;
        });
        const firstPage = next.pages.findIndex(page => page.panels.some(panel => panel.id === proposal.result.earliest_affected_panel_id));
        const previousPageReady = firstPage === 0 || next.pages[firstPage - 1].panels.every(p => p.storyRevision === next.storyRevision && isPanelReady(p));
        let pausedNotice = '';
        if (previousPageReady && !hasNarrativeBlocker(next)) {
            const pagePanels = next.pages[firstPage].panels;
            const affected = pagePanels.findIndex(panel => panel.id === proposal.result.earliest_affected_panel_id);
            const firstIncomplete = pagePanels.findIndex(panel => !panel.assetId || panel.status === 'outdated' || panel.status === 'planned');
            const first = firstIncomplete >= 0 ? Math.min(firstIncomplete, affected) : affected;
            for (const panel of pagePanels.slice(first)) {
                try {
                    await renderPanel(store, session, id, panel.id);
                }
                catch {
                    pausedNotice = 'Story change saved, but artwork did not finish. Review the page and resolve any outstanding operation before continuing.';
                    break;
                }
                const currentPanel = (await store.getOwned<Draft>(id, session))?.data.pages[firstPage].panels.find(p => p.id === panel.id);
                if (!currentPanel || (currentPanel.evaluation === 'blocker' && !isPanelReady(currentPanel))) {
                    pausedNotice = 'Story change saved. Review the panel blocker before continuing the page.';
                    break;
                }
            }
        }
        const latest = (await store.getOwned<Draft>(id, session))!;
        return ({ comic: view(latest.data, (await store.getPublished<Edition>(id)), latest.revision), notice: pausedNotice || (hasNarrativeBlocker(next) ? 'Resolve the story review blockers before generating artwork.' : 'Later pages remain outdated until you review the preceding page and generate them.') });
    }
    async function downloadPage(session: Actor, id: string, itemId: string, expectedRevision?: number) {
        const { data, revision } = await owned(session, id, expectedRevision);
        const page = data.pages.find(p => p.id === itemId);
        if (!page)
            throw new ApplicationError('not_found', 'Page not found.');
        if (!page.panels.length || page.panels.some(p => !p.assetId || p.storyRevision !== data.storyRevision || !isPanelReady(p)))
            throw new ApplicationError('conflict', 'Generate and review every panel on this page before downloading.');
        const [composed] = await composePages({ ...data, pages: [page] });
        if ((await store.getOwned<Draft>(id, session))?.revision !== revision)
            throw new ApplicationError('conflict', 'Draft changed while composing; try again.');
        return composed.image;
    }
    async function generatePage(session: Actor, id: string, itemId: string, payload: unknown = {}, expectedRevision?: number) {
        const { data, revision } = await owned(session, id, expectedRevision);
        parse(payload, z.object({}).strict());
        requireClearNarrative(data);
        const pageIndex = data.pages.findIndex(p => p.id === itemId);
        if (pageIndex < 0)
            throw new ApplicationError('not_found', 'Page not found.');
        if (pageIndex > 0 && data.pages[pageIndex - 1].panels.some(p => p.storyRevision !== data.storyRevision || !isPanelReady(p)))
            throw new ApplicationError('conflict', 'Review and accept the preceding page first.');
        const requestedPage = data.pages[pageIndex];
        if (requestedPage.panels.some(p => p.status === 'checking'))
            throw new ApplicationError('conflict', 'Wait for the panel review to finish.');
        let operation = data.pageOperations?.[requestedPage.id];
        if (operation && operation.storyRevision !== data.storyRevision)
            operation = undefined;
        if (!operation) {
            // A complete page click explicitly regenerates all panels. An incomplete page resumes missing/outdated panels.
            const fullyRendered = requestedPage.panels.every(p => !!p.assetId && p.storyRevision === data.storyRevision && (p.status === 'current' || p.status === 'needs_review'));
            const firstIncomplete = requestedPage.panels.findIndex(p => !p.assetId || p.storyRevision !== data.storyRevision || !['current', 'needs_review'].includes(p.status));
            const targets = fullyRendered ? requestedPage.panels : requestedPage.panels.slice(firstIncomplete);
            operation = { storyRevision: data.storyRevision, baseline: Object.fromEntries(targets.map(p => [p.id, p.revision])) };
            if (!(await store.update(id, session, revision, { ...data, pageOperations: { ...data.pageOperations, [requestedPage.id]: operation } })))
                throw new ApplicationError('conflict', 'Draft changed; refresh and try again.');
        }
        for (const [panelId, baseline] of Object.entries(operation.baseline)) {
            const current = (await store.getOwned<Draft>(id, session));
            if (!current || current.data.storyRevision !== operation.storyRevision)
                throw new ApplicationError('conflict', 'Story changed while drawing the page.');
            const panel = current.data.pages.flatMap(p => p.panels).find(p => p.id === panelId);
            if (!panel)
                throw new ApplicationError('conflict', 'Panel no longer exists.');
            if (panel.revision !== baseline) {
                if (panel.evaluation === 'blocker' && !isPanelReady(panel))
                    return ({ comic: view(current.data, (await store.getPublished<Edition>(id)), current.revision), notice: 'Page generation paused. Repair or explicitly accept the flagged panel before continuing.' });
                if (panel.storyRevision === operation.storyRevision && panel.assetId && ['current', 'needs_review'].includes(panel.status))
                    continue;
                throw new ApplicationError('conflict', 'Panel changed while drawing the page.');
            }
            await renderPanel(store, session, id, panelId);
            const reviewed = (await store.getOwned<Draft>(id, session));
            const finishedPanel = reviewed?.data.pages.flatMap(p => p.panels).find(p => p.id === panelId);
            if (reviewed && finishedPanel?.evaluation === 'blocker' && !isPanelReady(finishedPanel))
                return ({ comic: view(reviewed.data, (await store.getPublished<Edition>(id)), reviewed.revision), notice: 'Page generation paused. Repair or explicitly accept the flagged panel before continuing.' });
        }
        const latest = (await store.getOwned<Draft>(id, session))!;
        const { [requestedPage.id]: finished, ...pageOperations } = latest.data.pageOperations ?? {};
        void finished;
        if (!(await store.update(id, session, latest.revision, { ...latest.data, pageOperations })))
            throw new ApplicationError('conflict', 'Draft changed; refresh to see page progress.');
        return ({ comic: view(latest.data, (await store.getPublished<Edition>(id)), latest.revision + 1) });
    }
    async function editPanel(session: Actor, id: string, itemId: string, payload: unknown = {}, expectedRevision?: number) {
        const { data, revision } = await owned(session, id, expectedRevision);
        const body = parse(payload, z.union([
            panelVersionSchema.extend({ instruction: z.string().trim().min(1).max(2000) }).strict(),
            z.object({ proposalId: z.string().uuid(), decision: z.literal('artwork_only') }).strict(),
        ]));
        requireClearNarrative(data);
        const panel = data.pages.flatMap(page => page.panels).find(panel => panel.id === itemId);
        if (!panel || !panel.assetId || panel.storyRevision !== data.storyRevision || (panel.status === 'outdated' || panel.status === 'checking'))
            throw new ApplicationError('conflict', 'Generate the current panel before editing its artwork.');
        let instruction: string, reviewed: z.infer<typeof panelVersionSchema>;
        if ('proposalId' in body) {
            const proposal = data.pendingArtworkDecision;
            if (!proposal || proposal.id !== body.proposalId || proposal.panelId !== panel.id || proposal.expiresAt <= Date.now())
                throw new ApplicationError('conflict', 'This edit choice has expired. Review the edit again.');
            reviewed = { assetId: proposal.assetId, storyRevision: proposal.storyRevision, panelRevision: proposal.panelRevision };
            instruction = proposal.instruction;
            if (panel.assetId !== reviewed.assetId || panel.revision !== reviewed.panelRevision || panel.storyRevision !== reviewed.storyRevision)
                throw new ApplicationError('conflict', 'This panel changed since you viewed it. Refresh and review the current image.');
            const { pendingArtworkDecision: _, ...rest } = data;
            void _;
            if (!(await store.update(id, session, revision, rest)))
                throw new ApplicationError('conflict', 'This draft changed. Refresh and review the edit again.');
        }
        else {
            reviewed = { assetId: body.assetId, storyRevision: body.storyRevision, panelRevision: body.panelRevision };
            instruction = body.instruction;
            if (panel.assetId !== reviewed.assetId || panel.revision !== reviewed.panelRevision || panel.storyRevision !== reviewed.storyRevision)
                throw new ApplicationError('conflict', 'This panel changed since you viewed it. Refresh and review the current image.');
            const spec = data.storyboard?.pages.flatMap(page => page.panels).find(item => item.id === panel.id);
            const intent = await withTextOperation(store, session, id, revision, async () => {
                const decision = await ai().classifyEdit({ instruction, panelContext: JSON.stringify({ beat: panel.beat, bible: data.storyboard?.bible, scene: spec }) });
                const latest = (await store.getOwned<Draft>(id, session));
                const current = latest?.data.pages.flatMap(page => page.panels).find(item => item.id === panel.id);
                if (!latest || !current || current.assetId !== reviewed.assetId || current.revision !== reviewed.panelRevision || current.storyRevision !== reviewed.storyRevision || latest.data.storyRevision !== reviewed.storyRevision)
                    throw new ApplicationError('conflict', 'This panel changed while checking the edit. Refresh and review the current image.');
                if (decision.intent === 'uncertain') {
                    const proposal = { id: deps.id(), panelId: panel.id, instruction, ...reviewed, expiresAt: Date.now() + 15 * 60 * 1000 };
                    if (!(await store.update(id, session, latest.revision, { ...latest.data, pendingArtworkDecision: proposal })))
                        throw new ApplicationError('conflict', 'Draft changed while checking the edit. Refresh and try again.');
                    return { ...decision, proposalId: proposal.id };
                }
                return decision;
            });
            if (intent.intent !== 'artwork')
                return ({ editDecision: { ...intent, panelId: panel.id, reviewedVersion: reviewed } });
        }
        await renderPanel(store, session, id, panel.id, instruction, reviewed);
        const latest = (await store.getOwned<Draft>(id, session))!;
        return ({ comic: view(latest.data, (await store.getPublished<Edition>(id)), latest.revision) });
    }
    async function acceptPanel(session: Actor, id: string, itemId: string, payload: unknown = {}, expectedRevision?: number) {
        const { data, revision } = await owned(session, id, expectedRevision);
        const reviewed = parse(payload, panelVersionSchema);
        const panel = data.pages.flatMap(p => p.panels).find(p => p.id === itemId);
        if (!panel || !panel.assetId)
            throw new ApplicationError('not_found', 'Panel image not found.');
        if (panel.assetId !== reviewed.assetId || panel.revision !== reviewed.panelRevision || panel.storyRevision !== reviewed.storyRevision || data.storyRevision !== reviewed.storyRevision)
            throw new ApplicationError('conflict', 'This panel changed since you reviewed it. Refresh and review the current image.');
        let updated: Draft;
        try {
            updated = acceptPanelInDomain(data, session, panel.id, reviewed.assetId, reviewed.storyRevision) as Draft;
        }
        catch {
            throw new ApplicationError('conflict', 'This panel cannot be accepted in its current state.');
        }
        return ({ comic: (await save(store, session, revision, updated)) });
    }
    async function publish(session: Actor, id: string, payload: unknown = {}, expectedRevision?: number) {
        const { data, revision } = await owned(session, id, expectedRevision);
        const body = parse(payload, publishSchema);
        const updated = { ...data, title: body.title, creatorName: body.creator };
        if (!updated.pages.length || updated.pages.some(page => !page.panels.length || page.panels.some(p => !p.assetId || p.storyRevision !== updated.storyRevision || !isPanelReady(p))))
            throw new ApplicationError('conflict', 'All current panels must be generated and reviewed before publishing.');
        const pageImages = await composePages(updated);
        const pages = pageImages.map(page => ({ id: page.id, assetId: deps.id(), image: page.image }));
        const composed = { ...updated, pages: updated.pages.map((page, i) => ({ ...page, composition: { assetId: pages[i].assetId, panelAssetIds: page.panels.map(panel => panel.assetId!) } })) };
        const editionId = deps.id();
        const validated = publishComic(composed, session, updated.storyRevision, editionId);
        if (!validated.published)
            throw new ApplicationError('conflict', 'This comic is not ready to publish.');
        const edition: Edition = { id, title: body.title, creator: body.creator || 'Anonymous', editionId, sourceRevision: revision + 1,
            pages: pages.map(p => ({ id: p.id, imageUrl: `/api/published/${encodeURIComponent(id)}/assets/${encodeURIComponent(p.assetId)}?edition=${encodeURIComponent(editionId)}`, storage: 'sqlite' })) };
        if (!(await store.publish(id, session, revision, edition, pages.map(p => ({ id: p.assetId, data: p.image })))))
            throw new ApplicationError('conflict', 'Draft changed while publishing; refresh and try again.');
        return ({ comic: view(data, edition, revision + 1) });
    }
    async function withdraw(session: Actor, id: string, payload: unknown = {}, expectedRevision?: number) {
        const { data, revision } = await owned(session, id, expectedRevision);
        parse(payload, z.object({}).strict());
        (await store.withdraw(id, session));
        return ({ comic: view(data, null, revision + 1) });
    }
    return { listStyles, create, list, get, getAsset, listPublished, getPublished, getPublishedAsset, update, initialQuestions, refreshQuestions, suggestCharacters, acceptStoryReview, planStory, generateReference, addCharacter, editCharacter: (actor: Actor, id: string, characterId: string, input: unknown, expectedRevision?: number) => changeCharacter(actor, id, characterId, input, 'PATCH', expectedRevision), removeCharacter: (actor: Actor, id: string, characterId: string, input: unknown = {}, expectedRevision?: number) => changeCharacter(actor, id, characterId, input, 'DELETE', expectedRevision), approveCharacter, previewRevision, applyRevision, downloadPage, generatePage, editPanel, acceptPanel, publish, withdraw };
}
