'use client';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { PublishDialog } from './PublishDialog';
import {RevisionPreview as RevisionDialog, type RevisionProposal} from './RevisionPreview';
import { ComicShell, Eyebrow, Message, button, field, secondaryButton } from './ComicShell';
import { browserOperationFor, errorMessage, forgetHostedOperation, hostedCreateKey, hostedSession, hostedWorkspaceFence, pendingHostedOperations, readHostedOperation, recoverHostedOperation, rememberHostedOperation, request, startHostedOperation, subscribeHostedWorkspace, waitForHostedOperation, type DiscoveredHostedOperation, type HostedOperation, type HostedOperationInput, type SavedHostedOperation } from './api';
import { styles, type DraftComic, type Panel, type RevisionPreview } from './types';

type DraftResponse = {comic?: DraftComic; questions?: DraftComic['questions']; jobId?: string; notice?: string};
type EditDecision = {intent:'story' | 'uncertain';reason:string;panelId:string;reviewedVersion:NonNullable<Panel['reviewVersion']>;proposalId?:string;instruction:string};
type PageJob = {id:string;state:'running'|'completed'|'paused'|'failed'|'unknown';message:string|null;completed?:number;total?:number};
function readableFinding(value:string,pages:DraftComic['pages']) {
  let text=value.replace(/character_ids/g,'character list');
  for(const [pageIndex,page] of pages.entries())for(const [panelIndex,panel] of page.panels.entries())text=text.split(panel.id).join(`page ${pageIndex+1}, panel ${panelIndex+1}`);
  return text;
}
const reviewMessages = {
  pass: 'Automated review completed without findings. Inspect the panel before accepting.',
  findings: 'Automated review completed and found possible issues. Inspect the panel and findings.',
  inconclusive: 'Automated review was inconclusive. Inspect the panel before accepting.',
  failed: 'Automated review could not complete. Inspect the panel before accepting.',
} as const;
const operationLabels:Record<string,string>={initialQuestions:'Story questions',refreshQuestions:'Story questions',suggestCharacters:'Character suggestions',addCharacter:'Add character',generateReference:'Character reference',approveCharacter:'Reference approval',planStory:'Story plan',approveStory:'Story approval',acceptStoryReview:'Story review',generatePage:'Page drawing',acceptPanel:'Panel review',editPanel:'Artwork edit',previewRevision:'Story revision preview',applyRevision:'Story revision',exportPage:'Page download',publish:'Publication',withdraw:'Withdrawal',update:'Draft update',editCharacter:'Character edit',removeCharacter:'Character removal'};
function operationDetail(value:unknown):string {return typeof value==='string' ? value : value && typeof value==='object' && 'message' in value && typeof value.message==='string' ? value.message : '';}
function sameAnswers(a:Record<string,string>,b:Record<string,string>) {return [...new Set([...Object.keys(a),...Object.keys(b)])].every(key=>(a[key] ?? '')===(b[key] ?? ''));}
function storyDraftKey(id:string,panelId:string,workspaceId?:string|null) {return `comex-story-edit:${workspaceId ? `${workspaceId}:` : ''}${id}:${panelId}`;}
function matchesDecision(decision:EditDecision,choice:DraftComic['pendingArtworkDecision']) {
  return !!choice?.current && choice.expiresAt>Date.now() && choice.id===decision.proposalId && choice.panelId===decision.panelId && choice.reviewedVersion.assetId===decision.reviewedVersion.assetId && choice.reviewedVersion.storyRevision===decision.reviewedVersion.storyRevision && choice.reviewedVersion.panelRevision===decision.reviewedVersion.panelRevision;
}
function revisionDialogFor(proposal:RevisionPreview,comic:DraftComic):RevisionProposal {
  const previous=comic.storyboard?.pages.flatMap(page=>page.panels.map(panel=>({page:page.index,panel}))) ?? [];
  return {id:proposal.id,affectedPage:proposal.affectedPage,affectedPanel:proposal.affectedPanel,explanation:proposal.explanation,panels:proposal.revisedSuffix.map(panel=>{
    const old=previous.find(item=>item.panel.id===panel.id);
    return {id:panel.id,page:old?.page ?? proposal.affectedPage,panel:old?.panel.index ?? panel.index,previousAction:old?.panel.action ?? '',action:panel.action,dialogue:panel.dialogue.map(line=>({speaker:comic.characters?.find(character=>character.id===line.speaker_id)?.name ?? line.speaker_id,text:line.text}))};
  })};
}
function StoryBeats({storyboard, characters}: {storyboard:NonNullable<DraftComic['storyboard']>; characters:NonNullable<DraftComic['characters']>}) {
  return <div className="mt-3 space-y-4"><div><p><strong>Premise:</strong> {storyboard.bible.premise}</p><p><strong>Setting:</strong> {storyboard.bible.setting}</p>{storyboard.bible.rules.length > 0 && <p><strong>Story rules:</strong> {storyboard.bible.rules.join('; ')}</p>}</div>{storyboard.pages.map(page => <div key={page.index}><h4 className="font-bold">Page {page.index}</h4><ol className="mt-2 list-decimal space-y-2 pl-5">{page.panels.map(panel => <li key={panel.id}><p>{panel.action}</p>{panel.dialogue.map((line,index) => <p key={index} className="mt-1 text-sm"><strong>{characters.find(character => character.id === line.speaker_id)?.name ?? line.speaker_id}:</strong> {line.text}</p>)}</li>)}</ol></div>)}</div>;
}
export default function ComicEditor({ id, hosted=false }: { id: string; hosted?:boolean }) {
  const base = `/api/comics/${encodeURIComponent(id)}`;
  const [comic, updateComic] = useState<DraftComic | null>(null);
  const setComic=useCallback((value:DraftComic|null|((current:DraftComic|null)=>DraftComic|null))=>{updateComic(current=>{const next=typeof value==='function'?value(current):value;return current && next && current.id===next.id && next.revision<current.revision ? current : next;});},[]);
  const comicRef=useRef<DraftComic | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [questionsBusy, setQuestionsBusy] = useState(false);
  const [drawingCharacter,setDrawingCharacter]=useState<string|null>(null);
  const [suggestionStartFailed, setSuggestionStartFailed] = useState(false);
  const initialQuestionRequest = useRef<string | null>(null);
  const initialSuggestionRequest = useRef<string | null>(null);
  const addingCharacter = useRef(false);
  const characterForm=useRef<HTMLFormElement>(null);
  const [selectedPage, setSelectedPage] = useState(0);
  const [selectedPanel, setSelectedPanel] = useState(0);
  const [answers, setAnswers] = useState<Record<string,string>>({});
  const [answerConflicts,setAnswerConflicts]=useState<Record<string,string>>({});
  const answersRef=useRef<Record<string,string>>({});
  const savedAnswersRef=useRef<Record<string,string>|null>(null);
  const answerConflictsRef=useRef<Record<string,string>>({});
  const submittedAnswersRef=useRef<Record<string,string>|null>(null);
  const [character, setCharacter] = useState({name:'',role:'',appearance:'',outfit:''});
  const [editingCharacter, setEditingCharacter] = useState<string | null>(null);
  const [artEdit, setArtEdit] = useState('');
  const [editDecision, setEditDecision] = useState<EditDecision | null>(null);
  const [storyEdit, setStoryEdit] = useState('');
  const [dismissedRevision, setDismissedRevision] = useState<string | null>(null);
  const [legacyRevision,setLegacyRevision]=useState<RevisionProposal|null>(null);
  const [showPublish, setShowPublish] = useState(false);
  const [showWithdraw,setShowWithdraw]=useState(false);
  const [creator, setCreator] = useState('');
  const [publishTitle, setPublishTitle] = useState('');
  const [hostedOperations,setHostedOperations]=useState<SavedHostedOperation[]>([]);
  const [discoveryState,setDiscoveryState]=useState<'pending'|'ready'|'failed'>(hosted?'pending':'ready');
  const [discoveryAttempt,setDiscoveryAttempt]=useState(0);
  const [pageJob,setPageJob]=useState<PageJob|null>(null);
  const [pagePoll,setPagePoll]=useState(0);
  const workspaceRef=useRef<string|null>(null);
  const operationControllers=useRef(new Set<AbortController>());
  const reconcileAnswers=useCallback((incoming:Record<string,string>)=>{
    const saved=savedAnswersRef.current;
    if(!saved){const first={...incoming};savedAnswersRef.current=first;answersRef.current=first;setAnswers(first);return;}
    const next={...incoming},conflicts={...answerConflictsRef.current};
    for(const key of new Set([...Object.keys(saved),...Object.keys(incoming),...Object.keys(answersRef.current)])) {
      const remote=incoming[key] ?? '',local=answersRef.current[key] ?? '';
      const base=submittedAnswersRef.current?.[key]===remote ? remote : saved[key] ?? '';
      if(local===remote || local===base)delete conflicts[key];
      else {next[key]=local;if(remote!==base || key in conflicts)conflicts[key]=remote;}
    }
    savedAnswersRef.current={...incoming};answersRef.current=next;answerConflictsRef.current=conflicts;setAnswers(next);setAnswerConflicts(conflicts);
  },[]);
  const acceptComic=useCallback((next:DraftComic)=>{
    const current=comicRef.current;if(current?.id===next.id && current.revision>next.revision)return current;
    comicRef.current=next;reconcileAnswers(next.answers ?? {});setComic(next);return next;
  },[reconcileAnswers]);
  const syncHosted=useCallback(()=>setHostedOperations(pendingHostedOperations(id).filter(entry=>!(entry.requestKey.startsWith('auto:') && (entry.status==='succeeded' || entry.status==='needs_review')))),[id]);
  useEffect(()=>()=>{for(const controller of operationControllers.current)controller.abort();operationControllers.current.clear();},[]);
  useEffect(()=>{if(!hosted)return;return subscribeHostedWorkspace(()=>{const old=workspaceRef.current;if(old)for(let i=sessionStorage.length-1;i>=0;i--){const key=sessionStorage.key(i);if(key?.startsWith(`comex-story-edit:${old}:`))sessionStorage.removeItem(key);}workspaceRef.current=null;for(const controller of operationControllers.current)controller.abort();operationControllers.current.clear();comicRef.current=null;savedAnswersRef.current=null;answersRef.current={};answerConflictsRef.current={};submittedAnswersRef.current=null;setComic(null);setAnswers({});setAnswerConflicts({});setCharacter({name:'',role:'',appearance:'',outfit:''});setArtEdit('');setStoryEdit('');setEditDecision(null);setCreator('');setPublishTitle('');setNotice('');setHostedOperations([]);setDiscoveryState('failed');setError('Your workspace changed. Refresh before continuing.');});},[hosted]);
  const refresh = useCallback(async () => {
    const fence=hosted ? hostedWorkspaceFence() : ()=>{};
    const data = await request<{comic:DraftComic}>(base);
    fence();
    const current=acceptComic(data.comic);
    return current;
  }, [base,hosted,acceptComic]);
  const continueHosted=useCallback(async function continueEntry(entry:SavedHostedOperation,signal:AbortSignal):Promise<{operation:HostedOperation;comic:DraftComic}> {
    const started=entry.id ? entry : entry.redacted ? await recoverHostedOperation(entry) : await startHostedOperation(entry,entry.requestKey);
    syncHosted();
    const operation=await waitForHostedOperation(started,()=>syncHosted(),signal);
    syncHosted();
    if(operation.status==='unknown_outcome')throw new Error('The operation outcome is unknown. Check its status before trying this action again.');
    if(operation.status!=='succeeded' && operation.status!=='needs_review') {
      const detail=typeof operation.error==='string' ? operation.error : operation.error && typeof operation.error==='object' && 'message' in operation.error ? String(operation.error.message) : '';
      await refresh().catch(()=>{});
      throw new Error(detail || `The operation ${operation.status}. Review the draft before trying again.`);
    }
    const current=await refresh();
    const result=operation.result as {comic?:DraftComic;characterId?:string;proposal?:RevisionPreview;editDecision?:Omit<EditDecision,'instruction'>;notice?:string}|null|undefined;
    if(result?.notice)setNotice(result.notice);
    else if(operation.status==='needs_review')setNotice('Review the current findings and pending decisions before continuing.');
    if(entry.action==='previewRevision') {setEditDecision(null);setDismissedRevision(null);}
    if(entry.action==='editPanel' && result?.editDecision) {
      const decision=result.editDecision as Omit<EditDecision,'instruction'> & {instruction?:string};
      const candidate={...decision,instruction:decision.instruction ?? current.pendingArtworkDecision?.instruction ?? String(entry.input.instruction ?? '')};
      setEditDecision(matchesDecision(candidate,current.pendingArtworkDecision) ? candidate : null);
    }
    if(entry.action==='refreshQuestions')for(const previous of pendingHostedOperations(id).filter(item=>item.action==='initialQuestions' && item.status==='failed'))forgetHostedOperation(previous);
    if(entry.action==='addCharacter') {
      const characterId=result?.characterId ?? result?.comic?.characters?.at(-1)?.id;
      const character=current.characters?.find(item=>item.id===characterId);
      if(!character)throw new Error('The character was added, but its ID is unavailable. Refresh before drawing its reference.');
      setCharacter(value=>Object.entries(value).every(([key,field])=>entry.input[key]===field) ? {name:'',role:'',appearance:'',outfit:''} : value);
      setNotice(`${character.name} added. Draw a reference when you are ready; this uses an AI call.`);
    }
    if(!entry.requestKey.startsWith('auto:') && entry.action!=='exportPage')forgetHostedOperation(entry);
    syncHosted();
    return {operation,comic:current};
  },[id,refresh,syncHosted]);
  const runHosted=useCallback(async(input:HostedOperationInput,key?:string)=>{
    if(discoveryState!=='ready')throw new Error('Check existing draft activity before starting another action.');
    const workspaceId=workspaceRef.current;if(!workspaceId || !comicRef.current)throw new Error('Your workspace changed. Refresh before continuing.');
    if(input.action==='refreshQuestions' && pendingHostedOperations(id).some(item=>item.action==='initialQuestions' && item.status==='unknown_outcome'))throw new Error('The previous questions request has an unknown outcome. Check it before trying again.');
    const related=pendingHostedOperations(id).filter(item=>item.action===input.action && ['pageId','panelId','characterId'].every(field=>item.input[field]===input.input[field] || (item.requestKey.startsWith('discovered:') && item.input[field]===undefined)));
    if(related.some(item=>item.status==='unknown_outcome'))throw new Error('The previous operation has an unknown outcome. Check its status before trying this action again.');
    const pending=related.find(item=>!item.status || item.status==='queued' || item.status==='running');
    if(pending && !pending.redacted && JSON.stringify(pending.input)!==JSON.stringify(input.input))throw new Error('A request for this item is still in progress. Review its status first.');
    if(!key)for(const failed of related.filter(item=>['failed','obsolete','revoked'].includes(item.status ?? '')))forgetHostedOperation(failed);
    const controller=new AbortController();operationControllers.current.add(controller);
    try {
      const entry=pending?.redacted && !pending.id ? await recoverHostedOperation(pending,key ? undefined : input) : pending ?? await startHostedOperation(input,key,workspaceId);
      return await continueHosted(entry,controller.signal);
    } finally {operationControllers.current.delete(controller);syncHosted();}
  },[id,continueHosted,syncHosted,discoveryState]);
  useEffect(()=>{
    if(!hosted)return;
    const controller=new AbortController();operationControllers.current.add(controller);setDiscoveryState('pending');
    void (async()=>{
      try {
        const session=await hostedSession();if(!session.workspaceId)throw new Error('Sign in to open this draft.');workspaceRef.current=session.workspaceId;
        const createKey=sessionStorage.getItem(hostedCreateKey);
        const created=createKey ? pendingHostedOperations(id).find(item=>item.requestKey===createKey && item.action==='create') : undefined;
        if(created){forgetHostedOperation(created);sessionStorage.removeItem(hostedCreateKey);}
        syncHosted();
        const fence=hostedWorkspaceFence();
        const response=await request<{operations:DiscoveredHostedOperation[]}>(`/api/operations?comicId=${encodeURIComponent(id)}`,{signal:controller.signal});
        fence();
        for(const operation of response.operations)if(!operation.comicId || operation.comicId===id)rememberHostedOperation({...operation,comicId:id});
        syncHosted();setDiscoveryState('ready');
        for(const entry of pendingHostedOperations(id)) {
          if(entry.action==='create' || (entry.requestKey.startsWith('auto:') && (entry.status==='succeeded' || entry.status==='needs_review')))continue;
          if(['failed','obsolete','revoked'].includes(entry.status ?? '')) {
            if(entry.id)void readHostedOperation(entry,controller.signal).then(operation=>{syncHosted();if(operation.status==='succeeded' || operation.status==='needs_review')return continueHosted(entry,controller.signal);}).catch(e=>{if(!controller.signal.aborted)setError(errorMessage(e));});
            continue;
          }
          void continueHosted(entry,controller.signal).catch(e=>{if(!controller.signal.aborted)setError(errorMessage(e));});
        }
      } catch(e) {if(!controller.signal.aborted){setDiscoveryState('failed');setError(errorMessage(e));}}
    })();
    return ()=>{controller.abort();operationControllers.current.delete(controller);};
  },[hosted,id,continueHosted,syncHosted,discoveryAttempt]);
  useEffect(() => { let alive = true; void (async()=>{if(hosted){const session=await hostedSession();if(!session.workspaceId)throw new Error('Sign in to open this draft.');}const fence=hosted ? hostedWorkspaceFence() : ()=>{};const data=await request<{comic:DraftComic}>(base);fence();if (alive) {const current=acceptComic(data.comic);setPublishTitle(current.publication?.title ?? current.title);setCreator(current.publication?.creator ?? '');if(!hosted && current.activePageJob){const index=current.pages.findIndex(page=>page.id===current.activePageJob!.pageId);if(index>=0)setSelectedPage(index);if(current.activePageJob.state==='running')setBusy('Drawing page');}}} )().catch(e => { if (alive) setError(errorMessage(e)); }); return () => {alive = false;}; }, [base,hosted,acceptComic]);
  useEffect(() => {
    if (comic?.id !== id || comic.initialQuestions !== 'pending' || initialQuestionRequest.current === id || (hosted && discoveryState!=='ready')) return;
    initialQuestionRequest.current = id;
    setQuestionsBusy(true);
    if(hosted) {
      void runHosted({action:'initialQuestions',comicId:id,expectedRevision:comic.revision,input:{}},`auto:initialQuestions:${id}`)
        .catch(e=>setError(errorMessage(e))).finally(()=>setQuestionsBusy(false));
      return;
    }
    request<{comic:DraftComic}>(`${base}/questions/initial`, {method:'POST',body:'{}'})
      .then(async data => {try {await refresh();} catch {setComic(data.comic);}})
      .catch(async e => { try { const current=await refresh(); if (current.initialQuestions !== 'running' && current.initialQuestions !== 'complete') setError(errorMessage(e)); } catch {setError(errorMessage(e));} })
      .finally(() => setQuestionsBusy(false));
  }, [base, id, comic?.id, comic?.initialQuestions, comic?.revision, refresh, hosted, runHosted, discoveryState]);
  useEffect(() => {
    if (comic?.id !== id || comic.initialQuestions !== 'complete' || comic.initialSuggestions !== 'pending' || initialSuggestionRequest.current === id || (hosted && discoveryState!=='ready')) return;
    initialSuggestionRequest.current=id;
    setSuggestionStartFailed(false);
    if(hosted) {
      void runHosted({action:'suggestCharacters',comicId:id,expectedRevision:comic.revision,input:{}},`auto:suggestCharacters:${id}`)
        .catch(e=>{setSuggestionStartFailed(true);setError(errorMessage(e));});
      return;
    }
    request<{comic:DraftComic}>(`${base}/characters/suggestions`,{method:'POST',body:'{}'})
      .then(async data => {try {await refresh();} catch {setComic(data.comic);}})
      .catch(async e => {try {const current=await refresh();if (current.initialSuggestions !== 'running' && current.initialSuggestions !== 'complete') {setSuggestionStartFailed(current.initialSuggestions === 'pending');setError(errorMessage(e));}} catch {setSuggestionStartFailed(true);setError(errorMessage(e));}});
  }, [base,id,comic?.id,comic?.initialQuestions,comic?.initialSuggestions,comic?.revision,refresh,hosted,runHosted,discoveryState]);
  useEffect(() => {
    if (comic?.initialQuestions !== 'running' && comic?.initialSuggestions !== 'running' && !comic?.characters?.some(c => c.referenceStatus === 'running')) return;
    const timer=window.setInterval(() => {void refresh().catch(() => {});}, 2500);
    return () => window.clearInterval(timer);
  }, [comic?.initialQuestions, comic?.initialSuggestions, comic?.characters, refresh]);
  useEffect(() => {
    if (!(comic?.storyReview?.outcome === 'pending' || comic?.pages.some(page=>page.panels.some(panel=>panel.status==='checking')))) return;
    const timer=window.setInterval(()=>{void refresh().catch(()=>{});},2500);
    return ()=>window.clearInterval(timer);
  },[comic?.storyReview?.outcome,comic?.pages,refresh]);
  async function action(label: string, path: string, body: unknown = {}, method = 'POST', expectedComic?:DraftComic) {
    setBusy(label); setError(''); setNotice('');
    try {
      if(hosted) {
        const snapshot=expectedComic ?? comic;if(!snapshot)throw new Error('Open the draft before making changes.');
        await runHosted(browserOperationFor(snapshot,path,body,method));
        return true;
      }
      const data = await request<DraftResponse>(`${base}${path}`, {method,body:JSON.stringify(body)});
      if (data.notice) setNotice(data.notice);
      if (data.comic) acceptComic(data.comic);
      else if (data.questions) setComic(current => current ? {...current, questions:data.questions} : current);
      else if (data.jobId) { setNotice('Generation started. Refresh to check its status.'); await refresh(); }
      else await refresh();
      return true;
    } catch (e) { setError(errorMessage(e)); try { await refresh(); } catch { /* Keep the original error visible. */ } return false; }
    finally { setBusy(''); }
  }
  async function reviseStory(panelId: string, instruction = storyEdit, reviewedVersion?:NonNullable<Panel['reviewVersion']>) {
    setBusy('Preparing story revision'); setError(''); setNotice('');
    try {
      if(hosted) {
        if(!comic)throw new Error('Open the draft before revising it.');
        await runHosted(browserOperationFor(comic,'/revisions/preview',{panelId,instruction,...(reviewedVersion ? {reviewedVersion} : {})},'POST'));
        return;
      }
      const {proposal} = await request<{proposal:RevisionPreview|RevisionProposal}>(`${base}/revisions/preview`, {method:'POST',body:JSON.stringify({panelId,instruction,...(reviewedVersion ? {reviewedVersion} : {})})});
      if('revisedSuffix' in proposal)setComic(current => current ? {...current,revision:proposal.baseRevision,pendingRevision:proposal,pendingArtworkDecision:null} : current);
      else setLegacyRevision(proposal);
      setEditDecision(null);
      setDismissedRevision(null);
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(''); }
  }
  async function addCharacter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (addingCharacter.current) return; addingCharacter.current=true; setBusy('Adding character'); setError(''); setNotice('');
    try {
      if(hosted) {
        if(!comic)throw new Error('Open the draft before adding a character.');
        await runHosted(browserOperationFor(comic,'/characters',character,'POST'));
        setCharacter({name:'',role:'',appearance:'',outfit:''});return;
      }
      const {comic:updated}=await request<{comic:DraftComic}>(`${base}/characters`,{method:'POST',body:JSON.stringify(character)});
      const newCharacter=updated.characters?.[updated.characters.length-1];
      if (!newCharacter) throw new Error('The character was added but could not be found. Refresh the draft.');
      acceptComic(updated); setCharacter({name:'',role:'',appearance:'',outfit:''});
      setNotice(`${newCharacter.name} added. Draw a reference when you are ready; this uses an AI call.`);
    } catch (e) {
      setError(errorMessage(e));
      try {await refresh();} catch { /* Preserve the original error. */ }
    } finally {addingCharacter.current=false;setBusy('');}
  }
  async function drawReference(characterId:string) {
    if(drawingCharacter)return;setDrawingCharacter(characterId);setError('');setNotice('');
    setComic(current=>current ? {...current,characters:current.characters?.map(c=>c.id===characterId?{...c,referenceStatus:'running'}:c)} : current);
    try {
      if(hosted) {if(!comic)throw new Error('Open the draft before drawing a reference.');await runHosted(browserOperationFor(comic,`/characters/${encodeURIComponent(characterId)}/reference`,{},'POST'));}
      else {const result=await request<{comic:DraftComic}>(`${base}/characters/${encodeURIComponent(characterId)}/reference`,{method:'POST',body:'{}'});acceptComic(result.comic);}
      setNotice('Reference ready. Open it at full size before approving.');
    } catch(e){setError(errorMessage(e));try{await refresh();}catch{ /* Keep the original error visible. */ }}finally{setDrawingCharacter(null);}
  }
  async function editArtwork(panelId:string, reviewedVersion:NonNullable<Panel['reviewVersion']>) {
    setBusy('Checking edit'); setError(''); setNotice(''); setEditDecision(null);
    try {
      if(hosted) {
        if(!comic)throw new Error('Open the draft before editing artwork.');
        await runHosted(browserOperationFor(comic,`/panels/${encodeURIComponent(panelId)}/edit`,{instruction:artEdit,...reviewedVersion},'POST'));
        return;
      }
      const result=await request<{comic?:DraftComic;editDecision?:Omit<EditDecision,'instruction'>}>(`${base}/panels/${encodeURIComponent(panelId)}/edit`,{method:'POST',body:JSON.stringify({instruction:artEdit,...reviewedVersion})});
      if (result.comic) acceptComic(result.comic);
      if (result.editDecision) setEditDecision({...result.editDecision,instruction:artEdit});
      if (result.comic) setNotice('Artwork updated. Review the new image and its check.');
    } catch (e) {setError(errorMessage(e)); try {await refresh();} catch { /* Keep the original error visible. */ }}
    finally {setBusy('');}
  }
  async function confirmArtworkChoice(choice:EditDecision) {
    if (!choice.proposalId || !window.confirm('Apply this as an artwork-only correction? The plot and scene state will stay unchanged, and later panels will not be revised.')) return;
    if (await action('Editing panel',`/panels/${encodeURIComponent(choice.panelId)}/edit`,{proposalId:choice.proposalId,decision:'artwork_only'})) setEditDecision(null);
  }
  async function checkHostedOperation(entry:SavedHostedOperation) {
    setBusy('Checking operation');setError('');
    const controller=new AbortController();operationControllers.current.add(controller);
    try {await continueHosted(entry,controller.signal);} catch(e) {if(!controller.signal.aborted)setError(errorMessage(e));}
    finally {operationControllers.current.delete(controller);syncHosted();setBusy('');}
  }
  async function retryEmptyHostedOperation(entry:SavedHostedOperation) {
    setBusy('Retrying operation');setError('');
    try {await runHosted({action:entry.action,comicId:id,expectedRevision:entry.expectedRevision,input:{}});} catch(e) {setError(errorMessage(e));}
    finally {setBusy('');}
  }
  async function saveCharacter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (editingCharacter && await action('Saving character',`/characters/${encodeURIComponent(editingCharacter)}`,character,'PATCH')) {
      setEditingCharacter(null); setCharacter({name:'',role:'',appearance:'',outfit:''});
    }
  }
  function cancelCharacterEdit() { setEditingCharacter(null); setCharacter({name:'',role:'',appearance:'',outfit:''}); }
  function changeAnswer(key:string,value:string) {
    const next={...answersRef.current,[key]:value};answersRef.current=next;setAnswers(next);
    if(key in answerConflictsRef.current && value===(savedAnswersRef.current?.[key] ?? '')) {const conflicts={...answerConflictsRef.current};delete conflicts[key];answerConflictsRef.current=conflicts;setAnswerConflicts(conflicts);}
  }
  function resolveAnswer(key:string,keepMine:boolean) {
    if(!keepMine)changeAnswer(key,savedAnswersRef.current?.[key] ?? '');
    const conflicts={...answerConflictsRef.current};delete conflicts[key];answerConflictsRef.current=conflicts;setAnswerConflicts(conflicts);
  }
  async function saveAnswers(snapshot?:DraftComic) {
    try {
      const current=snapshot ?? await refresh();
      if(Object.keys(answerConflictsRef.current).length){setError('Resolve the conflicting answers before continuing.');return false;}
      if(!Object.values(answersRef.current).some(value=>value.trim())){setError('Enter an answer or use a suggestion before saving.');return false;}
      const submitted={...answersRef.current};submittedAnswersRef.current=submitted;
      try {const saved=await action('Saving answers','',{answers:submitted},'PATCH',current);if(saved)setNotice('Answers saved.');return saved;}
      finally {submittedAnswersRef.current=null;}
    } catch(e) {setError(errorMessage(e));return false;}
  }
  async function withSavedAnswers(next: (updated?:DraftComic) => Promise<boolean>) {
    try {
      const current=await refresh();
      if(Object.keys(answerConflictsRef.current).length){setError('Resolve the conflicting answers before continuing.');return;}
      if(!sameAnswers(answersRef.current,current.answers ?? {})){
        if(!await saveAnswers(current))return;
        if(Object.keys(answerConflictsRef.current).length){setError('Resolve the conflicting answers before continuing.');return;}
        if(!sameAnswers(answersRef.current,comicRef.current?.answers ?? {})){setError('Your answers changed while saving. Review them and try again.');return;}
        await next(comicRef.current ?? undefined);return;
      }
      await next(current);
    } catch(e) {setError(errorMessage(e));}
  }
  async function publish(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (await action('Publishing','/publish',{title:publishTitle,creator})) { setShowPublish(false); setNotice(`Published! Your comic is now on the community shelf: ${window.location.origin}/read/${encodeURIComponent(id)}`); } }
  const pages = comic?.pages || [];
  const characters = comic?.characters || [];
  const suggestions = (comic?.characterSuggestions || []).filter(suggestion => !characters.some(c => c.name.toLocaleLowerCase('en-US') === suggestion.name.toLocaleLowerCase('en-US')));
  const page = pages[Math.min(selectedPage,Math.max(0,pages.length-1))];
  const panel = page?.panels?.[Math.min(selectedPanel,Math.max(0,page.panels.length-1))];
  const completedPages=pages.filter(item=>item.panels.length>0 && item.panels.every(p=>p.ready ?? (!!p.imageUrl && (p.evaluation==='pass'||p.accepted))));
  const pendingReviews=pages.flatMap(item=>item.panels).filter(p=>(p.ready ?? !!p.imageUrl) && !(p.reviewed ?? (p.evaluation==='pass'||p.accepted)));
  const canPublish=pages.length>0 && completedPages.length===pages.length && pendingReviews.length===0;
  const previousPageNeedsReview=selectedPage>0 && pages[selectedPage-1]?.panels.some(p=>!(p.reviewed ?? (p.evaluation==='pass'||p.accepted)));
  const textRequestRunning=questionsBusy || comic?.initialQuestions==='running' || comic?.initialSuggestions==='running' || (comic?.initialSuggestions==='pending' && comic?.initialQuestions==='complete' && !suggestionStartFailed);
  useEffect(()=>{if(panel?.id && (!hosted || workspaceRef.current))setStoryEdit(sessionStorage.getItem(storyDraftKey(id,panel.id,hosted ? workspaceRef.current : null)) || '');},[id,panel?.id,hosted]);
  const storedChoice = comic?.pendingArtworkDecision;
  const questionFailed=hosted && hostedOperations.some(entry=>entry.action==='initialQuestions' && entry.status==='failed');
  const questionUnknown=hosted && hostedOperations.some(entry=>entry.action==='initialQuestions' && entry.status==='unknown_outcome');
  const pageExport=hosted && page && comic ? hostedOperations.find(entry=>entry.action==='exportPage' && entry.input.pageId===page.id && entry.status==='succeeded' && entry.expectedRevision===comic.revision && entry.id) : undefined;
  const activeEditDecision = editDecision && (!hosted || matchesDecision(editDecision,storedChoice)) ? editDecision : storedChoice?.current && storedChoice.expiresAt>Date.now() ? {intent:storedChoice.intent, reason:storedChoice.reason ?? 'Choose whether this changes the story.', panelId:storedChoice.panelId, reviewedVersion:storedChoice.reviewedVersion, proposalId:storedChoice.id, instruction:storedChoice.instruction} : null;
  const revisionDialog=legacyRevision ?? (comic?.pendingRevision?.current && comic.pendingRevision.id!==dismissedRevision ? revisionDialogFor(comic.pendingRevision,comic) : null);
  useEffect(() => {
    if(hosted || !page?.id)return;
    let active=true;let timer:number|undefined;
    const key=`comex-page-job:${id}:${page.id}`,saved=window.sessionStorage.getItem(key);
    async function poll() {
      try {
        const suffix=saved ? `?id=${encodeURIComponent(saved)}` : '';
        let result=await request<{job:PageJob|null;comic:DraftComic}>(`${base}/pages/${encodeURIComponent(page!.id)}/job${suffix}`);
        if(!result.job && saved){const latest=await request<{job:PageJob|null;comic:DraftComic}>(`${base}/pages/${encodeURIComponent(page!.id)}/job`);if(latest.job?.state==='running' || latest.job?.state==='unknown')result=latest;}
        if(!active)return;
        setPageJob(result.job);acceptComic(result.comic);
        if(result.job?.state==='running'){setBusy(current=>current || 'Drawing page');timer=window.setTimeout(poll,2000);}
        else {setBusy(current=>current==='Drawing page'?'':current);if(result.job?.message)setNotice(result.job.message);if(saved && result.job && result.job.state!=='unknown')window.sessionStorage.removeItem(key);}
      } catch {if(active)timer=window.setTimeout(poll,3000);}
    }
    setPageJob(null);void poll();return ()=>{active=false;if(timer)window.clearTimeout(timer);};
  },[base,id,page?.id,pagePoll,hosted,acceptComic]);
  async function startPage() {
    if(!page || !comic || busy)return;
    const key=`comex-page-job:${id}:${page.id}`,requestId=window.sessionStorage.getItem(key) || crypto.randomUUID();
    window.sessionStorage.setItem(key,requestId);setBusy('Drawing page');setError('');setNotice('');
    try {const result=await request<{job:PageJob;comic:DraftComic}>(`${base}/pages/${encodeURIComponent(page.id)}/generate-async`,{method:'POST',body:JSON.stringify({requestId,expectedRevision:comic.revision})});setPageJob(result.job);acceptComic(result.comic);setPagePoll(value=>value+1);}
    catch(e){setError(errorMessage(e));setPagePoll(value=>value+1);}
  }
  return <ComicShell><main className="mx-auto max-w-[1200px] px-4 pt-8 sm:px-6">
    <Link href="/" className="font-bold underline decoration-2 underline-offset-4">← Back to comics</Link>
    {!comic ? <div className="mt-8">{error ? <Message error>{error} {error === 'Comic not found.' && <>Drafts are available in the browser that created them. <Link href="/drafts" className="font-bold underline">My drafts</Link></>}</Message> : <Message>Opening your draft…</Message>}</div> : <>
      <div className="mb-8 mt-6 flex flex-wrap items-end justify-between gap-5"><div><Eyebrow>Creator’s desk</Eyebrow><h1 className="font-display mt-3 text-4xl font-normal uppercase leading-none sm:text-5xl">{comic.title}</h1><p className="mt-2 text-sm">{styles.find(s => s.id === comic.style)?.name || comic.style} · {comic.published ? 'Published' : 'Private draft'}{comic.unpublishedChanges ? ' · Unpublished changes' : ''}</p></div><div className="flex flex-wrap gap-3">{comic.published && <><Link href={`/read/${encodeURIComponent(id)}`} className={secondaryButton}>View published</Link><button disabled={!!busy} className={secondaryButton} onClick={()=>setShowWithdraw(true)}>Withdraw from gallery</button></>}<button onClick={() => {setError(''); setShowPublish(true);}} className={button}>{comic.published ? 'Republish' : 'Publish'}</button></div></div>
      {(error && !showPublish && !revisionDialog || notice || busy) && <div className="fixed bottom-4 right-4 z-40 w-[min(28rem,calc(100vw-2rem))] shadow-[4px_4px_0_#171717]">{error && !showPublish && !revisionDialog ? <Message error>{error} <button className="ml-3 underline" onClick={()=>setError('')}>Dismiss</button></Message> : notice ? <Message>{notice} <button className="ml-3 underline" onClick={()=>setNotice('')}>Dismiss</button></Message> : <p className="border-2 border-[#171717] bg-[#ffd83d] px-4 py-3 font-bold" role="status">{busy}…</p>}</div>}
      {hosted && discoveryState==='pending' && <p className="mb-5 font-bold" role="status">Checking draft activity…</p>}
      {hosted && discoveryState==='failed' && <button className={`${secondaryButton} mb-5`} onClick={()=>{setError('');setDiscoveryAttempt(value=>value+1);}}>Retry checking draft activity</button>}
      {hosted && hostedOperations.some(entry=>entry.action!=='exportPage' || entry.status!=='succeeded') && <section aria-label="Draft operations" className="mb-5 border-2 border-[#171717] bg-[#fff8e8] p-4"><h2 className="font-bold">Draft activity</h2><ul className="mt-2 space-y-2">{hostedOperations.filter(entry=>entry.action!=='exportPage' || entry.status!=='succeeded').map(entry=><li key={entry.requestKey}><strong>{operationLabels[entry.action] ?? 'Draft action'}:</strong> <span>{entry.status==='unknown_outcome' ? 'The outcome is unknown. Check it before trying this action again.' : entry.status==='failed' ? `${operationDetail(entry.error) || 'The action did not complete.'} Review the draft and use its control to retry.` : entry.status==='obsolete' || entry.status==='revoked' ? 'The action could not continue. Refresh the draft before trying again.' : entry.id ? operationDetail(entry.progress) || 'An action is in progress.' : 'The connection was interrupted before the action was confirmed.'}</span>{(!entry.id || entry.status==='unknown_outcome' || entry.status==='queued' || entry.status==='running') && <button disabled={!!busy} className={`${secondaryButton} ml-3`} onClick={()=>checkHostedOperation(entry)}>{entry.id?'Check status':'Check request'}</button>}{entry.redacted && !entry.id && ['initialQuestions','suggestCharacters'].includes(entry.action) && <button disabled={!!busy} className={`${secondaryButton} ml-3`} onClick={()=>retryEmptyHostedOperation(entry)}>Retry original request</button>}</li>)}</ul></section>}
      <section className="mb-8 border-[3px] border-[#171717] bg-[#fffef8] shadow-[4px_4px_0_#171717]"><div className="border-b-[3px] border-[#171717] bg-[#ffd83d] px-5 py-3"><h2 className="font-display font-normal uppercase">01 / Shape your story</h2></div><div className="p-5"><p className="max-w-3xl whitespace-pre-wrap leading-relaxed">{comic.plot}</p>{!questionUnknown && !questionFailed && (questionsBusy || comic.initialQuestions === 'pending' || comic.initialQuestions === 'running') && <p className="mt-5 font-bold" role="status">Finding questions for your story…</p>}{(questionUnknown || comic.initialQuestions === 'unknown') && <p className="mt-5 font-bold">The questions request could not be confirmed. Resolve the previous request before trying again.</p>}{!questionsBusy && (questionFailed || comic.initialQuestions === 'failed') && <div className="mt-5"><button disabled={!!busy} className={secondaryButton} onClick={() => withSavedAnswers(updated => action('Finding questions','/questions',{},'POST',updated))}>Retry questions</button></div>}{!!comic.questions?.length && !questionUnknown && comic.initialQuestions !== 'unknown' && <div className="mt-5"><button disabled={!!busy || questionsBusy} className={secondaryButton} onClick={() => withSavedAnswers(updated => action('Finding questions','/questions',{},'POST',updated))}>Refresh questions</button></div>}
      {!!comic.questions?.length && <div className="mt-6 space-y-5">{comic.questions.map(q => <div key={q.id}><label htmlFor={`q-${q.id}`} className="mb-2 block font-bold">{q.question}</label><input id={`q-${q.id}`} value={answers[q.id] || ''} placeholder={q.suggestedAnswer || 'Your answer'} onChange={e => changeAnswer(q.id,e.target.value)} className={field} />{q.suggestedAnswer && <button type="button" className="mt-2 font-bold underline" onClick={()=>changeAnswer(q.id,q.suggestedAnswer!)}>Use suggestion: {q.suggestedAnswer}</button>}{q.id in answerConflicts && <div className="mt-2 border-2 border-[#cf302b] p-3" role="alert"><p>This answer changed elsewhere. Saved answer: {answerConflicts[q.id] || '(empty)'}</p><div className="mt-2 flex flex-wrap gap-2"><button type="button" className={secondaryButton} aria-label={`Use saved answer for ${q.question}`} onClick={()=>resolveAnswer(q.id,false)}>Use saved answer</button><button type="button" className={secondaryButton} aria-label={`Keep my answer for ${q.question}`} onClick={()=>resolveAnswer(q.id,true)}>Keep my answer</button></div></div>}</div>)}<button className={button} disabled={!!busy || !!textRequestRunning} onClick={()=>void saveAnswers()}>Save answers</button></div>}</div></section>
      <section className="mb-8 border-[3px] border-[#171717] bg-[#fffef8] shadow-[4px_4px_0_#171717]"><div className="border-b-[3px] border-[#171717] bg-[#ffd83d] px-5 py-3"><h2 className="font-display font-normal uppercase">02 / Meet your characters</h2></div><div className="p-5"><p className="max-w-2xl">Review a suggested character or create your own, then approve their reference image before planning pages.</p>
        {!pages.length && <div className="mt-5 border-2 border-[#171717] bg-[#fff8e8] p-4"><h3 className="text-lg font-black">Suggested from your story</h3>{comic.initialSuggestions === 'running' || (comic.initialSuggestions === 'pending' && comic.initialQuestions === 'complete' && !suggestionStartFailed) ? <p role="status" className="mt-2">Thinking up your characters…</p> : comic.initialSuggestions === 'unknown' ? <p className="mt-2">The suggestion request could not be confirmed. Resolve the previous request before trying again.</p> : <>{suggestions.length > 0 && <div className="mt-4 grid gap-3 md:grid-cols-2">{suggestions.map(suggestion => <article key={suggestion.id} className="border-2 border-[#171717] bg-white p-4"><h4 className="text-lg font-black">{suggestion.name}</h4><p className="text-sm">{suggestion.role}</p><p className="mt-2 text-sm">{suggestion.appearance}</p><p className="mt-1 text-sm"><strong>Outfit:</strong> {suggestion.outfit}</p><button type="button" disabled={!!busy} className={`${secondaryButton} mt-3`} onClick={() => {setEditingCharacter(null);setCharacter({name:suggestion.name,role:suggestion.role,appearance:suggestion.appearance,outfit:suggestion.outfit}); window.setTimeout(() => {characterForm.current?.scrollIntoView({behavior:'smooth',block:'center'});characterForm.current?.querySelector<HTMLInputElement>('input')?.focus({preventScroll:true});},0);}}>Review suggestion</button></article>)}</div>}{(comic.initialSuggestions === 'idle' || comic.initialSuggestions === 'failed' || comic.initialSuggestions === 'complete' || (comic.initialSuggestions === 'pending' && (comic.initialQuestions === 'failed' || suggestionStartFailed))) && <button disabled={!!busy || questionsBusy} className={`${secondaryButton} mt-3`} onClick={() => withSavedAnswers(() => action('Suggesting characters','/characters/suggestions',{retry:true}))}>{comic.initialSuggestions === 'failed' ? 'Retry suggestions' : comic.initialSuggestions === 'complete' ? 'Refresh suggestions' : 'Suggest characters'}</button>}</>}</div>}
        {!!characters.length && <div className="mt-5 grid gap-4 md:grid-cols-2">{characters.map(c => <article key={c.id} className="border-2 border-[#171717] p-4">{c.referenceUrl && <a href={c.referenceUrl} target="_blank" rel="noreferrer" aria-label={`Open full-size reference for ${c.name}`}><img src={c.referenceUrl} alt={`Reference for ${c.name}`} className="mb-1 max-h-48 w-full border-2 border-[#171717] object-contain" /><span className="text-sm font-bold underline">Open full-size reference</span></a>}<div className="flex items-start justify-between gap-3"><div><h3 className="text-xl font-black">{c.name}</h3><p className="text-sm">{c.role}</p></div><span className="border-2 border-[#171717] bg-[#ffd83d] px-2 py-1 text-xs font-bold">{c.referenceStatus === 'running' ? 'Drawing' : c.approved ? 'Approved' : c.referenceUrl ? 'Needs approval' : 'No reference yet'}</span></div><p className="mt-3 text-sm">{c.appearance}</p><p className="mt-1 text-sm"><strong>Outfit:</strong> {c.outfit}</p>{c.referenceStatus === 'running' && <p className="mt-3 font-bold" role="status">Drawing reference…</p>}{c.referenceStatus === 'unknown_outcome' && <p className="mt-3 font-bold">The reference request could not be confirmed. Resolve the previous request before trying again.</p>}<div className="mt-4 flex flex-wrap gap-3">{c.referenceStatus !== 'running' && c.referenceStatus !== 'unknown_outcome' && <button disabled={!!busy || !!drawingCharacter || !!textRequestRunning || !!c.lockedByStory} className={secondaryButton} onClick={() => void drawReference(c.id)}>{c.referenceUrl ? 'Redraw reference (AI call)' : 'Draw reference (AI call)'}</button>}{c.referenceUrl && c.referenceVersion && !c.approved && <button disabled={!!busy} className={button} onClick={() => action('Approving reference',`/characters/${encodeURIComponent(c.id)}/approve`,{assetId:c.referenceVersion})}>Approve</button>}{!c.lockedByStory && <><button disabled={!!busy} className={secondaryButton} onClick={() => {setEditingCharacter(c.id); setCharacter({name:c.name,role:c.role,appearance:c.appearance,outfit:c.outfit});window.setTimeout(() => {characterForm.current?.scrollIntoView({behavior:'smooth',block:'center'});characterForm.current?.querySelector<HTMLInputElement>('input')?.focus({preventScroll:true});},0);}}>Edit card</button><button disabled={!!busy} className={secondaryButton} onClick={async () => {if (window.confirm(`Remove ${c.name} from this comic?`) && await action('Removing character',`/characters/${encodeURIComponent(c.id)}`,{},'DELETE') && editingCharacter === c.id) cancelCharacterEdit();}}>Remove</button></>}{c.lockedByStory && <p className="text-sm">This card is used by the planned story and is locked to preserve its artwork.</p>}</div></article>)}</div>}
        <form ref={characterForm} onSubmit={editingCharacter ? saveCharacter : addCharacter} className="mt-6 border-2 border-[#171717] bg-[#fff8e8] p-4"><h3 className="mb-4 text-lg font-black">{editingCharacter ? 'Edit character' : 'Add a character'}</h3>{editingCharacter && <p className="mb-4 text-sm">Changing a card clears its reference image and approval so you can create a matching reference.</p>}<div className="grid gap-4 sm:grid-cols-2">{(['name','role','appearance','outfit'] as const).map(key => <div key={key}><label className="mb-1 block text-sm font-bold capitalize" htmlFor={`character-${key}`}>{key}</label><input id={`character-${key}`} required disabled={!!busy} value={character[key]} onChange={e => setCharacter({...character,[key]:e.target.value})} className={field} /></div>)}</div><div className="mt-4 flex gap-3"><button disabled={!!busy || !!textRequestRunning} className={button} type="submit">{editingCharacter ? 'Save character' : 'Add character'}</button>{editingCharacter && <button disabled={!!busy} className={secondaryButton} type="button" onClick={cancelCharacterEdit}>Cancel</button>}</div>{!!pages.length && <p className="mt-3 text-sm">New characters can be added here. Use a story change to include them in planned panels.</p>}</form>
      </div></section>
      <section className="border-[3px] border-[#171717] bg-[#fffef8] shadow-[4px_4px_0_#171717]"><div className="border-b-[3px] border-[#171717] bg-[#ffd83d] px-5 py-3"><h2 className="font-display font-normal uppercase">03 / The comic</h2></div><div className="p-5"><div className="flex flex-wrap items-center justify-between gap-4"><p>Plan the beats, then draw each page in order.</p>{!pages.length && <button disabled={!!busy || !!drawingCharacter || !!textRequestRunning} className={button} onClick={() => withSavedAnswers(updated => action('Planning story','/story/plan',{},'POST',updated))}>Plan story →</button>}</div>
        <div className="mt-5 flex flex-wrap gap-5"><div><label htmlFor="panels-per-page" className="mb-1 block font-bold">Panels per page</label><select id="panels-per-page" className={field} disabled={!!busy || !!pages.length} value={comic.panelsPerPage ?? 3} onChange={event => action('Updating panel count','',{panelsPerPage:Number(event.target.value)},'PATCH')}><option value={2}>2 panels</option><option value={3}>3 panels</option><option value={4}>4 panels</option></select><p className="mt-1 text-sm">Choose before planning.</p></div><div><label htmlFor="page-layout" className="mb-1 block font-bold">Page layout</label><select id="page-layout" className={field} disabled={!!busy} value={comic.pageLayout ?? 'stack'} onChange={event => action('Updating page layout','',{pageLayout:event.target.value},'PATCH')}><option value="stack">Vertical stack</option><option value="grid">Two-column grid</option></select><p className="mt-1 text-sm">Applies to downloads. Republish to update the public edition.</p></div></div>
        {comic.storyboard && <section aria-label="Story beats" className="mt-5 border-2 border-[#171717] bg-white p-4"><h3 className="text-lg font-black">Review your story</h3><p className="mt-1 text-sm">Read the beats and dialogue before approving this story for drawing.</p><StoryBeats storyboard={comic.storyboard} characters={characters} /></section>}
        {comic.storyReview && <div className="mt-5 border-2 border-[#171717] bg-[#fff8e8] p-4"><h3 className="font-bold">Story review: {comic.storyReview.outcome}</h3>{comic.storyReview.outcome === 'pending' && <p className="mt-2 text-sm">Checking the story in the background; findings will appear here.</p>}{comic.storyReview.findings?.map((finding,i) => <p key={i} className="mt-2 text-sm"><strong>{finding.dimension.replace(/_/g,' ')}:</strong> {readableFinding(finding.observed,pages)} {finding.expected && `Expected: ${readableFinding(finding.expected,pages)}`}</p>)}{comic.storyReview.findings?.length > 0 && <p className="mt-3 text-sm">These suggestions are advisory. To address one, select a panel and use Change the story.</p>}{comic.storyReview.accepted && <p className="mt-3 text-sm font-bold">You accepted this story review.</p>}{!comic.storyReview.accepted && comic.storyReview.outcome === 'findings' && comic.storyReview.fingerprint && comic.storyReview.findings.some(finding => finding.severity === 'blocker') && <button disabled={!!busy} className={`${secondaryButton} mt-3`} onClick={() => {if (window.confirm('The automated check flagged a possible story contradiction. Accept this story review and continue anyway?')) action('Accepting story review','/story/accept',{fingerprint:comic.storyReview!.fingerprint});}}>Accept story review and continue</button>}</div>}
        {comic.storyApproval && <div className="mt-4">{comic.storyApproval.approved ? <p className="font-bold">Story approved for drawing.</p> : <><p className="mb-3">Approve this story before drawing or changing artwork.</p><button disabled={!!busy} className={button} onClick={() => action('Approving story','/story/approve',{revision:comic.revision,storyRevision:comic.storyApproval!.storyRevision,fingerprint:comic.storyApproval!.fingerprint})}>Approve story</button></>}</div>}
        {comic.pendingRevision?.id === dismissedRevision && <button className={`${secondaryButton} mt-4`} onClick={()=>setDismissedRevision(null)}>Show story revision preview</button>}
        {comic.pendingRevision && !comic.pendingRevision.current && <p className="mt-3 font-bold">The draft changed. Preview the story change again.</p>}
        {!pages.length ? <div className="mt-5 border-2 border-dashed border-[#171717] bg-[#fff8e8] p-8 text-center"><h3 className="text-xl font-black uppercase">Your pages will appear here.</h3><p className="mt-2">Answer the questions and approve your characters to plan your story.</p></div> : <div className="mt-6 grid gap-5 lg:grid-cols-[110px_minmax(0,1fr)_260px]">
          <nav aria-label="Comic pages" className="flex gap-2 overflow-auto lg:flex-col">{pages.map((p,i) => <button key={p.id} disabled={busy === 'Drawing page'} onClick={() => {setSelectedPage(i);setSelectedPanel(0);}} aria-current={selectedPage===i ? 'page' : undefined} className={`min-h-11 min-w-20 border-2 border-[#171717] px-4 py-3 font-black ${selectedPage===i ? 'bg-[#ffd83d]' : 'bg-white'}`}>Page {p.index}</button>)}</nav>
          <div><div className="mb-3 flex flex-wrap items-center justify-between gap-3"><strong>PAGE {page?.index} · {page?.status}</strong>{page && <div className="flex flex-wrap gap-3"><button disabled={!!busy || !comic.storyApproval?.approved || !!previousPageNeedsReview || (!hosted && pageJob?.state === 'unknown')} className={secondaryButton} onClick={() => {const resume=page.generationPending || page.panels.some(p=>!p.imageUrl || ['planned','outdated','checking'].includes(p.status ?? ''));if(!resume && page.panels.some(p=>p.imageUrl) && page.panels.every(p=>p.ready ?? (!!p.imageUrl && (p.evaluation==='pass'||p.accepted))) && !window.confirm(`Redraw all ${page.panels.length} panels on this page? Each panel uses an AI image call.`))return;hosted ? void action('Drawing page',`/pages/${encodeURIComponent(page.id)}/generate`) : void startPage();}}>{hosted && (page.generationPending || (page.panels?.some(p => p.imageUrl) && page.panels.some(p => !p.imageUrl || p.status === 'outdated' || p.status === 'planned' || p.status === 'checking'))) ? 'Continue page' : page.panels?.some(p => p.imageUrl) ? 'Redraw entire page' : 'Generate page'}</button>{page.panels?.length > 0 && page.panels.every(p => p.ready ?? (!!p.imageUrl && (p.evaluation === 'pass' || p.accepted))) && (hosted ? <>{pageExport ? <a className={secondaryButton} href={`/api/operations/${encodeURIComponent(pageExport.id!)}/export`}>Download page</a> : <button disabled={!!busy} className={secondaryButton} onClick={() => action('Preparing download',`/pages/${encodeURIComponent(page.id)}/download`)}>Prepare download</button>}</> : <a className={secondaryButton} href={`${base}/pages/${encodeURIComponent(page.id)}/download`}>Download page</a>)}</div>}</div>{previousPageNeedsReview && <p className="mb-3 text-sm font-bold">Finish and review the preceding page before drawing this one.</p>}{!hosted && pageJob?.state === 'running' && <p role="status" className="mb-3 font-bold">Drawing page {page.index} — panel {Math.min((pageJob.completed ?? 0)+1,pageJob.total || page.panels.length)} of {pageJob.total || page.panels.length}. You can return to check progress.</p>}{!hosted && pageJob?.state === 'unknown' && <p role="alert" className="mb-3 font-bold">The previous page request needs operator recovery before retrying.</p>}<div className="space-y-3 border-[3px] border-[#171717] bg-white p-3">{page?.panels?.map((p,i) => <button key={p.id} onClick={() => setSelectedPanel(i)} aria-pressed={selectedPanel===i} className={`block min-h-36 w-full border-[3px] text-left ${selectedPanel===i ? 'border-[#ffd83d] outline-2 outline-[#171717]' : 'border-[#171717]'}`}>{p.imageUrl ? <img src={p.imageUrl} alt={`Page ${page.index}, panel ${i+1}`} className="h-auto w-full" /> : <span className="flex min-h-36 items-center justify-center bg-[#f4ead5] p-4 text-center font-bold">{p.description || `Panel ${i+1} — ${p.status || 'not drawn yet'}`}</span>}</button>)}</div>{page?.status === 'outdated' && <p className="mt-3 border-2 border-[#cf302b] p-3 font-bold">Story changed — this page needs updating.</p>}</div>
          <aside className="border-2 border-[#171717] p-4"><h3 className="border-b-2 border-[#171717] pb-2 text-lg font-black uppercase">Selected panel</h3>{panel ? <><p className="mt-3 text-sm">Panel {selectedPanel+1} · {panel.status || 'planned'}</p>{panel.evaluation && <div className="mt-3 border-2 border-[#171717] bg-[#fff8e8] p-3"><h4 className="font-bold">Check: {panel.status === 'checking' ? 'checking' : panel.evaluation}{panel.accepted ? ' · Accepted' : ''}</h4>{panel.imageUrl && panel.status !== 'checking' && <p className="mt-2 text-sm">{panel.reviewOutcome ? reviewMessages[panel.reviewOutcome] : 'Review result unavailable. Inspect the panel before accepting.'}</p>}{panel.findings?.map((finding,i) => <p key={i} className="mt-2 text-sm"><strong>{finding.dimension.replace(/_/g,' ')}:</strong> {readableFinding(finding.observed,pages)} {finding.expected && `Expected: ${readableFinding(finding.expected,pages)}`}</p>)}{panel.accepted && <p className="mt-2 text-sm font-bold">You accepted these findings for this image.</p>}{!panel.accepted && panel.reviewVersion && panel.status === 'needs_review' && <button disabled={!!busy} className={`${secondaryButton} mt-3 w-full`} onClick={() => {if (panel.evaluation !== 'blocker' || window.confirm('The automated check flagged a possible contradiction. Accept this exact panel and continue anyway?')) action('Accepting panel',`/panels/${encodeURIComponent(panel.id)}/accept`,panel.reviewVersion);}}>Accept this panel</button>}</div>}<label htmlFor="art-edit" className="mb-1 mt-5 block text-sm font-bold">Edit artwork</label><textarea id="art-edit" value={artEdit} onChange={e => {setArtEdit(e.target.value); setEditDecision(null);}} rows={3} className={field} placeholder="Describe a visual change" /><button disabled={!!busy || !artEdit.trim() || !panel.reviewVersion} className={`${secondaryButton} mt-3 w-full`} onClick={() => panel.reviewVersion && editArtwork(panel.id,panel.reviewVersion)}>Apply artwork edit (AI call)</button>{activeEditDecision?.panelId === panel.id && <div className="mt-3 border-2 border-[#171717] bg-[#fff8e8] p-3" role="status"><p className="font-bold">{activeEditDecision.intent === 'story' ? 'This may change the story.' : 'Does this change the story?'}</p><p className="mt-1 text-sm">{activeEditDecision.reason}</p><button disabled={!!busy} className={`${button} mt-3 w-full`} onClick={() => reviseStory(activeEditDecision.panelId,activeEditDecision.instruction,activeEditDecision.reviewedVersion)}>Preview as story change</button>{activeEditDecision.intent === 'uncertain' && <button disabled={!!busy} className={`${secondaryButton} mt-3 w-full`} onClick={() => confirmArtworkChoice(activeEditDecision)}>Artwork only — story stays unchanged</button>}</div>}<label htmlFor="story-edit" className="mb-1 mt-6 block text-sm font-bold">Change the story</label><textarea id="story-edit" value={storyEdit} onChange={e => {setStoryEdit(e.target.value);if(!hosted || workspaceRef.current)sessionStorage.setItem(storyDraftKey(id,panel.id,hosted ? workspaceRef.current : null),e.target.value);}} rows={3} className={field} placeholder="Describe the plot change" /><p className="mt-2 text-sm">Previewing uses an AI call. Review the affected range before applying the change.</p><button disabled={!!busy || !storyEdit.trim()} className={`${button} mt-3 w-full`} onClick={() => reviseStory(panel.id)}>Preview story change</button></> : <p className="mt-3 text-sm">Select a panel to edit it.</p>}</aside>
        </div>}
      </div></section>
      {showWithdraw && <PublishDialog onDismiss={()=>setShowWithdraw(false)}><h2 id="publish-title" className="font-display text-3xl uppercase">Withdraw from gallery?</h2><p className="mt-3">Readers will no longer be able to open this public edition. Your private draft stays available here.</p><div className="mt-5 flex gap-3"><button className={secondaryButton} onClick={()=>setShowWithdraw(false)}>Cancel</button><button className={button} disabled={!!busy} onClick={async()=>{if(await action('Withdrawing','/unpublish')){setShowWithdraw(false);setNotice('Withdrawn from the gallery.');}}}>Withdraw comic</button></div></PublishDialog>}
      {revisionDialog && <RevisionDialog proposal={revisionDialog} busy={!!busy} error={error} onDismiss={()=>{setDismissedRevision(revisionDialog.id);setLegacyRevision(null);setError('');setNotice('Preview saved. Return to it while the draft remains unchanged.');}} onApply={()=>void action('Revising story','/revisions',{proposalId:revisionDialog.id}).then(applied=>{if(applied){if(panel?.id && (!hosted || workspaceRef.current))sessionStorage.removeItem(storyDraftKey(id,panel.id,hosted ? workspaceRef.current : null));setStoryEdit('');setLegacyRevision(null);}})} />}
      {showPublish && <PublishDialog onDismiss={() => setShowPublish(false)}><h2 id="publish-title" className="font-display text-3xl font-normal uppercase">Publish your comic</h2><p className="mt-3">This edition will be public. Later edits stay private until you republish.</p><form onSubmit={publish} className="mt-5 space-y-4">{error && <Message error>{error}</Message>}<div><label htmlFor="publish-name" className="mb-1 block font-bold">Title</label><input id="publish-name" value={publishTitle} required onChange={e => setPublishTitle(e.target.value)} className={field} /></div><div><label htmlFor="creator" className="mb-1 block font-bold">Creator display name (optional)</label><input id="creator" value={creator} onChange={e => setCreator(e.target.value)} placeholder="Anonymous" className={field} /></div><p className="text-sm">{completedPages.length} of {pages.length} planned {pages.length===1?'page is':'pages are'} complete. {canPublish ? 'All pages will be included.' : pendingReviews.length ? `${pendingReviews.length} panel checks need your review or acceptance.` : 'Draw every page before publishing.'}</p>{pages[0]?.panels[0]?.imageUrl && <img src={pages[0].panels[0].imageUrl} alt="First panel preview" className="max-h-40 w-full border-2 border-[#171717] object-contain" />}<div className="flex flex-wrap gap-3"><button type="button" className={secondaryButton} onClick={() => setShowPublish(false)}>Cancel</button><button disabled={!!busy || !canPublish} className={button} type="submit">{comic.published?'Republish':'Publish comic'}</button></div></form></PublishDialog>}
    </>}
  </main></ComicShell>;
}
