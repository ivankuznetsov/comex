'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { PublishDialog } from './PublishDialog';
import { ComicShell, Eyebrow, Message, button, field, secondaryButton } from './ComicShell';
import { errorMessage, request } from './api';
import { styles, type DraftComic } from './types';

type DraftResponse = {comic?: DraftComic; questions?: DraftComic['questions']; jobId?: string; notice?: string};
export default function ComicEditor({ id }: { id: string }) {
  const base = `/api/comics/${encodeURIComponent(id)}`;
  const [comic, setComic] = useState<DraftComic | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [selectedPage, setSelectedPage] = useState(0);
  const [selectedPanel, setSelectedPanel] = useState(0);
  const [answers, setAnswers] = useState<Record<string,string>>({});
  const [character, setCharacter] = useState({name:'',role:'',appearance:'',outfit:''});
  const [editingCharacter, setEditingCharacter] = useState<string | null>(null);
  const [artEdit, setArtEdit] = useState('');
  const [storyEdit, setStoryEdit] = useState('');
  const [showPublish, setShowPublish] = useState(false);
  const [creator, setCreator] = useState('');
  const [publishTitle, setPublishTitle] = useState('');
  const refresh = useCallback(async () => {
    const data = await request<{comic:DraftComic}>(base);
    setComic(data.comic); setAnswers(data.comic.answers || {}); setPublishTitle(data.comic.publication?.title ?? data.comic.title); setCreator(data.comic.publication?.creator ?? '');
    return data.comic;
  }, [base]);
  useEffect(() => { let alive = true; request<{comic:DraftComic}>(base).then(data => { if (alive) { setComic(data.comic); setAnswers(data.comic.answers || {}); setPublishTitle(data.comic.publication?.title ?? data.comic.title); setCreator(data.comic.publication?.creator ?? ''); } }).catch(e => { if (alive) setError(errorMessage(e)); }); return () => {alive = false;}; }, [base]);
  async function action(label: string, path: string, body: unknown = {}, method = 'POST') {
    setBusy(label); setError(''); setNotice('');
    try {
      const data = await request<DraftResponse>(`${base}${path}`, {method,body:JSON.stringify(body)});
      if (data.notice) setNotice(data.notice);
      if (data.comic) { setComic(data.comic); if (data.comic.answers) setAnswers(data.comic.answers); }
      else if (data.questions) setComic(current => current ? {...current, questions:data.questions} : current);
      else if (data.jobId) { setNotice('Generation started. Refresh to check its status.'); await refresh(); }
      else await refresh();
      return true;
    } catch (e) { setError(errorMessage(e)); try { await refresh(); } catch { /* Keep the original error visible. */ } return false; }
    finally { setBusy(''); }
  }
  async function reviseStory(panelId: string) {
    setBusy('Preparing story revision'); setError(''); setNotice('');
    try {
      const {proposal} = await request<{proposal:{id:string;affectedPage:number;affectedPanel:number;explanation:string}}>(`${base}/revisions/preview`, {method:'POST',body:JSON.stringify({panelId,instruction:storyEdit})});
      const confirmed = window.confirm(`This change affects page ${proposal.affectedPage}, panel ${proposal.affectedPanel} onward, including all later pages. Earlier panels stay unchanged.\n\n${proposal.explanation}\n\nApply and regenerate the affected continuation?`);
      if (confirmed) await action('Revising story','/revisions',{proposalId:proposal.id});
      else setNotice('Revision not applied.');
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(''); }
  }
  async function addCharacter(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (await action('Adding character','/characters',character)) setCharacter({name:'',role:'',appearance:'',outfit:''}); }
  async function saveCharacter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (editingCharacter && await action('Saving character',`/characters/${encodeURIComponent(editingCharacter)}`,character,'PATCH')) {
      setEditingCharacter(null); setCharacter({name:'',role:'',appearance:'',outfit:''});
    }
  }
  function cancelCharacterEdit() { setEditingCharacter(null); setCharacter({name:'',role:'',appearance:'',outfit:''}); }
  async function saveAnswers() { if (await action('Saving answers','', {answers}, 'PATCH')) setNotice('Answers saved.'); }
  async function publish(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (await action('Publishing','/publish',{title:publishTitle,creator})) { setShowPublish(false); setNotice('Published! Your comic is now on the community shelf.'); } }
  const pages = comic?.pages || [];
  const characters = comic?.characters || [];
  const page = pages[Math.min(selectedPage,Math.max(0,pages.length-1))];
  const panel = page?.panels?.[Math.min(selectedPanel,Math.max(0,page.panels.length-1))];
  return <ComicShell><main className="mx-auto max-w-[1200px] px-4 pt-8 sm:px-6">
    <Link href="/" className="font-bold underline decoration-2 underline-offset-4">← Back to comics</Link>
    {!comic ? <div className="mt-8">{error ? <Message error>{error}</Message> : <Message>Opening your draft…</Message>}</div> : <>
      <div className="mb-8 mt-6 flex flex-wrap items-end justify-between gap-5"><div><Eyebrow>Creator’s desk</Eyebrow><h1 className="font-display mt-3 text-4xl font-normal uppercase leading-none sm:text-5xl">{comic.title}</h1><p className="mt-2 text-sm">{styles.find(s => s.id === comic.style)?.name || comic.style} · {comic.published ? 'Published' : 'Private draft'}{comic.unpublishedChanges ? ' · Unpublished changes' : ''}</p></div><div className="flex flex-wrap gap-3">{comic.published && <Link href={`/read/${encodeURIComponent(id)}`} className={secondaryButton}>View published</Link>}<button onClick={() => {setError(''); setShowPublish(true);}} className={button}>{comic.published ? 'Republish' : 'Publish'}</button></div></div>
      {error && !showPublish && <div className="mb-5"><Message error>{error}</Message></div>}{notice && <div className="mb-5"><Message>{notice}</Message></div>}{busy && <p className="mb-5 border-2 border-[#171717] bg-[#ffd83d] px-4 py-3 font-bold" role="status">{busy}…</p>}
      <section className="mb-8 border-[3px] border-[#171717] bg-[#fffef8] shadow-[4px_4px_0_#171717]"><div className="border-b-[3px] border-[#171717] bg-[#ffd83d] px-5 py-3"><h2 className="font-display font-normal uppercase">01 / Shape your story</h2></div><div className="p-5"><p className="max-w-3xl whitespace-pre-wrap leading-relaxed">{comic.plot}</p><div className="mt-5 flex flex-wrap gap-3"><button disabled={!!busy} className={secondaryButton} onClick={() => action('Finding questions','/questions')}>{comic.questions?.length ? 'Refresh questions' : 'Ask story questions'}</button></div>
      {!!comic.questions?.length && <div className="mt-6 space-y-5">{comic.questions.map(q => <div key={q.id}><label htmlFor={`q-${q.id}`} className="mb-2 block font-bold">{q.question}</label><input id={`q-${q.id}`} value={answers[q.id] || ''} placeholder={q.suggestedAnswer || 'Your answer'} onChange={e => setAnswers({...answers,[q.id]:e.target.value})} className={field} /></div>)}<button className={button} disabled={!!busy} onClick={saveAnswers}>Save answers</button></div>}</div></section>
      <section className="mb-8 border-[3px] border-[#171717] bg-[#fffef8] shadow-[4px_4px_0_#171717]"><div className="border-b-[3px] border-[#171717] bg-[#ffd83d] px-5 py-3"><h2 className="font-display font-normal uppercase">02 / Meet your characters</h2></div><div className="p-5"><p className="max-w-2xl">Create character cards and approve their reference images before planning pages.</p>
        {!!characters.length && <div className="mt-5 grid gap-4 md:grid-cols-2">{characters.map(c => <article key={c.id} className="border-2 border-[#171717] p-4">{c.referenceUrl && <img src={c.referenceUrl} alt={`Reference for ${c.name}`} className="mb-3 max-h-48 w-full border-2 border-[#171717] object-contain" />}<div className="flex items-start justify-between gap-3"><div><h3 className="text-xl font-black">{c.name}</h3><p className="text-sm">{c.role}</p></div><span className="border-2 border-[#171717] bg-[#ffd83d] px-2 py-1 text-xs font-bold">{c.approved ? 'Approved' : 'Needs approval'}</span></div><p className="mt-3 text-sm">{c.appearance}</p><p className="mt-1 text-sm"><strong>Outfit:</strong> {c.outfit}</p><div className="mt-4 flex flex-wrap gap-3"><button disabled={!!busy || !!pages.length} className={secondaryButton} onClick={() => action('Drawing reference',`/characters/${encodeURIComponent(c.id)}/reference`)}>{c.referenceUrl ? 'Regenerate reference' : 'Create reference'}</button>{c.referenceUrl && !c.approved && <button disabled={!!busy} className={button} onClick={() => action('Approving reference',`/characters/${encodeURIComponent(c.id)}/approve`)}>Approve</button>}{!pages.length && <><button disabled={!!busy} className={secondaryButton} onClick={() => {setEditingCharacter(c.id); setCharacter({name:c.name,role:c.role,appearance:c.appearance,outfit:c.outfit});}}>Edit card</button><button disabled={!!busy} className={secondaryButton} onClick={async () => {if (window.confirm(`Remove ${c.name} from this comic?`) && await action('Removing character',`/characters/${encodeURIComponent(c.id)}`,{},'DELETE') && editingCharacter === c.id) cancelCharacterEdit();}}>Remove</button></>}</div></article>)}</div>}
        {!pages.length && <form onSubmit={editingCharacter ? saveCharacter : addCharacter} className="mt-6 border-2 border-[#171717] bg-[#fff8e8] p-4"><h3 className="mb-4 text-lg font-black">{editingCharacter ? 'Edit character' : 'Add a character'}</h3>{editingCharacter && <p className="mb-4 text-sm">Changing a card clears its reference image and approval so you can create a matching reference.</p>}<div className="grid gap-4 sm:grid-cols-2">{(['name','role','appearance','outfit'] as const).map(key => <div key={key}><label className="mb-1 block text-sm font-bold capitalize" htmlFor={`character-${key}`}>{key}</label><input id={`character-${key}`} required value={character[key]} onChange={e => setCharacter({...character,[key]:e.target.value})} className={field} /></div>)}</div><div className="mt-4 flex gap-3"><button disabled={!!busy} className={button} type="submit">{editingCharacter ? 'Save character' : 'Add character'}</button>{editingCharacter && <button disabled={!!busy} className={secondaryButton} type="button" onClick={cancelCharacterEdit}>Cancel</button>}</div></form>}
      </div></section>
      <section className="border-[3px] border-[#171717] bg-[#fffef8] shadow-[4px_4px_0_#171717]"><div className="border-b-[3px] border-[#171717] bg-[#ffd83d] px-5 py-3"><h2 className="font-display font-normal uppercase">03 / The comic</h2></div><div className="p-5"><div className="flex flex-wrap items-center justify-between gap-4"><p>Plan the beats, then draw each page in order.</p><button disabled={!!busy} className={button} onClick={() => action('Planning story','/story/plan')}>Plan story →</button></div>
        {comic.storyReview && <div className="mt-5 border-2 border-[#171717] bg-[#fff8e8] p-4"><h3 className="font-bold">Story review: {comic.storyReview.outcome}</h3>{comic.storyReview.findings?.map((finding,i) => <p key={i} className="mt-2 text-sm"><strong>{finding.dimension}:</strong> {finding.observed} {finding.expected && `Expected: ${finding.expected}`}</p>)}</div>}
        {!pages.length ? <div className="mt-5 border-2 border-dashed border-[#171717] bg-[#fff8e8] p-8 text-center"><h3 className="text-xl font-black uppercase">Your pages will appear here.</h3><p className="mt-2">Answer the questions and approve your characters to plan your story.</p></div> : <div className="mt-6 grid gap-5 lg:grid-cols-[110px_minmax(0,1fr)_260px]">
          <nav aria-label="Comic pages" className="flex gap-2 overflow-auto lg:flex-col">{pages.map((p,i) => <button key={p.id} onClick={() => {setSelectedPage(i);setSelectedPanel(0);}} aria-current={selectedPage===i ? 'page' : undefined} className={`min-h-11 min-w-20 border-2 border-[#171717] px-4 py-3 font-black ${selectedPage===i ? 'bg-[#ffd83d]' : 'bg-white'}`}>Page {p.index}</button>)}</nav>
          <div><div className="mb-3 flex flex-wrap items-center justify-between gap-3"><strong>PAGE {page?.index} · {page?.status}</strong>{page && <div className="flex flex-wrap gap-3"><button disabled={!!busy} className={secondaryButton} onClick={() => action('Drawing page',`/pages/${encodeURIComponent(page.id)}/generate`)}>{page.panels?.some(p => p.imageUrl) ? 'Regenerate page' : 'Generate page'}</button>{page.panels?.length > 0 && page.panels.every(p => p.imageUrl && (p.evaluation === 'pass' || p.accepted)) && <a className={secondaryButton} href={`${base}/pages/${encodeURIComponent(page.id)}/download`}>Download page</a>}</div>}</div><div className="space-y-3 border-[3px] border-[#171717] bg-white p-3">{page?.panels?.map((p,i) => <button key={p.id} onClick={() => setSelectedPanel(i)} aria-pressed={selectedPanel===i} className={`block min-h-36 w-full border-[3px] text-left ${selectedPanel===i ? 'border-[#ffd83d] outline-2 outline-[#171717]' : 'border-[#171717]'}`}>{p.imageUrl ? <img src={p.imageUrl} alt={`Page ${page.index}, panel ${i+1}`} className="h-auto w-full" /> : <span className="flex min-h-36 items-center justify-center bg-[#f4ead5] p-4 text-center font-bold">{p.description || `Panel ${i+1} — ${p.status || 'not drawn yet'}`}</span>}</button>)}</div>{page?.status === 'outdated' && <p className="mt-3 border-2 border-[#cf302b] p-3 font-bold">Story changed — this page needs updating.</p>}</div>
          <aside className="border-2 border-[#171717] p-4"><h3 className="border-b-2 border-[#171717] pb-2 text-lg font-black uppercase">Selected panel</h3>{panel ? <><p className="mt-3 text-sm">Panel {selectedPanel+1} · {panel.status || 'planned'}</p>{panel.evaluation && <div className="mt-3 border-2 border-[#171717] bg-[#fff8e8] p-3"><h4 className="font-bold">Check: {panel.status === 'checking' ? 'checking' : panel.evaluation}{panel.accepted ? ' · Accepted' : ''}</h4>{panel.findings?.map((finding,i) => <p key={i} className="mt-2 text-sm"><strong>{finding.dimension}:</strong> {finding.observed} {finding.expected && `Expected: ${finding.expected}`}</p>)}{!panel.accepted && panel.status === 'needs_review' && (panel.evaluation === 'warning' || panel.evaluation === 'uncertain' || panel.evaluation === 'blocker') && <button disabled={!!busy} className={`${secondaryButton} mt-3 w-full`} onClick={() => {if (panel.evaluation !== 'blocker' || window.confirm('The automated check flagged a possible contradiction. Accept this exact panel and continue anyway?')) action('Accepting panel',`/panels/${encodeURIComponent(panel.id)}/accept`);}}>Accept and continue</button>}</div>}<label htmlFor="art-edit" className="mb-1 mt-5 block text-sm font-bold">Edit artwork</label><textarea id="art-edit" value={artEdit} onChange={e => setArtEdit(e.target.value)} rows={3} className={field} placeholder="Describe a visual change" /><button disabled={!!busy || !artEdit.trim()} className={`${secondaryButton} mt-3 w-full`} onClick={() => action('Editing panel',`/panels/${encodeURIComponent(panel.id)}/edit`,{instruction:artEdit})}>Regenerate panel</button><label htmlFor="story-edit" className="mb-1 mt-6 block text-sm font-bold">Change the story</label><textarea id="story-edit" value={storyEdit} onChange={e => setStoryEdit(e.target.value)} rows={3} className={field} placeholder="Describe the plot change" /><p className="mt-2 text-sm">Review the affected range before applying the change.</p><button disabled={!!busy || !storyEdit.trim()} className={`${button} mt-3 w-full`} onClick={() => reviseStory(panel.id)}>Preview story change</button></> : <p className="mt-3 text-sm">Select a panel to edit it.</p>}</aside>
        </div>}
      </div></section>
      {comic.published && <div className="mt-8"><button className={secondaryButton} disabled={!!busy} onClick={() => {if (window.confirm('Withdraw this comic from the public gallery?')) action('Withdrawing','/unpublish');}}>Withdraw from gallery</button></div>}
      {showPublish && <PublishDialog onDismiss={() => setShowPublish(false)}><h2 id="publish-title" className="font-display text-3xl font-normal uppercase">Publish your comic</h2><p className="mt-3">This edition will be public. Later edits stay private until you republish.</p><form onSubmit={publish} className="mt-5 space-y-4">{error && <Message error>{error}</Message>}<div><label htmlFor="publish-name" className="mb-1 block font-bold">Title</label><input id="publish-name" value={publishTitle} required onChange={e => setPublishTitle(e.target.value)} className={field} /></div><div><label htmlFor="creator" className="mb-1 block font-bold">Creator display name (optional)</label><input id="creator" value={creator} onChange={e => setCreator(e.target.value)} placeholder="Anonymous" className={field} /></div><p className="text-sm">{pages.length} {pages.length===1?'page':'pages'} will be included. Only current, complete pages can be published.</p><div className="flex flex-wrap gap-3"><button type="button" className={secondaryButton} onClick={() => setShowPublish(false)}>Cancel</button><button disabled={!!busy} className={button} type="submit">{comic.published?'Republish':'Publish comic'}</button></div></form></PublishDialog>}
    </>}
  </main></ComicShell>;
}
