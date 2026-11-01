'use client';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { PublishDialog } from './PublishDialog';
import { ComicShell, Eyebrow, Message, button, field, secondaryButton } from './ComicShell';
import { errorMessage, request } from './api';
import { styles, type DraftComic, type Panel, type RevisionPreview } from './types';

type DraftResponse = {comic?: DraftComic; questions?: DraftComic['questions']; jobId?: string; notice?: string};
type EditDecision = {intent:'story' | 'uncertain';reason:string;panelId:string;reviewedVersion:NonNullable<Panel['reviewVersion']>;proposalId?:string;instruction:string};
const reviewMessages = {
  pass: 'Automated review completed without findings. Inspect the panel before accepting.',
  findings: 'Automated review completed and found possible issues. Inspect the panel and findings.',
  inconclusive: 'Automated review was inconclusive. Inspect the panel before accepting.',
  failed: 'Automated review could not complete. Inspect the panel before accepting.',
} as const;
function StoryBeats({storyboard, characters}: {storyboard:NonNullable<DraftComic['storyboard']>; characters:NonNullable<DraftComic['characters']>}) {
  return <div className="mt-3 space-y-4"><div><p><strong>Premise:</strong> {storyboard.bible.premise}</p><p><strong>Setting:</strong> {storyboard.bible.setting}</p>{storyboard.bible.rules.length > 0 && <p><strong>Story rules:</strong> {storyboard.bible.rules.join('; ')}</p>}</div>{storyboard.pages.map(page => <div key={page.index}><h4 className="font-bold">Page {page.index}</h4><ol className="mt-2 list-decimal space-y-2 pl-5">{page.panels.map(panel => <li key={panel.id}><p>{panel.action}</p>{panel.dialogue.map((line,index) => <p key={index} className="mt-1 text-sm"><strong>{characters.find(character => character.id === line.speaker_id)?.name ?? line.speaker_id}:</strong> {line.text}</p>)}</li>)}</ol></div>)}</div>;
}
export default function ComicEditor({ id }: { id: string }) {
  const base = `/api/comics/${encodeURIComponent(id)}`;
  const [comic, setComic] = useState<DraftComic | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [questionsBusy, setQuestionsBusy] = useState(false);
  const [suggestionStartFailed, setSuggestionStartFailed] = useState(false);
  const initialQuestionRequest = useRef<string | null>(null);
  const initialSuggestionRequest = useRef<string | null>(null);
  const addingCharacter = useRef(false);
  const [selectedPage, setSelectedPage] = useState(0);
  const [selectedPanel, setSelectedPanel] = useState(0);
  const [answers, setAnswers] = useState<Record<string,string>>({});
  const [character, setCharacter] = useState({name:'',role:'',appearance:'',outfit:''});
  const [editingCharacter, setEditingCharacter] = useState<string | null>(null);
  const [artEdit, setArtEdit] = useState('');
  const [editDecision, setEditDecision] = useState<EditDecision | null>(null);
  const [storyEdit, setStoryEdit] = useState('');
  const [dismissedRevision, setDismissedRevision] = useState<string | null>(null);
  const [showPublish, setShowPublish] = useState(false);
  const [creator, setCreator] = useState('');
  const [publishTitle, setPublishTitle] = useState('');
  const refresh = useCallback(async () => {
    const data = await request<{comic:DraftComic}>(base);
    setComic(data.comic); setPublishTitle(data.comic.publication?.title ?? data.comic.title); setCreator(data.comic.publication?.creator ?? '');
    return data.comic;
  }, [base]);
  useEffect(() => { let alive = true; request<{comic:DraftComic}>(base).then(data => { if (alive) { setComic(data.comic); setAnswers(data.comic.answers || {}); setPublishTitle(data.comic.publication?.title ?? data.comic.title); setCreator(data.comic.publication?.creator ?? ''); } }).catch(e => { if (alive) setError(errorMessage(e)); }); return () => {alive = false;}; }, [base]);
  useEffect(() => {
    if (comic?.id !== id || comic.initialQuestions !== 'pending' || initialQuestionRequest.current === id) return;
    initialQuestionRequest.current = id;
    setQuestionsBusy(true);
    request<{comic:DraftComic}>(`${base}/questions/initial`, {method:'POST',body:'{}'})
      .then(async data => {try {await refresh();} catch {setComic(data.comic);}})
      .catch(async e => { try { const current=await refresh(); if (current.initialQuestions !== 'running' && current.initialQuestions !== 'complete') setError(errorMessage(e)); } catch {setError(errorMessage(e));} })
      .finally(() => setQuestionsBusy(false));
  }, [base, id, comic?.id, comic?.initialQuestions, refresh]);
  useEffect(() => {
    if (comic?.id !== id || comic.initialQuestions !== 'complete' || comic.initialSuggestions !== 'pending' || initialSuggestionRequest.current === id) return;
    initialSuggestionRequest.current=id;
    setSuggestionStartFailed(false);
    request<{comic:DraftComic}>(`${base}/characters/suggestions`,{method:'POST',body:'{}'})
      .then(async data => {try {await refresh();} catch {setComic(data.comic);}})
      .catch(async e => {try {const current=await refresh();if (current.initialSuggestions !== 'running' && current.initialSuggestions !== 'complete') {setSuggestionStartFailed(current.initialSuggestions === 'pending');setError(errorMessage(e));}} catch {setSuggestionStartFailed(true);setError(errorMessage(e));}});
  }, [base,id,comic?.id,comic?.initialQuestions,comic?.initialSuggestions,refresh]);
  useEffect(() => {
    if (comic?.initialQuestions !== 'running' && comic?.initialSuggestions !== 'running' && !comic?.characters?.some(c => c.referenceStatus === 'running')) return;
    const timer=window.setInterval(() => {void refresh().catch(() => {});}, 2500);
    return () => window.clearInterval(timer);
  }, [comic?.initialQuestions, comic?.initialSuggestions, comic?.characters, refresh]);
  async function action(label: string, path: string, body: unknown = {}, method = 'POST') {
    setBusy(label); setError(''); setNotice('');
    try {
      const data = await request<DraftResponse>(`${base}${path}`, {method,body:JSON.stringify(body)});
      if (data.notice) setNotice(data.notice);
      if (data.comic) setComic(data.comic);
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
      const {proposal} = await request<{proposal:RevisionPreview}>(`${base}/revisions/preview`, {method:'POST',body:JSON.stringify({panelId,instruction,...(reviewedVersion ? {reviewedVersion} : {})})});
      setComic(current => current ? {...current,revision:proposal.baseRevision,pendingRevision:proposal,pendingArtworkDecision:null} : current);
      setEditDecision(null);
      setDismissedRevision(null);
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(''); }
  }
  async function addCharacter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (addingCharacter.current) return; addingCharacter.current=true; setBusy('Adding character'); setError(''); setNotice('');
    try {
      const {comic:updated}=await request<{comic:DraftComic}>(`${base}/characters`,{method:'POST',body:JSON.stringify(character)});
      const newCharacter=updated.characters?.[updated.characters.length-1];
      if (!newCharacter) throw new Error('The character was added but could not be found. Refresh the draft.');
      setComic(updated); setCharacter({name:'',role:'',appearance:'',outfit:''}); setBusy('Drawing reference');
      const result=await request<{comic:DraftComic}>(`${base}/characters/${encodeURIComponent(newCharacter.id)}/reference`,{method:'POST',body:'{}'});
      setComic(result.comic);
    } catch (e) {
      setError(errorMessage(e));
      try {await refresh();} catch { /* Preserve the original error. */ }
    } finally {addingCharacter.current=false;setBusy('');}
  }
  async function editArtwork(panelId:string, reviewedVersion:NonNullable<Panel['reviewVersion']>) {
    setBusy('Checking edit'); setError(''); setNotice(''); setEditDecision(null);
    try {
      const result=await request<{comic?:DraftComic;editDecision?:Omit<EditDecision,'instruction'>}>(`${base}/panels/${encodeURIComponent(panelId)}/edit`,{method:'POST',body:JSON.stringify({instruction:artEdit,...reviewedVersion})});
      if (result.comic) setComic(result.comic);
      if (result.editDecision) setEditDecision({...result.editDecision,instruction:artEdit});
    } catch (e) {setError(errorMessage(e)); try {await refresh();} catch { /* Keep the original error visible. */ }}
    finally {setBusy('');}
  }
  async function confirmArtworkChoice(choice:EditDecision) {
    if (!choice.proposalId || !window.confirm('Apply this as an artwork-only correction? The plot and scene state will stay unchanged, and later panels will not be revised.')) return;
    if (await action('Editing panel',`/panels/${encodeURIComponent(choice.panelId)}/edit`,{proposalId:choice.proposalId,decision:'artwork_only'})) setEditDecision(null);
  }
  async function saveCharacter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (editingCharacter && await action('Saving character',`/characters/${encodeURIComponent(editingCharacter)}`,character,'PATCH')) {
      setEditingCharacter(null); setCharacter({name:'',role:'',appearance:'',outfit:''});
    }
  }
  function cancelCharacterEdit() { setEditingCharacter(null); setCharacter({name:'',role:'',appearance:'',outfit:''}); }
  async function saveAnswers() { const saved = await action('Saving answers','', {answers}, 'PATCH'); if (saved) setNotice('Answers saved.'); return saved; }
  async function withSavedAnswers(next: () => Promise<boolean>) {
    if (JSON.stringify(answers) !== JSON.stringify(comic?.answers || {}) && !await saveAnswers()) return;
    await next();
  }
  async function publish(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (await action('Publishing','/publish',{title:publishTitle,creator})) { setShowPublish(false); setNotice('Published! Your comic is now on the community shelf.'); } }
  const pages = comic?.pages || [];
  const characters = comic?.characters || [];
  const suggestions = (comic?.characterSuggestions || []).filter(suggestion => !characters.some(c => c.name.toLocaleLowerCase('en-US') === suggestion.name.toLocaleLowerCase('en-US')));
  const page = pages[Math.min(selectedPage,Math.max(0,pages.length-1))];
  const panel = page?.panels?.[Math.min(selectedPanel,Math.max(0,page.panels.length-1))];
  const storedChoice = comic?.pendingArtworkDecision;
  const activeEditDecision = editDecision ?? (storedChoice?.current ? {intent:storedChoice.intent, reason:storedChoice.reason ?? 'Choose whether this changes the story.', panelId:storedChoice.panelId, reviewedVersion:storedChoice.reviewedVersion, proposalId:storedChoice.id, instruction:storedChoice.instruction} : null);
  return <ComicShell><main className="mx-auto max-w-[1200px] px-4 pt-8 sm:px-6">
    <Link href="/" className="font-bold underline decoration-2 underline-offset-4">← Back to comics</Link>
    {!comic ? <div className="mt-8">{error ? <Message error>{error}</Message> : <Message>Opening your draft…</Message>}</div> : <>
      <div className="mb-8 mt-6 flex flex-wrap items-end justify-between gap-5"><div><Eyebrow>Creator’s desk</Eyebrow><h1 className="font-display mt-3 text-4xl font-normal uppercase leading-none sm:text-5xl">{comic.title}</h1><p className="mt-2 text-sm">{styles.find(s => s.id === comic.style)?.name || comic.style} · {comic.published ? 'Published' : 'Private draft'}{comic.unpublishedChanges ? ' · Unpublished changes' : ''}</p></div><div className="flex flex-wrap gap-3">{comic.published && <Link href={`/read/${encodeURIComponent(id)}`} className={secondaryButton}>View published</Link>}<button onClick={() => {setError(''); setShowPublish(true);}} className={button}>{comic.published ? 'Republish' : 'Publish'}</button></div></div>
      {error && !showPublish && <div className="mb-5"><Message error>{error}</Message></div>}{notice && <div className="mb-5"><Message>{notice}</Message></div>}{busy && <p className="mb-5 border-2 border-[#171717] bg-[#ffd83d] px-4 py-3 font-bold" role="status">{busy}…</p>}
      <section className="mb-8 border-[3px] border-[#171717] bg-[#fffef8] shadow-[4px_4px_0_#171717]"><div className="border-b-[3px] border-[#171717] bg-[#ffd83d] px-5 py-3"><h2 className="font-display font-normal uppercase">01 / Shape your story</h2></div><div className="p-5"><p className="max-w-3xl whitespace-pre-wrap leading-relaxed">{comic.plot}</p>{(questionsBusy || comic.initialQuestions === 'pending' || comic.initialQuestions === 'running') && <p className="mt-5 font-bold" role="status">Finding questions for your story…</p>}{comic.initialQuestions === 'unknown' && <p className="mt-5 font-bold">The questions request could not be confirmed. Resolve the previous request before trying again.</p>}{!questionsBusy && comic.initialQuestions === 'failed' && <div className="mt-5"><button disabled={!!busy} className={secondaryButton} onClick={() => withSavedAnswers(() => action('Finding questions','/questions'))}>Retry questions</button></div>}{!!comic.questions?.length && comic.initialQuestions !== 'unknown' && <div className="mt-5"><button disabled={!!busy || questionsBusy} className={secondaryButton} onClick={() => withSavedAnswers(() => action('Finding questions','/questions'))}>Refresh questions</button></div>}
      {!!comic.questions?.length && <div className="mt-6 space-y-5">{comic.questions.map(q => <div key={q.id}><label htmlFor={`q-${q.id}`} className="mb-2 block font-bold">{q.question}</label><input id={`q-${q.id}`} value={answers[q.id] || ''} placeholder={q.suggestedAnswer || 'Your answer'} onChange={e => setAnswers({...answers,[q.id]:e.target.value})} className={field} /></div>)}<button className={button} disabled={!!busy} onClick={saveAnswers}>Save answers</button></div>}</div></section>
      <section className="mb-8 border-[3px] border-[#171717] bg-[#fffef8] shadow-[4px_4px_0_#171717]"><div className="border-b-[3px] border-[#171717] bg-[#ffd83d] px-5 py-3"><h2 className="font-display font-normal uppercase">02 / Meet your characters</h2></div><div className="p-5"><p className="max-w-2xl">Review a suggested character or create your own, then approve their reference image before planning pages.</p>
        {!pages.length && <div className="mt-5 border-2 border-[#171717] bg-[#fff8e8] p-4"><h3 className="text-lg font-black">Suggested from your story</h3>{comic.initialSuggestions === 'running' || (comic.initialSuggestions === 'pending' && comic.initialQuestions === 'complete' && !suggestionStartFailed) ? <p role="status" className="mt-2">Thinking up your characters…</p> : comic.initialSuggestions === 'unknown' ? <p className="mt-2">The suggestion request could not be confirmed. Resolve the previous request before trying again.</p> : <>{suggestions.length > 0 && <div className="mt-4 grid gap-3 md:grid-cols-2">{suggestions.map(suggestion => <article key={suggestion.id} className="border-2 border-[#171717] bg-white p-4"><h4 className="text-lg font-black">{suggestion.name}</h4><p className="text-sm">{suggestion.role}</p><p className="mt-2 text-sm">{suggestion.appearance}</p><p className="mt-1 text-sm"><strong>Outfit:</strong> {suggestion.outfit}</p><button type="button" disabled={!!busy} className={`${secondaryButton} mt-3`} onClick={() => {setEditingCharacter(null);setCharacter({name:suggestion.name,role:suggestion.role,appearance:suggestion.appearance,outfit:suggestion.outfit});}}>Review and add</button></article>)}</div>}{(comic.initialSuggestions === 'idle' || comic.initialSuggestions === 'failed' || comic.initialSuggestions === 'complete' || (comic.initialSuggestions === 'pending' && (comic.initialQuestions === 'failed' || suggestionStartFailed))) && <button disabled={!!busy || questionsBusy} className={`${secondaryButton} mt-3`} onClick={() => withSavedAnswers(() => action('Suggesting characters','/characters/suggestions',{retry:true}))}>{comic.initialSuggestions === 'failed' ? 'Retry suggestions' : comic.initialSuggestions === 'complete' ? 'Refresh suggestions' : 'Suggest characters'}</button>}</>}</div>}
        {!!characters.length && <div className="mt-5 grid gap-4 md:grid-cols-2">{characters.map(c => <article key={c.id} className="border-2 border-[#171717] p-4">{c.referenceUrl && <img src={c.referenceUrl} alt={`Reference for ${c.name}`} className="mb-3 max-h-48 w-full border-2 border-[#171717] object-contain" />}<div className="flex items-start justify-between gap-3"><div><h3 className="text-xl font-black">{c.name}</h3><p className="text-sm">{c.role}</p></div><span className="border-2 border-[#171717] bg-[#ffd83d] px-2 py-1 text-xs font-bold">{c.approved ? 'Approved' : 'Needs approval'}</span></div><p className="mt-3 text-sm">{c.appearance}</p><p className="mt-1 text-sm"><strong>Outfit:</strong> {c.outfit}</p>{c.referenceStatus === 'running' && <p className="mt-3 font-bold" role="status">Drawing reference…</p>}{c.referenceStatus === 'unknown_outcome' && <p className="mt-3 font-bold">The reference request could not be confirmed. Resolve the previous request before trying again.</p>}<div className="mt-4 flex flex-wrap gap-3">{c.referenceStatus !== 'running' && c.referenceStatus !== 'unknown_outcome' && <button disabled={!!busy || !!pages.length} className={secondaryButton} onClick={() => action('Drawing reference',`/characters/${encodeURIComponent(c.id)}/reference`)}>{c.referenceUrl ? 'Regenerate reference' : 'Retry reference'}</button>}{c.referenceUrl && c.referenceVersion && !c.approved && <button disabled={!!busy} className={button} onClick={() => action('Approving reference',`/characters/${encodeURIComponent(c.id)}/approve`,{assetId:c.referenceVersion})}>Approve</button>}{!pages.length && <><button disabled={!!busy} className={secondaryButton} onClick={() => {setEditingCharacter(c.id); setCharacter({name:c.name,role:c.role,appearance:c.appearance,outfit:c.outfit});}}>Edit card</button><button disabled={!!busy} className={secondaryButton} onClick={async () => {if (window.confirm(`Remove ${c.name} from this comic?`) && await action('Removing character',`/characters/${encodeURIComponent(c.id)}`,{},'DELETE') && editingCharacter === c.id) cancelCharacterEdit();}}>Remove</button></>}</div></article>)}</div>}
        {!pages.length && <form onSubmit={editingCharacter ? saveCharacter : addCharacter} className="mt-6 border-2 border-[#171717] bg-[#fff8e8] p-4"><h3 className="mb-4 text-lg font-black">{editingCharacter ? 'Edit character' : 'Add a character'}</h3>{editingCharacter && <p className="mb-4 text-sm">Changing a card clears its reference image and approval so you can create a matching reference.</p>}<div className="grid gap-4 sm:grid-cols-2">{(['name','role','appearance','outfit'] as const).map(key => <div key={key}><label className="mb-1 block text-sm font-bold capitalize" htmlFor={`character-${key}`}>{key}</label><input id={`character-${key}`} required disabled={!!busy} value={character[key]} onChange={e => setCharacter({...character,[key]:e.target.value})} className={field} /></div>)}</div><div className="mt-4 flex gap-3"><button disabled={!!busy} className={button} type="submit">{editingCharacter ? 'Save character' : 'Add character'}</button>{editingCharacter && <button disabled={!!busy} className={secondaryButton} type="button" onClick={cancelCharacterEdit}>Cancel</button>}</div></form>}
      </div></section>
      <section className="border-[3px] border-[#171717] bg-[#fffef8] shadow-[4px_4px_0_#171717]"><div className="border-b-[3px] border-[#171717] bg-[#ffd83d] px-5 py-3"><h2 className="font-display font-normal uppercase">03 / The comic</h2></div><div className="p-5"><div className="flex flex-wrap items-center justify-between gap-4"><p>Plan the beats, then draw each page in order.</p><button disabled={!!busy} className={button} onClick={() => withSavedAnswers(() => action('Planning story','/story/plan'))}>Plan story →</button></div>
        <div className="mt-5 flex flex-wrap gap-5"><div><label htmlFor="panels-per-page" className="mb-1 block font-bold">Panels per page</label><select id="panels-per-page" className={field} disabled={!!busy || !!pages.length} value={comic.panelsPerPage ?? 3} onChange={event => action('Updating panel count','',{panelsPerPage:Number(event.target.value)},'PATCH')}><option value={2}>2 panels</option><option value={3}>3 panels</option><option value={4}>4 panels</option></select><p className="mt-1 text-sm">Choose before planning.</p></div><div><label htmlFor="page-layout" className="mb-1 block font-bold">Page layout</label><select id="page-layout" className={field} disabled={!!busy} value={comic.pageLayout ?? 'stack'} onChange={event => action('Updating page layout','',{pageLayout:event.target.value},'PATCH')}><option value="stack">Vertical stack</option><option value="grid">Two-column grid</option></select><p className="mt-1 text-sm">Applies to downloads and the next published edition.</p></div></div>
        {comic.storyboard && <section aria-label="Story beats" className="mt-5 border-2 border-[#171717] bg-white p-4"><h3 className="text-lg font-black">Review your story</h3><p className="mt-1 text-sm">Read the beats and dialogue before approving this story for drawing.</p><StoryBeats storyboard={comic.storyboard} characters={characters} /></section>}
        {comic.storyReview && <div className="mt-5 border-2 border-[#171717] bg-[#fff8e8] p-4"><h3 className="font-bold">Story review: {comic.storyReview.outcome}</h3>{comic.storyReview.findings?.map((finding,i) => <p key={i} className="mt-2 text-sm"><strong>{finding.dimension}:</strong> {finding.observed} {finding.expected && `Expected: ${finding.expected}`}</p>)}{comic.storyReview.accepted && <p className="mt-3 text-sm font-bold">You accepted this story review.</p>}{!comic.storyReview.accepted && comic.storyReview.outcome === 'findings' && comic.storyReview.fingerprint && comic.storyReview.findings.some(finding => finding.severity === 'blocker') && <button disabled={!!busy} className={`${secondaryButton} mt-3`} onClick={() => {if (window.confirm('The automated check flagged a possible story contradiction. Accept this story review and continue anyway?')) action('Accepting story review','/story/accept',{fingerprint:comic.storyReview!.fingerprint});}}>Accept story review and continue</button>}</div>}
        {comic.storyApproval && <div className="mt-4">{comic.storyApproval.approved ? <p className="font-bold">Story approved for drawing.</p> : <><p className="mb-3">Approve this story before drawing or changing artwork.</p><button disabled={!!busy} className={button} onClick={() => action('Approving story','/story/approve',{revision:comic.revision,storyRevision:comic.storyApproval!.storyRevision,fingerprint:comic.storyApproval!.fingerprint})}>Approve story</button></>}</div>}
        {comic.pendingRevision && (comic.pendingRevision.id === dismissedRevision ? <button className={`${secondaryButton} mt-4`} onClick={() => setDismissedRevision(null)}>Show story revision preview</button> : <section aria-label="Review story revision" className="mt-5 border-2 border-[#171717] bg-[#fff8e8] p-4"><h3 className="text-lg font-black">Review story revision</h3><p className="mt-2">This affects page {comic.pendingRevision.affectedPage}, panel {comic.pendingRevision.affectedPanel} onward, including later pages. Earlier panels stay unchanged.</p><p className="mt-2">{comic.pendingRevision.explanation}</p>{comic.pendingRevision.storyboard && <StoryBeats storyboard={comic.pendingRevision.storyboard} characters={characters} />}<p className="mt-3 text-sm">Applying approves the displayed revised story for drawing. Any new review blockers still need your decision.</p>{comic.pendingRevision.current ? <button disabled={!!busy} className={`${button} mt-3`} onClick={() => action('Revising story','/revisions',{proposalId:comic.pendingRevision!.id})}>Apply story change and regenerate</button> : <p className="mt-3 font-bold">The draft changed. Preview the story change again.</p>}<button disabled={!!busy} className={`${secondaryButton} ml-3 mt-3`} onClick={() => {setDismissedRevision(comic.pendingRevision!.id);setNotice('Revision not applied.');}}>Cancel</button></section>)}
        {!pages.length ? <div className="mt-5 border-2 border-dashed border-[#171717] bg-[#fff8e8] p-8 text-center"><h3 className="text-xl font-black uppercase">Your pages will appear here.</h3><p className="mt-2">Answer the questions and approve your characters to plan your story.</p></div> : <div className="mt-6 grid gap-5 lg:grid-cols-[110px_minmax(0,1fr)_260px]">
          <nav aria-label="Comic pages" className="flex gap-2 overflow-auto lg:flex-col">{pages.map((p,i) => <button key={p.id} onClick={() => {setSelectedPage(i);setSelectedPanel(0);}} aria-current={selectedPage===i ? 'page' : undefined} className={`min-h-11 min-w-20 border-2 border-[#171717] px-4 py-3 font-black ${selectedPage===i ? 'bg-[#ffd83d]' : 'bg-white'}`}>Page {p.index}</button>)}</nav>
          <div><div className="mb-3 flex flex-wrap items-center justify-between gap-3"><strong>PAGE {page?.index} · {page?.status}</strong>{page && <div className="flex flex-wrap gap-3"><button disabled={!!busy || !comic.storyApproval?.approved} className={secondaryButton} onClick={() => action('Drawing page',`/pages/${encodeURIComponent(page.id)}/generate`)}>{page.panels?.some(p => p.imageUrl) ? 'Regenerate page' : 'Generate page'}</button>{page.panels?.length > 0 && page.panels.every(p => p.imageUrl && (p.evaluation === 'pass' || p.accepted)) && <a className={secondaryButton} href={`${base}/pages/${encodeURIComponent(page.id)}/download`}>Download page</a>}</div>}</div><div className="space-y-3 border-[3px] border-[#171717] bg-white p-3">{page?.panels?.map((p,i) => <button key={p.id} onClick={() => setSelectedPanel(i)} aria-pressed={selectedPanel===i} className={`block min-h-36 w-full border-[3px] text-left ${selectedPanel===i ? 'border-[#ffd83d] outline-2 outline-[#171717]' : 'border-[#171717]'}`}>{p.imageUrl ? <img src={p.imageUrl} alt={`Page ${page.index}, panel ${i+1}`} className="h-auto w-full" /> : <span className="flex min-h-36 items-center justify-center bg-[#f4ead5] p-4 text-center font-bold">{p.description || `Panel ${i+1} — ${p.status || 'not drawn yet'}`}</span>}</button>)}</div>{page?.status === 'outdated' && <p className="mt-3 border-2 border-[#cf302b] p-3 font-bold">Story changed — this page needs updating.</p>}</div>
          <aside className="border-2 border-[#171717] p-4"><h3 className="border-b-2 border-[#171717] pb-2 text-lg font-black uppercase">Selected panel</h3>{panel ? <><p className="mt-3 text-sm">Panel {selectedPanel+1} · {panel.status || 'planned'}</p>{panel.evaluation && <div className="mt-3 border-2 border-[#171717] bg-[#fff8e8] p-3"><h4 className="font-bold">Check: {panel.status === 'checking' ? 'checking' : panel.evaluation}{panel.accepted ? ' · Accepted' : ''}</h4>{panel.imageUrl && panel.status !== 'checking' && <p className="mt-2 text-sm">{panel.reviewOutcome ? reviewMessages[panel.reviewOutcome] : 'Review result unavailable. Inspect the panel before accepting.'}</p>}{panel.findings?.map((finding,i) => <p key={i} className="mt-2 text-sm"><strong>{finding.dimension}:</strong> {finding.observed} {finding.expected && `Expected: ${finding.expected}`}</p>)}{!panel.accepted && panel.reviewVersion && panel.status === 'needs_review' && (panel.evaluation === 'warning' || panel.evaluation === 'uncertain' || panel.evaluation === 'blocker') && <button disabled={!!busy} className={`${secondaryButton} mt-3 w-full`} onClick={() => {if (panel.evaluation !== 'blocker' || window.confirm('The automated check flagged a possible contradiction. Accept this exact panel and continue anyway?')) action('Accepting panel',`/panels/${encodeURIComponent(panel.id)}/accept`,panel.reviewVersion);}}>Accept and continue</button>}</div>}<label htmlFor="art-edit" className="mb-1 mt-5 block text-sm font-bold">Edit artwork</label><textarea id="art-edit" value={artEdit} onChange={e => {setArtEdit(e.target.value); setEditDecision(null);}} rows={3} className={field} placeholder="Describe a visual change" /><button disabled={!!busy || !artEdit.trim() || !panel.reviewVersion} className={`${secondaryButton} mt-3 w-full`} onClick={() => panel.reviewVersion && editArtwork(panel.id,panel.reviewVersion)}>Regenerate panel</button>{activeEditDecision?.panelId === panel.id && <div className="mt-3 border-2 border-[#171717] bg-[#fff8e8] p-3" role="status"><p className="font-bold">{activeEditDecision.intent === 'story' ? 'This may change the story.' : 'Does this change the story?'}</p><p className="mt-1 text-sm">{activeEditDecision.reason}</p><button disabled={!!busy} className={`${button} mt-3 w-full`} onClick={() => reviseStory(activeEditDecision.panelId,activeEditDecision.instruction,activeEditDecision.reviewedVersion)}>Preview as story change</button>{activeEditDecision.intent === 'uncertain' && <button disabled={!!busy} className={`${secondaryButton} mt-3 w-full`} onClick={() => confirmArtworkChoice(activeEditDecision)}>Artwork only — story stays unchanged</button>}</div>}<label htmlFor="story-edit" className="mb-1 mt-6 block text-sm font-bold">Change the story</label><textarea id="story-edit" value={storyEdit} onChange={e => setStoryEdit(e.target.value)} rows={3} className={field} placeholder="Describe the plot change" /><p className="mt-2 text-sm">Review the affected range before applying the change.</p><button disabled={!!busy || !storyEdit.trim()} className={`${button} mt-3 w-full`} onClick={() => reviseStory(panel.id)}>Preview story change</button></> : <p className="mt-3 text-sm">Select a panel to edit it.</p>}</aside>
        </div>}
      </div></section>
      {comic.published && <div className="mt-8"><button className={secondaryButton} disabled={!!busy} onClick={() => {if (window.confirm('Withdraw this comic from the public gallery?')) action('Withdrawing','/unpublish');}}>Withdraw from gallery</button></div>}
      {showPublish && <PublishDialog onDismiss={() => setShowPublish(false)}><h2 id="publish-title" className="font-display text-3xl font-normal uppercase">Publish your comic</h2><p className="mt-3">This edition will be public. Later edits stay private until you republish.</p><form onSubmit={publish} className="mt-5 space-y-4">{error && <Message error>{error}</Message>}<div><label htmlFor="publish-name" className="mb-1 block font-bold">Title</label><input id="publish-name" value={publishTitle} required onChange={e => setPublishTitle(e.target.value)} className={field} /></div><div><label htmlFor="creator" className="mb-1 block font-bold">Creator display name (optional)</label><input id="creator" value={creator} onChange={e => setCreator(e.target.value)} placeholder="Anonymous" className={field} /></div><p className="text-sm">{pages.length} {pages.length===1?'page':'pages'} will be included. Only current, complete pages can be published.</p><div className="flex flex-wrap gap-3"><button type="button" className={secondaryButton} onClick={() => setShowPublish(false)}>Cancel</button><button disabled={!!busy} className={button} type="submit">{comic.published?'Republish':'Publish comic'}</button></div></form></PublishDialog>}
    </>}
  </main></ComicShell>;
}
