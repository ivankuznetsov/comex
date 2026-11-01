import { z } from 'zod';
import sharp from 'sharp';
import { AIError, type Storyboard, type Reference } from '../ai/service';
import {BudgetError} from '../budget';
import stylePresets from '../../../prompts/styles.json';
import { wrapDialogue } from '../lettering';
import { createBlankComic, createComic, commitPanelRender, acceptPanel as acceptPanelInDomain, reviseStory, publishComic, isPanelReady } from '../domain/comic';
import { ApplicationError, parse, pageIntentMatches, short, createSchema, patchSchema, characterSchema, panelVersionSchema, publishSchema, type Actor, type Character, type ComicDependencies, type ComicRepository, type Draft, type Edition, type PanelReview, type Json } from './contracts';
import { hasNarrativeBlocker, isStoryApproved, narrativeFingerprint, publicView, rawNarrativeBlocker, revisionPreview, storyFingerprint, view } from './views';
import {sameJson} from './json';
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
function requireClearNarrative(draft: Draft): void {
    if (hasNarrativeBlocker(draft))
        throw new ApplicationError('conflict', 'Resolve the story review blockers before generating artwork.');
}
function requireStoryApproval(draft: Draft): void {
    if (!isStoryApproved(draft))
        throw new ApplicationError('conflict', 'Review and approve the current story before generating artwork.');
}
function xml(value: string): string { if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(value))
    throw new ApplicationError('invalid_input', 'Dialogue includes a character that cannot be rendered.'); return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;'); }
export const durableComicServiceVersion='comex-durable-service-v1' as const;
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
    const asJson = (value:unknown):Json => JSON.parse(JSON.stringify(value)) as Json;
    function durable() { if (!deps.durable) throw new Error('Durable context is unavailable.'); return deps.durable; }
    async function checkpoint<T>(key:string, work:(repository:ComicRepository)=>Promise<T>):Promise<T> {
        return await durable().checkpoint(key, async repository => asJson(await work(repository))) as T;
    }
    async function prepared<T>(key:string, session:Actor, id:string, expectedRevision:number|undefined, validate:(record:{data:Draft;revision:number})=>T):Promise<T> {
        return checkpoint(key, async repository => {
            const record=await repository.getOwned<Draft>(id,session);
            if(!record)throw new ApplicationError('not_found','Comic not found.');
            if(expectedRevision!==undefined && record.revision!==expectedRevision)throw new ApplicationError('conflict','This draft changed. Refresh and try again.');
            return validate(record);
        });
    }
    async function current(session:Actor,id:string):Promise<{data:Draft;revision:number}> {
        const record=await store.getOwned<Draft>(id,session);
        if(!record)throw new ApplicationError('not_found','Comic not found.');
        return record;
    }
    async function viewCurrent(session:Actor,id:string) {const record=await current(session,id);return view(record.data,await store.getPublished<Edition>(id),record.revision);}
    const same=sameJson;
    const connectionRevoked=(error:unknown)=>error instanceof Error && error.message==='The connection was revoked or expired.';
    async function textStart(key:string,session:Actor,id:string,revision:number, marker?:'initialQuestions'|'initialSuggestions') {
        return checkpoint<{revision:number}>(`${key}/locked`,async tx=>{
            const record=await tx.getOwned<Draft>(id,session);
            if(!record || record.revision!==revision || !(await tx.reserveTextOperation(id,session,revision)))throw new ApplicationError('conflict','A story request is already running, has an unknown outcome, or the draft changed.');
            if(marker && !(await tx.update(id,session,revision,{...record.data,[marker]:'running'})))throw new ApplicationError('conflict','Draft changed before the request started.');
            return {revision:revision+(marker?1:0)};
        });
    }
    async function resumeText(key:string,session:Actor,id:string,steps:string[],marker?:'initialQuestions'|'initialSuggestions'):Promise<number|undefined> {
        let revision:number|undefined;
        for(const step of steps){
            if(await durable().load(`${key}/unknown/${step}`)===null)continue;
            const resumed=await checkpoint<{revision:number}>(`${key}/resumed/${step}`,async tx=>{
                const record=await tx.getOwned<Draft>(id,session);
                if(!record || (marker && record.data[marker]!=='unknown') || !tx.resumeTextOperation || !(await tx.resumeTextOperation(id,session)))throw new ApplicationError('conflict','The previous unknown request is not available to resume.');
                if(marker && !(await tx.update(id,session,record.revision,{...record.data,[marker]:'running'})))throw new ApplicationError('conflict','Draft changed while resuming the request.');
                return {revision:record.revision+(marker?1:0)};
            });revision=resumed.revision;
        }return revision;
    }
    async function textFailure(key:string,session:Actor,id:string,error:unknown,marker?:'initialQuestions'|'initialSuggestions',step='request') {
        if(!(error instanceof AIError) && !(error instanceof ApplicationError) && !(error instanceof BudgetError) && !connectionRevoked(error))return;
        const unknown=error instanceof AIError && (error.code==='unknown_outcome'||error.code==='invalid_response');
        await checkpoint(unknown?`${key}/unknown/${step}`:`${key}/failed`,async tx=>{
            const record=await tx.getOwned<Draft>(id,session);
            if(record && marker && (record.data[marker]==='running' || (marker==='initialQuestions' && unknown))) {
                if(!(await tx.update(id,session,record.revision,{...record.data,[marker]:unknown?'unknown':'failed'})))throw new ApplicationError('conflict','Draft changed while recording the request outcome.');
            }
            await tx.finishTextOperation(id,session,unknown);return {unknown};
        });
    }
    function questionInputsMatch(a:Draft,b:Draft) {return a.plot===b.plot && a.styleId===b.styleId && same(a.questions,b.questions) && same(a.answers,b.answers);}
    async function durableInitialQuestions(session:Actor,id:string,payload:unknown,expectedRevision?:number) {
        parse(payload,z.object({}).strict());
        const base=await prepared('initial/prepared',session,id,expectedRevision,record=>record);
        if(base.data.initialQuestions!=='pending'||await durable().load('initial/completed')!==null)return {comic:await viewCurrent(session,id)};
        await textStart('initial',session,id,base.revision,'initialQuestions');
        await resumeText('initial',session,id,['questions'],'initialQuestions');
        try {
            const latest=await current(session,id);
            if(latest.data.initialQuestions!=='running' || !questionInputsMatch(latest.data,base.data))throw new ApplicationError('conflict','Story changed while finding questions.');
            const input={plot:base.data.plot,style:base.data.styleId,answers:answeredQuestions(base.data),limit:5};
            const generated=await durable().paid({id:'initial/questions',input:asJson(input),expectedRevision:latest.revision},fetch=>deps.provider({fetch}).questions(input));
            await checkpoint('initial/completed',async tx=>{
                const now=await tx.getOwned<Draft>(id,session);
                if(!now || now.data.initialQuestions!=='running' || !questionInputsMatch(now.data,base.data))throw new ApplicationError('conflict','Story changed while finding questions.');
                const seen=new Set<string>();const questions=generated.filter(q=>{const key=q.question.trim().toLocaleLowerCase('en-US');if(seen.has(key))return false;seen.add(key);return true;}).map(q=>({...q,id:deps.id()}));
                if(!(await tx.update(id,session,now.revision,{...now.data,questions,initialQuestions:'complete'})))throw new ApplicationError('conflict','Draft changed while saving questions.');
                await tx.finishTextOperation(id,session,false);return {revision:now.revision+1};
            });
            return {comic:await viewCurrent(session,id)};
        } catch(error){await textFailure('initial',session,id,error,'initialQuestions','questions');throw error;}
    }
    async function durableRefreshQuestions(session:Actor,id:string,payload:unknown,expectedRevision?:number) {
        parse(payload,z.object({}).strict());const base=await prepared('refresh/prepared',session,id,expectedRevision,record=>record);
        if(await durable().load('refresh/completed')!==null)return {comic:await viewCurrent(session,id)};
        await textStart('refresh',session,id,base.revision);
        const resumedRevision=await resumeText('refresh',session,id,['questions'],'initialQuestions'),expected=resumedRevision??base.revision;
        try {
            const latest=await current(session,id);if(latest.revision!==expected || !questionInputsMatch(latest.data,base.data))throw new ApplicationError('conflict','Draft changed while finding questions.');
            const answered=base.data.questions.filter(q=>base.data.answers[q.id]?.trim()),limit=Math.max(0,5-answered.length);
            const input={plot:base.data.plot,style:base.data.styleId,answers:answeredQuestions(base.data),limit};
            const additions=limit?await durable().paid({id:'refresh/questions',input:asJson(input),expectedRevision:latest.revision},fetch=>deps.provider({fetch}).questions(input)):[];
            await checkpoint('refresh/completed',async tx=>{
                const now=await tx.getOwned<Draft>(id,session);if(!now || now.revision!==expected || !questionInputsMatch(now.data,base.data))throw new ApplicationError('conflict','Draft changed while finding questions.');
                const seen=new Set(answered.map(q=>q.question.trim().toLocaleLowerCase('en-US'))),questions=[...answered];
                for(const q of additions){const key=q.question.trim().toLocaleLowerCase('en-US');if(!seen.has(key)){seen.add(key);questions.push({...q,id:deps.id()});}}
                const answers=Object.fromEntries(answered.map(q=>[q.id,base.data.answers[q.id]]));
                if(!(await tx.update(id,session,now.revision,{...now.data,questions,answers,initialQuestions:'complete'})))throw new ApplicationError('conflict','Draft changed while saving questions.');
                await tx.finishTextOperation(id,session,false);return {revision:now.revision+1};
            });return {comic:await viewCurrent(session,id)};
        } catch(error){await textFailure('refresh',session,id,error,'initialQuestions','questions');throw error;}
    }
    async function durableSuggestions(session:Actor,id:string,payload:unknown,expectedRevision?:number) {
        const body=parse(payload,z.object({retry:z.boolean().optional()}).strict());
        const base=await prepared('suggestions/prepared',session,id,expectedRevision,record=>{
            const data=record.data;if(data.pages.length)throw new ApplicationError('conflict','Character changes require a story revision.');
            if(data.initialQuestions==='running'||data.initialQuestions==='pending')throw new ApplicationError('conflict','Wait for story questions first.');
            if(data.initialSuggestions==='unknown')throw new ApplicationError('conflict','Resolve the previous character suggestion request before trying again.');
            return record;
        });
        if(await durable().load('suggestions/completed')!==null)return {comic:await viewCurrent(session,id)};
        if(base.data.initialSuggestions==='running'||(base.data.initialSuggestions==='complete'&&!body.retry)||(base.data.initialSuggestions!=='pending'&&!body.retry))return {comic:await viewCurrent(session,id)};
        await textStart('suggestions',session,id,base.revision,'initialSuggestions');
        await resumeText('suggestions',session,id,['suggestions'],'initialSuggestions');
        try {
            const latest=await current(session,id);if(latest.data.initialSuggestions!=='running'||latest.data.pages.length||!questionInputsMatch(latest.data,base.data))throw new ApplicationError('conflict','Story changed while suggesting characters.');
            const input={plot:base.data.plot,style:base.data.styleId,answers:answeredQuestions(base.data),existingCharacters:base.data.characters.map(({name,role})=>({name,role}))};
            const generated=await durable().paid({id:'suggestions',input:asJson(input),expectedRevision:latest.revision},fetch=>deps.provider({fetch}).characterSuggestions(input));
            await checkpoint('suggestions/completed',async tx=>{
                const now=await tx.getOwned<Draft>(id,session);if(!now||now.data.initialSuggestions!=='running'||now.data.pages.length||!questionInputsMatch(now.data,base.data))throw new ApplicationError('conflict','Story changed while suggesting characters.');
                const seen=new Set<string>(),characterSuggestions=generated.filter(card=>{const key=card.name.toLocaleLowerCase('en-US');if(seen.has(key))return false;seen.add(key);return true;}).map(card=>({id:deps.id(),...card}));
                if(!(await tx.update(id,session,now.revision,{...now.data,characterSuggestions,initialSuggestions:'complete'})))throw new ApplicationError('conflict','Draft changed while saving character suggestions.');
                await tx.finishTextOperation(id,session,false);return {revision:now.revision+1};
            });return {comic:await viewCurrent(session,id)};
        } catch(error){await textFailure('suggestions',session,id,error,'initialSuggestions','suggestions');throw error;}
    }
    async function durablePlanStory(session:Actor,id:string,payload:unknown,expectedRevision?:number) {
        parse(payload,z.object({}).strict());const base=await prepared('story/prepared',session,id,expectedRevision,record=>{
            const data=record.data;if(data.pages.length)throw new ApplicationError('conflict','Use story revision to change existing pages.');
            if(!data.characters.length||data.characters.some(c=>!c.approved||!c.referenceAssetId))throw new ApplicationError('conflict','Approve reference images for every selected character first.');
            if(data.characters.some(c=>data.operations?.[`character:${c.id}`]))throw new ApplicationError('conflict','Resolve character reference requests before planning the story.');
            return record;
        });
        if(await durable().load('story/completed')!==null)return {comic:await viewCurrent(session,id)};
        await textStart('story',session,id,base.revision);let step='plan';
        await resumeText('story',session,id,['plan','narrative']);
        try {
            let latest=await current(session,id);if(latest.revision!==base.revision)throw new ApplicationError('conflict','Draft changed while planning the story.');
            const input={plot:base.data.plot,answers:answeredQuestions(base.data),styleRules:styleRules(base.data.styleId),characters:base.data.characters,pageCount:3,panelsPerPage:base.data.panelsPerPage??3};
            const generated=await durable().paid({id:'story/plan',input:asJson(input),expectedRevision:latest.revision},fetch=>deps.provider({fetch}).storyboard(input));
            const storyboard={...generated,pages:generated.pages.map(page=>({...page,panels:page.panels.map(normalizePanelLedger)}))};
            const errors=validateStoryLedger(storyboard);if(errors.length)throw new ApplicationError('invalid_story',`Story state needs correction: ${errors[0]}`);
            latest=await current(session,id);if(latest.revision!==base.revision)throw new ApplicationError('conflict','Draft changed while planning the story.');
            const reviewInput={creatorGoal:base.data.plot,answers:answeredQuestions(base.data),bible:storyboard.bible,beats:storyboard.pages};
            step='narrative';let storyReview:unknown;try{storyReview=await durable().paid({id:'story/narrative',input:asJson(reviewInput),expectedRevision:latest.revision},fetch=>deps.provider({fetch}).narrativeJudge(reviewInput));}catch(error){if(!(error instanceof AIError)&&!(error instanceof BudgetError))throw error;storyReview=inconclusiveReview(error);}
            await checkpoint('story/completed',async tx=>{
                const now=await tx.getOwned<Draft>(id,session);if(!now||now.revision!==base.revision)throw new ApplicationError('conflict','Draft changed while planning the story.');
                const planned=createComic({id,ownerId:session,title:base.data.title,creatorName:base.data.creatorName,plot:base.data.plot,styleId:base.data.styleId,pages:storyboard.pages.map(page=>({id:deps.id(),panels:page.panels.map(panel=>({id:panel.id,beat:panel.action}))}))});
                if(!(await tx.update(id,session,now.revision,{...now.data,...planned,storyboard,storyReview,storyReviewAcceptance:undefined,storyApproval:null})))throw new ApplicationError('conflict','Draft changed while planning the story.');
                await tx.finishTextOperation(id,session,false);return {revision:now.revision+1};
            });return {comic:await viewCurrent(session,id)};
        } catch(error){await textFailure('story',session,id,error,undefined,step);throw error;}
    }
    async function durablePreviewRevision(session:Actor,id:string,payload:unknown,expectedRevision?:number) {
        const body=parse(payload,z.object({panelId:short,instruction:z.string().trim().min(1).max(4000),reviewedVersion:panelVersionSchema.optional()}).strict()),prefix=`revision/${body.panelId}/preview`;
        const base=await prepared(`${prefix}/prepared`,session,id,expectedRevision,record=>{
            const data=record.data;if(!data.storyboard)throw new ApplicationError('conflict','Plan the story before revising it.');
            if(body.reviewedVersion){const p=data.pages.flatMap(page=>page.panels).find(panel=>panel.id===body.panelId);if(!p||p.assetId!==body.reviewedVersion.assetId||p.storyRevision!==body.reviewedVersion.storyRevision||p.revision!==body.reviewedVersion.panelRevision||data.storyRevision!==body.reviewedVersion.storyRevision)throw new ApplicationError('conflict','This panel changed since you viewed it. Refresh and review the current image.');}
            return record;
        });
        const done=await durable().load(`${prefix}/completed`) as {proposal:NonNullable<ReturnType<typeof revisionPreview>>}|null;
        if(done){const latest=await current(session,id);return {proposal:latest.data.pendingRevision?.id===done.proposal.id?revisionPreview(latest.data,latest.revision)!:{...done.proposal,current:false}};}
        await textStart(prefix,session,id,base.revision);
        await resumeText(prefix,session,id,['preview']);
        try {
            const now=await current(session,id);if(now.revision!==base.revision)throw new ApplicationError('conflict','Draft changed while planning the revision.');
            const input={storyboard:base.data.storyboard!,firstPanelId:body.panelId,instruction:body.instruction,characters:base.data.characters};
            const generated=await durable().paid({id:prefix,input:asJson(input),expectedRevision:now.revision},fetch=>deps.provider({fetch}).revision(input));
            const result={...generated,revised_suffix:generated.revised_suffix.map(normalizePanelLedger)},changed=new Map(result.revised_suffix.map(panel=>[panel.id,panel]));
            const proposed:Storyboard={...input.storyboard,bible:result.revised_bible,pages:input.storyboard.pages.map(page=>({...page,panels:page.panels.map(panel=>changed.get(panel.id)??panel)}))};
            const errors=validateStoryLedger(proposed);if(errors.length)throw new ApplicationError('invalid_story',`Revised story state needs correction: ${errors[0]}`);
            if(base.data.pages.findIndex(page=>page.panels.some(panel=>panel.id===result.earliest_affected_panel_id))<0)throw new ApplicationError('invalid_story','Revision points to a missing panel.');
            return await checkpoint(`${prefix}/completed`,async tx=>{
                const latest=await tx.getOwned<Draft>(id,session);if(!latest||latest.revision!==base.revision)throw new ApplicationError('conflict','Draft changed while planning the revision; refresh and try again.');
                const proposal={id:deps.id(),baseRevision:latest.revision+1,baseStoryRevision:base.data.storyRevision,result};
                const pendingArtworkDecision=base.data.pendingArtworkDecision?.panelId===body.panelId&&base.data.pendingArtworkDecision.instruction===body.instruction?undefined:base.data.pendingArtworkDecision;
                const updated={...latest.data,pendingRevision:proposal,pendingArtworkDecision};
                if(!(await tx.update(id,session,latest.revision,updated)))throw new ApplicationError('conflict','Draft changed while planning the revision; refresh and try again.');
                await tx.finishTextOperation(id,session,false);return {proposal:revisionPreview(updated,latest.revision+1)!};
            });
        } catch(error){await textFailure(prefix,session,id,error,undefined,'preview');throw error;}
    }
    async function durableApplyRevision(session:Actor,id:string,payload:unknown,expectedRevision?:number) {
        const body=parse(payload,z.object({proposalId:short}).strict()),prefix=`revision/${body.proposalId}`;
        const base=await prepared(`${prefix}/prepared`,session,id,expectedRevision,record=>{
            const proposal=record.data.pendingRevision;if(!proposal||proposal.id!==body.proposalId||proposal.baseRevision!==record.revision||!record.data.storyboard)throw new ApplicationError('conflict','Revision preview expired. Preview the changes again.');
            return {...record,proposal};
        });
        const finished=await durable().load(`${prefix}/finished`) as {notice:string}|null;
        if(finished)return {comic:await viewCurrent(session,id),notice:finished.notice};
        let applied=await durable().load(`${prefix}/applied`) as {next:Draft}|null;
        if(!applied){
            await textStart(prefix,session,id,base.revision);
            await resumeText(prefix,session,id,['narrative']);
            try {
                const changed=new Map(base.proposal.result.revised_suffix.map(panel=>[panel.id,panel]));
                const storyboard:Storyboard={...base.data.storyboard!,bible:base.proposal.result.revised_bible,pages:base.data.storyboard!.pages.map(page=>({...page,panels:page.panels.map(panel=>changed.get(panel.id)??panel)}))};
                const errors=validateStoryLedger(storyboard);if(errors.length)throw new ApplicationError('invalid_story',`Revised story state needs correction: ${errors[0]}`);
                const beats=Object.fromEntries(base.proposal.result.revised_suffix.map(panel=>[panel.id,panel.action]));
                const updated=reviseStory(base.data,session,base.data.storyRevision,base.proposal.result.earliest_affected_panel_id,beats) as Draft;
                const latest=await current(session,id);if(latest.revision!==base.revision)throw new ApplicationError('conflict','Draft changed while applying revision; preview it again.');
                const input={creatorGoal:base.data.plot,answers:answeredQuestions(base.data),bible:storyboard.bible,beats:storyboard.pages};
                let storyReview:unknown;try{storyReview=await durable().paid({id:`${prefix}/narrative`,input:asJson(input),expectedRevision:latest.revision},fetch=>deps.provider({fetch}).narrativeJudge(input));}catch(error){if(!(error instanceof AIError)&&!(error instanceof BudgetError))throw error;storyReview=inconclusiveReview(error);}
                const next:Draft={...updated,storyboard,storyReview,storyReviewAcceptance:undefined,pendingRevision:undefined,pageOperations:undefined};
                const fingerprint=storyFingerprint(next);if(!fingerprint)throw new ApplicationError('conflict','The revised story is missing.');next.storyApproval={storyRevision:next.storyRevision,fingerprint};
                applied=await checkpoint(`${prefix}/applied`,async tx=>{
                    const now=await tx.getOwned<Draft>(id,session);if(!now||now.revision!==base.revision||!(await tx.update(id,session,now.revision,next)))throw new ApplicationError('conflict','Draft changed while applying revision; preview it again.');
                    await tx.finishTextOperation(id,session,false);return {next};
                });
            } catch(error){await textFailure(prefix,session,id,error,undefined,'narrative');throw error;}
        }
        const next=applied.next,latest=await current(session,id);
        if(latest.data.storyRevision!==next.storyRevision||storyFingerprint(latest.data)!==storyFingerprint(next))throw new ApplicationError('conflict','Story changed while continuing the revision.');
        const firstPage=next.pages.findIndex(page=>page.panels.some(panel=>panel.id===base.proposal.result.earliest_affected_panel_id));
        const previousReady=firstPage===0||next.pages[firstPage-1].panels.every(p=>p.storyRevision===next.storyRevision&&isPanelReady(p));let notice='';
        if(previousReady&&!hasNarrativeBlocker(next)) {
            const pagePanels=next.pages[firstPage].panels,affected=pagePanels.findIndex(panel=>panel.id===base.proposal.result.earliest_affected_panel_id),incomplete=pagePanels.findIndex(panel=>!panel.assetId||panel.status==='outdated'||panel.status==='planned'),first=incomplete>=0?Math.min(incomplete,affected):affected;
            for(const panel of pagePanels.slice(first)){
                try{await durableRenderPanel(session,id,panel.id);}catch(error){if(error instanceof AIError&&(error.code==='unknown_outcome'||error.code==='invalid_response'))throw error;if(!(error instanceof ApplicationError)&&!(error instanceof AIError)&&!(error instanceof BudgetError))throw error;notice='Story change saved, but artwork did not finish. Review the page and resolve any outstanding operation before continuing.';break;}
                const currentPanel=(await current(session,id)).data.pages[firstPage].panels.find(p=>p.id===panel.id);
                if(!currentPanel||(currentPanel.evaluation==='blocker'&&!isPanelReady(currentPanel))){notice='Story change saved. Review the panel blocker before continuing the page.';break;}
            }
        }
        notice ||= hasNarrativeBlocker(next)?'Resolve the story review blockers before generating artwork.':'Later pages remain outdated until you review the preceding page and generate them.';
        await checkpoint(`${prefix}/finished`,async()=>({notice}));return {comic:await viewCurrent(session,id),notice};
    }
    async function durableEditPanel(session:Actor,id:string,itemId:string,payload:unknown,expectedRevision?:number) {
        const body=parse(payload,z.union([panelVersionSchema.extend({instruction:z.string().trim().min(1).max(2000)}).strict(),z.object({proposalId:z.string().uuid(),decision:z.literal('artwork_only')}).strict()])),prefix=`edit/${itemId}`;
        const base=await prepared(`${prefix}/prepared`,session,id,expectedRevision,record=>{
            const data=record.data;requireStoryApproval(data);requireClearNarrative(data);
            const panel=data.pages.flatMap(page=>page.panels).find(p=>p.id===itemId);
            if(!panel||!panel.assetId||panel.storyRevision!==data.storyRevision||panel.status==='outdated'||panel.status==='checking')throw new ApplicationError('conflict','Generate the current panel before editing its artwork.');
            let instruction:string,reviewed:z.infer<typeof panelVersionSchema>;
            if('proposalId' in body){const proposal=data.pendingArtworkDecision;if(!proposal||proposal.id!==body.proposalId||proposal.panelId!==itemId||proposal.intent==='story'||proposal.expiresAt<=Date.now())throw new ApplicationError('conflict','This edit choice has expired. Review the edit again.');instruction=proposal.instruction;reviewed={assetId:proposal.assetId,storyRevision:proposal.storyRevision,panelRevision:proposal.panelRevision};}
            else {instruction=body.instruction;reviewed={assetId:body.assetId,storyRevision:body.storyRevision,panelRevision:body.panelRevision};}
            if(panel.assetId!==reviewed.assetId||panel.revision!==reviewed.panelRevision||panel.storyRevision!==reviewed.storyRevision)throw new ApplicationError('conflict','This panel changed since you viewed it. Refresh and review the current image.');
            return {...record,panel,instruction,reviewed};
        });
        if('proposalId' in body){
            await checkpoint(`${prefix}/decision-cleared`,async tx=>{const latest=await tx.getOwned<Draft>(id,session);if(!latest||latest.revision!==base.revision)throw new ApplicationError('conflict','This draft changed. Refresh and review the edit again.');const {pendingArtworkDecision:ignored,...rest}=latest.data;void ignored;if(!(await tx.update(id,session,latest.revision,rest)))throw new ApplicationError('conflict','This draft changed. Refresh and review the edit again.');return {revision:latest.revision+1};});
        } else {
            let decision=await durable().load(`${prefix}/classified`) as {intent:'artwork'|'story'|'uncertain';reason:string;proposalId?:string}|null;
            if(!decision){
                await textStart(prefix,session,id,base.revision);
                await resumeText(prefix,session,id,['classify']);
                try {
                    const now=await current(session,id),panel=now.data.pages.flatMap(page=>page.panels).find(p=>p.id===itemId);
                    if(!panel||panel.assetId!==base.reviewed.assetId||panel.revision!==base.reviewed.panelRevision||panel.storyRevision!==base.reviewed.storyRevision||now.data.storyRevision!==base.reviewed.storyRevision)throw new ApplicationError('conflict','This panel changed while checking the edit. Refresh and review the current image.');
                    const spec=base.data.storyboard?.pages.flatMap(page=>page.panels).find(p=>p.id===itemId),input={instruction:base.instruction,panelContext:JSON.stringify({beat:base.panel.beat,bible:base.data.storyboard?.bible,scene:spec})};
                    const result=await durable().paid({id:`panel/${itemId}/classify`,input:asJson(input),expectedRevision:now.revision},fetch=>deps.provider({fetch}).classifyEdit(input));
                    decision=await checkpoint(`${prefix}/classified`,async tx=>{
                        const latest=await tx.getOwned<Draft>(id,session),panel=latest?.data.pages.flatMap(page=>page.panels).find(p=>p.id===itemId);
                        if(!latest||!panel||panel.assetId!==base.reviewed.assetId||panel.revision!==base.reviewed.panelRevision||panel.storyRevision!==base.reviewed.storyRevision||latest.data.storyRevision!==base.reviewed.storyRevision)throw new ApplicationError('conflict','This panel changed while checking the edit. Refresh and review the current image.');
                        let proposalId:string|undefined;
                        if(result.intent==='uncertain'||result.intent==='story'){proposalId=deps.id();const proposal={id:proposalId,panelId:itemId,instruction:base.instruction,...base.reviewed,reason:result.reason,intent:result.intent,expiresAt:Date.now()+15*60*1000};if(!(await tx.update(id,session,latest.revision,{...latest.data,pendingArtworkDecision:proposal})))throw new ApplicationError('conflict','Draft changed while checking the edit. Refresh and try again.');}
                        await tx.finishTextOperation(id,session,false);return {...result,...(proposalId?{proposalId}:{})};
                    });
                }catch(error){await textFailure(prefix,session,id,error,undefined,'classify');throw error;}
            }
            if(decision.intent!=='artwork'){
                const latest=await current(session,id),panel=latest.data.pages.flatMap(page=>page.panels).find(p=>p.id===itemId),proposal=latest.data.pendingArtworkDecision;
                if(!panel||panel.assetId!==base.reviewed.assetId||panel.revision!==base.reviewed.panelRevision||panel.storyRevision!==base.reviewed.storyRevision||latest.data.storyRevision!==base.reviewed.storyRevision||!proposal||proposal.id!==decision.proposalId||proposal.expiresAt<=Date.now())throw new ApplicationError('conflict','This edit choice has expired. Review the edit again.');
                return {editDecision:{...decision,panelId:itemId,instruction:base.instruction,reviewedVersion:base.reviewed,choices:decision.intent==='uncertain'?['preview_story','artwork_only']:['preview_story']}};
            }
        }
        await durableRenderPanel(session,id,itemId,base.instruction,base.reviewed);return {comic:await viewCurrent(session,id)};
    }
    async function durableReference(session:Actor,id:string,itemId:string,payload:unknown,expectedRevision?:number) {
        parse(payload,z.object({}).strict());const prefix=`character/${itemId}`;
        const base=await prepared(`${prefix}/prepared`,session,id,expectedRevision,record=>{
            if(record.data.pages.length)throw new ApplicationError('conflict','Character changes require a story revision.');
            const character=record.data.characters.find(c=>c.id===itemId);if(!character)throw new ApplicationError('not_found','Character not found.');
            if(record.data.operations?.[`character:${itemId}`])throw new ApplicationError('conflict','This image request is already running or has an unknown outcome.');
            return {...record,character};
        });
        if(await durable().load(`${prefix}/associated`)!==null)return {comic:await viewCurrent(session,id)};
        const op=`character:${itemId}`;
        const reservation=await checkpoint<{revision:number;marker:string}>(`${prefix}/reserved`,async tx=>{
            const now=await tx.getOwned<Draft>(id,session),marker=deps.id();
            if(!now || now.revision!==base.revision || !(await tx.update(id,session,now.revision,{...now.data,operations:{...now.data.operations,[op]:'running'},durableOperationMarkers:{...now.data.durableOperationMarkers,[op]:marker}})))throw new ApplicationError('conflict','Draft changed; refresh and try again.');
            return {revision:now.revision+1,marker};
        });
        try {
            const step=`${prefix}/reference`,priorUnknown=await durable().load(`${prefix}/unknown`) as {marker:string}|null;
            if(priorUnknown){
                const state=await durable().stepState?.(step) ?? (await durable().assetIdFor?.(step) ? 'completed' : null);
                if(priorUnknown.marker!==reservation.marker || (state==='completed' && !await durable().assetIdFor?.(step)))throw new ApplicationError('conflict','The previous unknown reference is not available to resume.');
                if(state!=='completed' && state!=='failed')throw new AIError('unknown_outcome','The previous reference outcome is still unknown.');
                await checkpoint(`${prefix}/resumed`,async tx=>{const now=await tx.getOwned<Draft>(id,session);if(!now||now.data.operations?.[op]!=='unknown_outcome'||now.data.durableOperationMarkers?.[op]!==reservation.marker)throw new ApplicationError('conflict','The previous unknown reference is not available to resume.');if(!(await tx.update(id,session,now.revision,{...now.data,operations:{...now.data.operations,[op]:'running'}})))throw new ApplicationError('conflict','Draft changed while resuming the reference.');return {revision:now.revision+1};});
            }
            const valid=(data:Draft)=>data.operations?.[op]==='running' && data.durableOperationMarkers?.[op]===reservation.marker && !data.pages.length && data.styleId===base.data.styleId && same(data.characters.find(c=>c.id===itemId),base.character);
            const now=await current(session,id);if(!valid(now.data))throw new ApplicationError('conflict','Character inputs changed while rendering; the result was not applied.');
            const input={character:base.character,styleRules:styleRules(base.data.styleId)};
            const bytes=await durable().paid({id:step,input:asJson(input),expectedRevision:now.revision},fetch=>deps.provider({fetch}).characterReference(input));
            if(!Buffer.isBuffer(bytes)||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new ApplicationError('invalid_provider_response','Image provider did not return a PNG.');
            const assetId=await durable().assetIdFor?.(step);if(!assetId)throw new Error('The durable reference asset is unavailable.');
            await checkpoint(`${prefix}/associated`,async tx=>{
                const latest=await tx.getOwned<Draft>(id,session);if(!latest||!valid(latest.data))throw new ApplicationError('conflict','Character inputs changed while rendering; the result was not applied.');
                const {[op]:ignored,...operations}=latest.data.operations??{};void ignored;const {[op]:marker,...durableOperationMarkers}=latest.data.durableOperationMarkers??{};void marker;
                const characters=latest.data.characters.map(c=>c.id===itemId?{...c,approved:false,referenceAssetId:assetId,referenceUrl:`/api/comics/${encodeURIComponent(id)}/assets/${assetId}`}:c);
                if(!(await tx.update(id,session,latest.revision,{...latest.data,characters,operations,durableOperationMarkers})))throw new ApplicationError('conflict','Draft changed while saving the reference.');
                return {assetId,revision:latest.revision+1};
            });return {comic:await viewCurrent(session,id)};
        } catch(error){
            if(error instanceof AIError || error instanceof ApplicationError || error instanceof BudgetError || connectionRevoked(error)){
                const unknown=error instanceof AIError && (error.code==='unknown_outcome'||error.code==='invalid_response');
                await checkpoint(`${prefix}/${unknown?'unknown':'failed'}`,async tx=>{
                    const latest=await tx.getOwned<Draft>(id,session);if(latest?.data.operations?.[op]==='running'&&latest.data.durableOperationMarkers?.[op]===reservation.marker){
                        const operations={...latest.data.operations},markers={...latest.data.durableOperationMarkers};if(unknown)operations[op]='unknown_outcome';else {delete operations[op];delete markers[op];}
                        if(!(await tx.update(id,session,latest.revision,{...latest.data,operations,durableOperationMarkers:markers})))throw new ApplicationError('conflict','Draft changed while recording the reference outcome.');
                    }return {marker:reservation.marker};
                });
            }throw error;
        }
    }
    async function durableRenderPanel(session:Actor,comicId:string,panelId:string,editInstruction?:string,expectedVersion?:z.infer<typeof panelVersionSchema>) {
        const prefix=`panel/${panelId}`;
        const base=await prepared(`${prefix}/prepared`,session,comicId,undefined,record=>{
            const draft=record.data;if(!draft.storyboard)throw new ApplicationError('conflict','Plan the story first.');
            requireStoryApproval(draft);requireClearNarrative(draft);
            const panels=draft.pages.flatMap(page=>page.panels),index=panels.findIndex(panel=>panel.id===panelId);
            if(index<0)throw new ApplicationError('not_found','Panel not found.');const panel=panels[index],previous=index>0?panels[index-1]:undefined;
            if(panel.status==='checking')throw new ApplicationError('conflict','Wait for the panel review to finish.');
            if(expectedVersion&&(panel.assetId!==expectedVersion.assetId||panel.revision!==expectedVersion.panelRevision||panel.storyRevision!==expectedVersion.storyRevision||draft.storyRevision!==expectedVersion.storyRevision))throw new ApplicationError('conflict','Panel changed while planning the edit; refresh and review it again.');
            if(previous&&(!previous.assetId||previous.storyRevision!==draft.storyRevision||['outdated','planned','checking'].includes(previous.status)))throw new ApplicationError('conflict','Generate and review earlier panels first.');
            if(previous?.evaluation==='blocker'&&!isPanelReady(previous))throw new ApplicationError('conflict','Review the preceding panel before generating this one.');
            const spec=draft.storyboard.pages.flatMap(page=>page.panels).find(panel=>panel.id===panelId);if(!spec)throw new ApplicationError('conflict','The storyboard does not match this panel.');
            const {dialogue:_dialogue,...visualSpec}=spec;void _dialogue;
            const characters=draft.characters.filter(c=>spec.character_ids.includes(c.id));
            if(characters.length!==spec.character_ids.length||characters.some(c=>!c.approved||!c.referenceAssetId))throw new ApplicationError('conflict','Approve all character references first.');
            const anchors=characters.length?characters:draft.characters.filter(c=>c.approved&&c.referenceAssetId).slice(0,1);
            if(draft.operations?.[`panel:${panelId}`])throw new ApplicationError('conflict','This panel request is already running or has an unknown outcome.');
            return {...record,panel,previous:previous??null,spec,visualSpec,characters,anchors};
        });
        if(await durable().load(`${prefix}/reviewed`)!==null)return;
        const op=`panel:${panelId}`;let imageMarker:string|undefined;const originalValid=(draft:Draft)=>{
            const panels=draft.pages.flatMap(page=>page.panels),index=panels.findIndex(panel=>panel.id===panelId),previous=index>0?panels[index-1]:undefined;
            return !!imageMarker&&draft.operations?.[op]==='running'&&draft.durableOperationMarkers?.[op]===imageMarker&&draft.storyRevision===base.data.storyRevision&&draft.styleId===base.data.styleId&&same(draft.storyboard,base.data.storyboard)&&same(draft.characters,base.data.characters)&&same(panels[index],base.panel)&&same(previous??null,base.previous)&&isStoryApproved(draft)&&!hasNarrativeBlocker(draft);
        };
        let associated=await durable().load(`${prefix}/image-associated`) as {assetId:string}|null;
        if(!associated){
            const reservation=await checkpoint<{revision:number;marker:string}>(`${prefix}/reserved`,async tx=>{
                const now=await tx.getOwned<Draft>(comicId,session),marker=deps.id();if(!now||now.revision!==base.revision||!(await tx.update(comicId,session,now.revision,{...now.data,operations:{...now.data.operations,[op]:'running'},durableOperationMarkers:{...now.data.durableOperationMarkers,[op]:marker}})))throw new ApplicationError('conflict','Draft changed; refresh and try again.');
                return {revision:now.revision+1,marker};
            });imageMarker=reservation.marker;
            try {
                const priorUnknown=await durable().load(`${prefix}/image-unknown`) as {marker:string}|null;
                if(priorUnknown){
                    const step=`${prefix}/image`,state=await durable().stepState?.(step) ?? (await durable().assetIdFor?.(step) ? 'completed' : null);
                    if(priorUnknown.marker!==reservation.marker || (state==='completed' && !await durable().assetIdFor?.(step)))throw new ApplicationError('conflict','The previous unknown panel is not available to resume.');
                    if(state!=='completed' && state!=='failed')throw new AIError('unknown_outcome','The previous panel outcome is still unknown.');
                    await checkpoint(`${prefix}/image-resumed`,async tx=>{const now=await tx.getOwned<Draft>(comicId,session);if(!now||now.data.operations?.[op]!=='unknown_outcome'||now.data.durableOperationMarkers?.[op]!==reservation.marker)throw new ApplicationError('conflict','The previous unknown panel is not available to resume.');if(!(await tx.update(comicId,session,now.revision,{...now.data,operations:{...now.data.operations,[op]:'running'}})))throw new ApplicationError('conflict','Draft changed while resuming the panel.');return {revision:now.revision+1};});
                }
                const now=await current(session,comicId);if(!originalValid(now.data))throw new ApplicationError('conflict','Panel inputs changed while rendering; the result was not applied.');
                const referenceIds=[...base.anchors.map(c=>({role:'approved character',id:c.id,assetId:c.referenceAssetId!})),...(base.previous?.assetId?[{role:'previous panel',id:base.previous.id,assetId:base.previous.assetId}]:[])];
                const input={editInstruction:editInstruction??null,styleRules:styleRules(base.data.styleId),panelSpec:base.visualSpec,sceneBefore:base.spec.state_before,characters:base.characters,references:referenceIds,targetAssetId:base.panel.assetId??null};
                const bytes=await durable().paid({id:`${prefix}/image`,input:asJson(input),expectedRevision:now.revision},async fetch=>{
                    const refs:Reference[]=await Promise.all(referenceIds.map(async ref=>({role:ref.role,id:ref.id,bytes:await asset(ref.assetId),mimeType:'image/png' as const})));
                    return editInstruction?deps.provider({fetch}).editPanel({change:editInstruction,preserve:JSON.stringify({style:styleRules(base.data.styleId),panel:base.visualSpec,characters:base.characters}),references:[{role:'target panel',id:panelId,bytes:await asset(base.panel.assetId!),mimeType:'image/png'},...refs]}):deps.provider({fetch}).panel({styleRules:styleRules(base.data.styleId),panelSpec:JSON.stringify(base.visualSpec),sceneBefore:JSON.stringify(base.spec.state_before),characters:base.characters,references:refs});
                });
                if(!Buffer.isBuffer(bytes)||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new ApplicationError('invalid_provider_response','Image provider did not return a PNG.');
                const assetId=await durable().assetIdFor?.(`${prefix}/image`);if(!assetId)throw new Error('The durable panel asset is unavailable.');
                associated=await checkpoint(`${prefix}/image-associated`,async tx=>{
                    const latest=await tx.getOwned<Draft>(comicId,session);if(!latest||!originalValid(latest.data))throw new ApplicationError('conflict','Panel inputs changed while rendering; the result was not applied.');
                    const updated=commitPanelRender(latest.data,session,panelId,{storyRevision:base.data.storyRevision,panelRevision:base.panel.revision},assetId,'uncertain') as Draft;
                    const {[op]:ignored,...operations}=updated.operations??{};void ignored;const {[op]:marker,...durableOperationMarkers}=updated.durableOperationMarkers??{};void marker;
                    const pages=updated.pages.map(page=>({...page,panels:page.panels.map(p=>p.id===panelId?{...p,status:'checking' as const}:p)}));
                    const {[panelId]:oldReview,...panelReviews}=updated.panelReviews??{};void oldReview;
                    const pendingArtworkDecision=updated.pendingArtworkDecision?.panelId===panelId?undefined:updated.pendingArtworkDecision;
                    if(!(await tx.update(comicId,session,latest.revision,{...updated,pages,panelFindings:{...updated.panelFindings,[panelId]:[]},panelReviews,operations,durableOperationMarkers,pendingArtworkDecision})))throw new ApplicationError('conflict','Draft changed while saving the panel.');
                    return {assetId};
                });
            } catch(error){
                if(error instanceof AIError||error instanceof ApplicationError||error instanceof BudgetError||connectionRevoked(error)){const unknown=error instanceof AIError&&(error.code==='unknown_outcome'||error.code==='invalid_response');
                    await checkpoint(`${prefix}/image-${unknown?'unknown':'failed'}`,async tx=>{const latest=await tx.getOwned<Draft>(comicId,session);if(latest?.data.operations?.[op]==='running'&&latest.data.durableOperationMarkers?.[op]===reservation.marker){const operations={...latest.data.operations},markers={...latest.data.durableOperationMarkers};if(unknown)operations[op]='unknown_outcome';else {delete operations[op];delete markers[op];}if(!(await tx.update(comicId,session,latest.revision,{...latest.data,operations,durableOperationMarkers:markers})))throw new ApplicationError('conflict','Draft changed while recording the image outcome.');}return {marker:reservation.marker};});
                }throw error;
            }
        }
        const assetId=associated.assetId;
        const reviewValid=(draft:Draft)=>{
            const panels=draft.pages.flatMap(page=>page.panels),index=panels.findIndex(panel=>panel.id===panelId),p=panels[index],previous=index>0?panels[index-1]:undefined;
            const previousUnchanged=base.previous?!!previous&&previous.id===base.previous.id&&previous.assetId===base.previous.assetId&&previous.revision===base.previous.revision&&previous.storyRevision===base.previous.storyRevision:!previous;
            return !!p&&previousUnchanged&&p.assetId===assetId&&p.storyRevision===base.data.storyRevision&&p.revision===base.panel.revision+1&&p.status==='checking'&&draft.storyRevision===base.data.storyRevision&&same(draft.storyboard,base.data.storyboard)&&same(draft.characters,base.data.characters)&&isStoryApproved(draft)&&!hasNarrativeBlocker(draft);
        };
        const latest=await current(session,comicId),reviewUnknown=await durable().load(`${prefix}/review-unknown`) as {assetId:string;marker:string}|null;
        if(!reviewValid(latest.data)||(reviewUnknown&&(latest.data.operations?.[op]!=='unknown_outcome'||latest.data.durableOperationMarkers?.[op]!==reviewUnknown.marker)))throw new ApplicationError('conflict','Panel changed while reviewing the image.');
        const referenceIds=[...base.anchors.map(c=>({role:'approved character',id:c.id,assetId:c.referenceAssetId!})),...(base.previous?.assetId?[{role:'previous panel',id:base.previous.id,assetId:base.previous.assetId}]:[]),{role:'generated panel',id:panelId,assetId}];
        const reviewInput={bible:base.data.storyboard!.bible,styleRules:styleRules(base.data.styleId),beats:base.visualSpec,references:referenceIds};
        let findings:Awaited<ReturnType<ReturnType<typeof ai>['visualJudge']>>['findings']=[],outcome:PanelReview['outcome']='failed',revocation:unknown;
        try {
            const result=await durable().paid({id:`${prefix}/visual-review`,input:asJson(reviewInput),expectedRevision:latest.revision},async fetch=>{
                const references:Reference[]=await Promise.all(referenceIds.map(async ref=>({role:ref.role,id:ref.id,bytes:await asset(ref.assetId),mimeType:'image/png' as const})));
                return deps.provider({fetch}).visualJudge({...reviewInput,references});
            });findings=result.findings;outcome=result.outcome;
        } catch(error){
            if(error instanceof AIError&&(error.code==='unknown_outcome'||error.code==='invalid_response')){
                await checkpoint(`${prefix}/review-unknown`,async tx=>{const now=await tx.getOwned<Draft>(comicId,session),marker=deps.id();if(!now||!reviewValid(now.data)||now.data.operations?.[op])throw new ApplicationError('conflict','Draft changed while recording the review outcome.');if(!(await tx.update(comicId,session,now.revision,{...now.data,operations:{...now.data.operations,[op]:'unknown_outcome'},durableOperationMarkers:{...now.data.durableOperationMarkers,[op]:marker}})))throw new ApplicationError('conflict','Draft changed while recording the review outcome.');return {assetId,marker};});throw error;
            }
            if(connectionRevoked(error))revocation=error;
            else if(!(error instanceof AIError)&&!(error instanceof BudgetError))throw error;
        }
        await checkpoint(`${prefix}/reviewed`,async tx=>{
            const now=await tx.getOwned<Draft>(comicId,session);if(!now||!reviewValid(now.data))throw new ApplicationError('conflict','Panel changed while saving the review.');
            const p=now.data.pages.flatMap(page=>page.panels).find(panel=>panel.id===panelId)!;
            const evaluation=findings.some(f=>f.severity==='blocker')?'blocker':findings.some(f=>f.severity==='warning')?'warning':'uncertain';
            const pages=now.data.pages.map(page=>({...page,panels:page.panels.map(panel=>panel.id===panelId?{...panel,evaluation,status:'needs_review' as const,acceptance:null}:panel)}));
            const operations={...now.data.operations},durableOperationMarkers={...now.data.durableOperationMarkers};
            if(reviewUnknown){if(operations[op]!=='unknown_outcome'||durableOperationMarkers[op]!==reviewUnknown.marker)throw new ApplicationError('conflict','Panel review belongs to another operation.');delete operations[op];delete durableOperationMarkers[op];}
            if(!(await tx.update(comicId,session,now.revision,{...now.data,pages,operations,durableOperationMarkers,panelFindings:{...now.data.panelFindings,[panelId]:findings},panelReviews:{...now.data.panelReviews,[panelId]:{assetId,storyRevision:base.data.storyRevision,panelRevision:p.revision,outcome}}})))throw new ApplicationError('conflict','Draft changed while saving the review.');
            return {assetId,revision:now.revision+1};
        });
        if(revocation)throw revocation;
    }
    async function durableGeneratePage(session:Actor,id:string,itemId:string,payload:unknown,expectedRevision?:number) {
        const body=parse(payload,z.object({pageId:short.optional(),intent:z.enum(['generate','resume','regenerate']).optional()}).strict());
        if(body.pageId!==undefined&&body.pageId!==itemId)throw new ApplicationError('invalid_input','Please check the supplied fields.');
        const prefix=`page/${itemId}`;
        const base=await prepared(`${prefix}/prepared`,session,id,expectedRevision,record=>{
            const data=record.data;requireStoryApproval(data);requireClearNarrative(data);
            const index=data.pages.findIndex(page=>page.id===itemId);if(index<0)throw new ApplicationError('not_found','Page not found.');
            if(index>0&&data.pages[index-1].panels.some(p=>p.storyRevision!==data.storyRevision||!isPanelReady(p)))throw new ApplicationError('conflict','Review and accept the preceding page first.');
            const page=data.pages[index];if(page.panels.some(p=>p.status==='checking'))throw new ApplicationError('conflict','Wait for the panel review to finish.');
            if(body.intent&&!pageIntentMatches(data,itemId,body.intent))throw new ApplicationError('conflict','Page progress changed. Refresh and choose the appropriate action.');
            let operation=data.pageOperations?.[itemId];if(operation&&operation.storyRevision!==data.storyRevision)operation=undefined;
            const needsStart=!operation;
            if(!operation){const full=page.panels.every(p=>!!p.assetId&&p.storyRevision===data.storyRevision&&['current','needs_review'].includes(p.status));const first=page.panels.findIndex(p=>!p.assetId||p.storyRevision!==data.storyRevision||!['current','needs_review'].includes(p.status));const targets=full?page.panels:page.panels.slice(first);operation={storyRevision:data.storyRevision,baseline:Object.fromEntries(targets.map(p=>[p.id,p.revision]))};}
            return {...record,operation,needsStart};
        });
        if(await durable().load(`${prefix}/completed`)!==null)return {comic:await viewCurrent(session,id)};
        await checkpoint(`${prefix}/started`,async tx=>{
            const now=await tx.getOwned<Draft>(id,session);if(!now||now.revision!==base.revision)throw new ApplicationError('conflict','Draft changed; refresh and try again.');
            if(base.needsStart&&!(await tx.update(id,session,now.revision,{...now.data,pageOperations:{...now.data.pageOperations,[itemId]:base.operation}})))throw new ApplicationError('conflict','Draft changed; refresh and try again.');
            return {revision:now.revision+(base.needsStart?1:0)};
        });
        for(const [panelId,baseline] of Object.entries(base.operation.baseline)){
            const now=await current(session,id);if(now.data.storyRevision!==base.operation.storyRevision)throw new ApplicationError('conflict','Story changed while drawing the page.');
            const panel=now.data.pages.flatMap(page=>page.panels).find(p=>p.id===panelId);if(!panel)throw new ApplicationError('conflict','Panel no longer exists.');
            if(panel.revision!==baseline){
                if(panel.evaluation==='blocker'&&!isPanelReady(panel))return {comic:view(now.data,await store.getPublished<Edition>(id),now.revision),notice:'Page generation paused. Repair or explicitly accept the flagged panel before continuing.'};
                const association=await durable().load(`panel/${panelId}/image-associated`) as {assetId:string}|null;
                if(!association&&!base.needsStart){
                    const prior=base.data.pages.flatMap(page=>page.panels).find(p=>p.id===panelId);
                    if(prior&&prior.assetId&&panel.assetId===prior.assetId&&panel.revision===prior.revision&&panel.storyRevision===base.operation.storyRevision&&['current','needs_review'].includes(panel.status))continue;
                }
                if(!association||association.assetId!==panel.assetId||panel.revision!==baseline+1||panel.storyRevision!==base.operation.storyRevision)throw new ApplicationError('conflict','Panel changed while drawing the page.');
                if(panel.status==='checking'){await durableRenderPanel(session,id,panelId);}
                else if(['current','needs_review'].includes(panel.status)){if(await durable().load(`panel/${panelId}/reviewed`)===null)throw new ApplicationError('conflict','Panel changed while drawing the page.');continue;}
                else throw new ApplicationError('conflict','Panel changed while drawing the page.');
            } else await durableRenderPanel(session,id,panelId);
            const reviewed=await current(session,id),finished=reviewed.data.pages.flatMap(page=>page.panels).find(p=>p.id===panelId);
            if(finished?.evaluation==='blocker'&&!isPanelReady(finished))return {comic:view(reviewed.data,await store.getPublished<Edition>(id),reviewed.revision),notice:'Page generation paused. Repair or explicitly accept the flagged panel before continuing.'};
        }
        await checkpoint(`${prefix}/completed`,async tx=>{
            const latest=await tx.getOwned<Draft>(id,session);if(!latest||latest.data.storyRevision!==base.operation.storyRevision||!same(latest.data.pageOperations?.[itemId],base.operation))throw new ApplicationError('conflict','Draft changed; refresh to see page progress.');
            const {[itemId]:finished,...pageOperations}=latest.data.pageOperations??{};void finished;
            if(!(await tx.update(id,session,latest.revision,{...latest.data,pageOperations})))throw new ApplicationError('conflict','Draft changed; refresh to see page progress.');
            return {revision:latest.revision+1};
        });return {comic:await viewCurrent(session,id)};
    }
    async function renderPanel(store: ComicRepository, session: string, comicId: string, panelId: string, editInstruction?: string, expectedVersion?: z.infer<typeof panelVersionSchema>): Promise<void> {
        const record = (await store.getOwned<Draft>(comicId, session));
        if (!record || !record.data.storyboard)
            throw new ApplicationError('conflict', 'Plan the story first.');
        const draft = record.data;
        requireStoryApproval(draft);
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
                    latest.data.styleId !== draft.styleId || !sameJson(latest.data.storyboard,storyboard) ||
                    !sameJson(latest.data.characters,draft.characters) ||
                    !sameJson(current,panel) || !sameJson(currentPrevious,previous) ||
                    !isStoryApproved(latest.data) || hasNarrativeBlocker(latest.data))
                    throw new ApplicationError('conflict', 'Panel inputs changed while rendering; the result was not applied.');
                const updated = commitPanelRender(latest.data, session, panelId, { storyRevision: draft.storyRevision, panelRevision: panel.revision }, assetId, 'uncertain') as Draft;
                const { [op]: ignored, ...operations } = updated.operations ?? {};
                void ignored;
                const checkingPages = updated.pages.map(page => ({ ...page, panels: page.panels.map(p => p.id === panelId ? { ...p, status: 'checking' as const } : p) }));
                const { [panelId]: oldReview, ...panelReviews } = updated.panelReviews ?? {};
                void oldReview;
                const pendingArtworkDecision = updated.pendingArtworkDecision?.panelId === panelId ? undefined : updated.pendingArtworkDecision;
                if ((await store.update(comicId, session, latest.revision, { ...updated, pages: checkingPages, panelFindings: { ...updated.panelFindings, [panelId]: [] }, panelReviews, operations, pendingArtworkDecision }))) {
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
        if (data.pages.length && ((body.plot !== undefined && body.plot !== data.plot) || (body.style !== undefined && body.style !== data.styleId) || (body.answers !== undefined && !sameJson(body.answers,data.answers))))
            throw new ApplicationError('conflict', 'Change the story through the revision flow so later pages can be updated.');
        if (data.pages.length && body.panelsPerPage !== undefined && body.panelsPerPage !== (data.panelsPerPage ?? 3))
            throw new ApplicationError('conflict', 'Choose the number of panels before planning the story.');
        const updated: Draft = { ...data, title: body.title ?? data.title, plot: body.plot ?? data.plot, styleId: body.style ?? data.styleId, answers: body.answers ?? data.answers, panelsPerPage: body.panelsPerPage ?? data.panelsPerPage, pageLayout: body.pageLayout ?? data.pageLayout };
        return ({ comic: (await save(store, session, revision, updated)) });
    }
    async function initialQuestions(session: Actor, id: string, payload: unknown = {}, expectedRevision?: number) {
        if(deps.durable)return durableInitialQuestions(session,id,payload,expectedRevision);
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
                    if (!latest || latest.data.initialQuestions !== 'running' || latest.data.plot !== data.plot || latest.data.styleId !== data.styleId || !sameJson(latest.data.questions,data.questions) || !sameJson(latest.data.answers,data.answers))
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
        if(deps.durable)return durableRefreshQuestions(session,id,payload,expectedRevision);
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
        if(deps.durable)return durableSuggestions(session,id,payload,expectedRevision);
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
                    if (!latest || latest.data.initialSuggestions !== 'running' || latest.data.pages.length || latest.data.plot !== data.plot || latest.data.styleId !== data.styleId || !sameJson(latest.data.questions,data.questions) || !sameJson(latest.data.answers,data.answers))
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
    async function approveStory(session: Actor, id: string, payload: unknown = {}, expectedRevision?: number) {
        const { data, revision } = await owned(session, id, expectedRevision);
        const body = parse(payload, z.object({revision:z.number().int().nonnegative(),storyRevision:z.number().int().positive(), fingerprint:z.string().regex(/^[a-f0-9]{64}$/)}).strict());
        const fingerprint = storyFingerprint(data);
        if (!fingerprint || body.revision !== revision || body.storyRevision !== data.storyRevision || body.fingerprint !== fingerprint)
            throw new ApplicationError('conflict', 'This story changed since you reviewed it. Refresh and review the current story.');
        if (data.characters.some(character => !character.approved || !character.referenceAssetId))
            throw new ApplicationError('conflict', 'Approve all character references before approving the story.');
        return {comic:await save(store, session, revision, {...data, storyApproval:{storyRevision:data.storyRevision,fingerprint}})};
    }
    async function planStory(session: Actor, id: string, payload: unknown = {}, expectedRevision?: number) {
        if(deps.durable)return durablePlanStory(session,id,payload,expectedRevision);
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
            return ({ comic: (await save(store, session, revision, { ...data, ...planned, storyboard, storyReview, storyReviewAcceptance: undefined, storyApproval: null })) });
        });
    }
    async function generateReference(session: Actor, id: string, itemId: string, payload: unknown = {}, expectedRevision?: number) {
        if(deps.durable)return durableReference(session,id,itemId,payload,expectedRevision);
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
                if (!latest || latest.data.operations?.[op] !== 'running' || latest.data.pages.length || latest.data.styleId !== data.styleId || !sameJson(current,character))
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
        if(deps.durable)return durablePreviewRevision(session,id,payload,expectedRevision);
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
            const proposal = { id: deps.id(), baseRevision: revision + 1, baseStoryRevision:data.storyRevision, result };
            const pendingArtworkDecision = data.pendingArtworkDecision?.panelId === body.panelId && data.pendingArtworkDecision.instruction === body.instruction ? undefined : data.pendingArtworkDecision;
            if (!(await store.update(id, session, revision, { ...data, pendingRevision: proposal, pendingArtworkDecision })))
                throw new ApplicationError('conflict', 'Draft changed while planning the revision; refresh and try again.');
            return ({ proposal: revisionPreview({ ...data, pendingRevision: proposal, pendingArtworkDecision }, revision + 1)! });
        });
    }
    async function applyRevision(session: Actor, id: string, payload: unknown = {}, expectedRevision?: number) {
        if(deps.durable)return durableApplyRevision(session,id,payload,expectedRevision);
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
            const fingerprint = storyFingerprint(next);
            if (!fingerprint) throw new ApplicationError('conflict', 'The revised story is missing.');
            next.storyApproval = {storyRevision:next.storyRevision,fingerprint};
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
        if(deps.durable)return durableGeneratePage(session,id,itemId,payload,expectedRevision);
        const { data, revision } = await owned(session, id, expectedRevision);
        parse(payload, z.object({}).strict());
        requireStoryApproval(data);
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
        if(deps.durable)return durableEditPanel(session,id,itemId,payload,expectedRevision);
        const { data, revision } = await owned(session, id, expectedRevision);
        const body = parse(payload, z.union([
            panelVersionSchema.extend({ instruction: z.string().trim().min(1).max(2000) }).strict(),
            z.object({ proposalId: z.string().uuid(), decision: z.literal('artwork_only') }).strict(),
        ]));
        requireStoryApproval(data);
        requireClearNarrative(data);
        const panel = data.pages.flatMap(page => page.panels).find(panel => panel.id === itemId);
        if (!panel || !panel.assetId || panel.storyRevision !== data.storyRevision || (panel.status === 'outdated' || panel.status === 'checking'))
            throw new ApplicationError('conflict', 'Generate the current panel before editing its artwork.');
        let instruction: string, reviewed: z.infer<typeof panelVersionSchema>;
        if ('proposalId' in body) {
            const proposal = data.pendingArtworkDecision;
            if (!proposal || proposal.id !== body.proposalId || proposal.panelId !== panel.id || proposal.intent === 'story' || proposal.expiresAt <= Date.now())
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
                if (decision.intent === 'uncertain' || decision.intent === 'story') {
                    const proposal = { id: deps.id(), panelId: panel.id, instruction, ...reviewed, reason:decision.reason, intent:decision.intent, expiresAt: Date.now() + 15 * 60 * 1000 };
                    if (!(await store.update(id, session, latest.revision, { ...latest.data, pendingArtworkDecision: proposal })))
                        throw new ApplicationError('conflict', 'Draft changed while checking the edit. Refresh and try again.');
                    return { ...decision, proposalId: proposal.id };
                }
                return decision;
            });
            if (intent.intent !== 'artwork')
                return ({ editDecision: { ...intent, panelId: panel.id, instruction, reviewedVersion: reviewed, choices:intent.intent === 'uncertain' ? ['preview_story','artwork_only'] : ['preview_story'] } });
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
        if (body.expectedEditionId !== undefined && ((await store.getPublished<Edition>(id))?.editionId ?? null) !== body.expectedEditionId)
            throw new ApplicationError('conflict', 'The published edition changed. Refresh and review it again.');
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
        const body = parse(payload, z.object({expectedEditionId:short.nullable().optional()}).strict());
        if (body.expectedEditionId !== undefined && ((await store.getPublished<Edition>(id))?.editionId ?? null) !== body.expectedEditionId)
            throw new ApplicationError('conflict', 'The published edition changed. Refresh and review it again.');
        if (!(await store.withdraw(id, session, revision)))
            throw new ApplicationError('conflict', 'Draft changed while withdrawing; refresh and try again.');
        return ({ comic: view(data, null, revision + 1) });
    }
    return { listStyles, create, list, get, getAsset, listPublished, getPublished, getPublishedAsset, update, initialQuestions, refreshQuestions, suggestCharacters, acceptStoryReview, approveStory, planStory, generateReference, addCharacter, editCharacter: (actor: Actor, id: string, characterId: string, input: unknown, expectedRevision?: number) => changeCharacter(actor, id, characterId, input, 'PATCH', expectedRevision), removeCharacter: (actor: Actor, id: string, characterId: string, input: unknown = {}, expectedRevision?: number) => changeCharacter(actor, id, characterId, input, 'DELETE', expectedRevision), approveCharacter, previewRevision, applyRevision, downloadPage, generatePage, editPanel, acceptPanel, publish, withdraw };
}
