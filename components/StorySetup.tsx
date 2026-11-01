'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ComicShell, Eyebrow, Message, button, field, secondaryButton } from './ComicShell';
import { activateHostedWorkspace, associateHostedOperation, errorMessage, forgetHostedOperation, hostedCreateKey, hostedGuestFence, hostedSession, hostedWorkspaceFence, pendingHostedOperations, recoverHostedOperation, request, startHostedOperation, subscribeHostedWorkspace, waitForHostedOperation, type HostedOperationInput, type SavedHostedOperation } from './api';
import { styles, type ComicStyle } from './types';

export default function StorySetup({hosted=false}:{hosted?:boolean}) {
  const router = useRouter();
  const [hasIdentity, setHasIdentity] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);
  const [workspaceId,setWorkspaceId]=useState<string|null>(null);
  const workspaceRef=useRef<string|null>(null);
  const bindingGuest=useRef(false);
  useEffect(() => {let alive=true;const session=hosted ? hostedSession() : request<{user:{email:string}|null;guest?:{email:string}|null}>('/api/auth/session');session.then(data => {if(!alive)return;setHasIdentity(!!(data.user?.email || data.guest?.email));if(hosted && 'workspaceId' in data){const workspace=typeof data.workspaceId==='string' ? data.workspaceId : null;workspaceRef.current=workspace;setWorkspaceId(workspace);}setSessionReady(true);}).catch(e => {if(alive)setError(errorMessage(e));});return ()=>{alive=false;};}, [hosted]);
  const [email,setEmail]=useState('');
  const [title, setTitle] = useState('');
  const [plot, setPlot] = useState('');
  const [style, setStyle] = useState<ComicStyle>('clear-line-adventure');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pendingCreation,setPendingCreation]=useState<SavedHostedOperation | null>(null);
  const createPoll=useRef<AbortController | null>(null);
  useEffect(() => () => createPoll.current?.abort(),[]);
  useEffect(()=>{if(!hosted)return;return subscribeHostedWorkspace(()=>{if(bindingGuest.current)return;workspaceRef.current=null;createPoll.current?.abort();sessionStorage.removeItem(hostedCreateKey);setEmail('');setTitle('');setPlot('');setPendingCreation(null);setSessionReady(false);setBusy(false);setError('Your workspace changed. Refresh before continuing.');});},[hosted]);
  async function finishCreation(entry:SavedHostedOperation,signal?:AbortSignal,reentered?:HostedOperationInput) {
    const started=entry.id ? entry : entry.redacted ? await recoverHostedOperation(entry,reentered) : await startHostedOperation(entry,entry.requestKey);
    const operation=await waitForHostedOperation(started,undefined,signal);
    if(operation.status==='unknown_outcome') {setPendingCreation(pendingHostedOperations().find(item=>item.requestKey===entry.requestKey) ?? entry);throw new Error('The draft request could not be confirmed. Check its existing operation before trying again.');}
    if(operation.status!=='succeeded' && operation.status!=='needs_review')throw new Error('Draft creation did not complete. You can try again.');
    const result=operation.result as {comic?:{id?:string};comicId?:string}|null|undefined;
    const id=operation.comicId ?? result?.comic?.id ?? result?.comicId;
    if(!id)throw new Error('The completed draft request did not return a comic ID.');
    associateHostedOperation(started,id);
    router.push(`/comics/${encodeURIComponent(id)}`);
  }
  useEffect(() => {
    if(!hosted || !sessionReady || !workspaceId)return;
    const key=sessionStorage.getItem(hostedCreateKey);
    const entry=key ? pendingHostedOperations().find(item=>item.requestKey===key && item.action==='create') : undefined;
    if(!entry) {
      const previous=pendingHostedOperations().find(item=>item.action==='create' && !['failed','obsolete','revoked'].includes(item.status ?? ''));
      if(previous){setPendingCreation(previous);setError('A previous draft request is available. Check it to continue that draft.');}
      return;
    }
    setPendingCreation(entry);
    if(typeof entry.input.title==='string')setTitle(entry.input.title);
    if(typeof entry.input.plot==='string')setPlot(entry.input.plot);
    if(styles.some(item=>item.id===entry.input.style))setStyle(entry.input.style as ComicStyle);
    const controller=new AbortController();createPoll.current=controller;setBusy(true);
    finishCreation(entry,controller.signal).catch(e=>{if(!controller.signal.aborted)setError(errorMessage(e));}).finally(()=>{if(!controller.signal.aborted)setBusy(false);});
    return () => controller.abort();
  // Restore the request that belongs to this browser tab only on entry.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[hosted,sessionReady,workspaceId]);
  async function checkCreation() {
    if(!pendingCreation)return;
    sessionStorage.setItem(hostedCreateKey,pendingCreation.requestKey);
    setBusy(true);setError('');const controller=new AbortController();createPoll.current=controller;
    try {await finishCreation(pendingCreation,controller.signal);} catch(e) {if(!controller.signal.aborted)setError(errorMessage(e));} finally {if(!controller.signal.aborted)setBusy(false);}
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      if(hosted) {
        const previousKey=sessionStorage.getItem(hostedCreateKey);
        const previous=(previousKey ? pendingHostedOperations().find(item=>item.requestKey===previousKey && item.action==='create') : undefined) ?? pendingCreation ?? undefined;
        if(previous && previous.status==='unknown_outcome')throw new Error('The previous draft request has an unknown outcome. Check it before starting another.');
        if(previous && !['failed','obsolete','revoked'].includes(previous.status ?? '')) {sessionStorage.setItem(hostedCreateKey,previous.requestKey);const controller=new AbortController();createPoll.current=controller;await finishCreation(previous,controller.signal,{action:'create',input:{title:title.trim(),plot:plot.trim(),style}});return;}
        if(previous)forgetHostedOperation(previous);
        if(!hasIdentity) {const fence=workspaceRef.current ? hostedWorkspaceFence() : hostedGuestFence();const guest=await request<{workspaceId:string}>('/api/auth/guest',{method:'POST',body:JSON.stringify({email:email.trim()})});fence();if(!guest.workspaceId)throw new Error('Could not start your workspace.');bindingGuest.current=true;try {activateHostedWorkspace(guest.workspaceId);} finally {bindingGuest.current=false;}workspaceRef.current=guest.workspaceId;setHasIdentity(true);}
        if(!workspaceRef.current)throw new Error('Your workspace changed. Refresh before continuing.');
        const key=crypto.randomUUID();sessionStorage.setItem(hostedCreateKey,key);
        const entry=await startHostedOperation({action:'create',input:{title:title.trim(),plot:plot.trim(),style}},key,workspaceRef.current);
        const controller=new AbortController();createPoll.current=controller;await finishCreation(entry,controller.signal);return;
      }
      const {comic} = await request<{comic:{id:string}}>('/api/comics', {method:'POST',body:JSON.stringify({title:title.trim(),plot:plot.trim(),style,...(!hasIdentity?{email:email.trim()}: {})})});
      router.push(`/comics/${encodeURIComponent(comic.id)}`);
    } catch (e) { if(!(e instanceof DOMException && e.name==='AbortError')) {if(hosted){const key=sessionStorage.getItem(hostedCreateKey);setPendingCreation(key ? pendingHostedOperations().find(item=>item.requestKey===key) ?? null : null);}setError(errorMessage(e)); setBusy(false);} }
  }
  return <ComicShell><main className="mx-auto max-w-[1000px] px-4 pt-8 sm:px-6 sm:pt-12">
    <Link href="/" className="font-bold underline decoration-2 underline-offset-4">← Back to comics</Link>
    <div className="mt-8"><Eyebrow>Issue no. 01 · the beginning</Eyebrow><h1 className="font-display mt-4 text-5xl font-normal uppercase leading-none tracking-[0.02em] sm:text-6xl">Make it a comic.</h1><p className="mt-4 max-w-2xl text-lg leading-relaxed">Every great story starts somewhere. Pick a style, tell us your idea, and we’ll help you build the rest.</p></div>
    <form onSubmit={submit} className="mt-10 border-[3px] border-[#171717] bg-[#fffef8] shadow-[6px_6px_0_#171717]">
      <div className="border-b-[3px] border-[#171717] bg-[#ffd83d] px-5 py-3 font-black uppercase tracking-wide sm:px-8">01 / The idea</div>
      <div className="space-y-8 p-5 sm:p-8">
        {sessionReady && !hasIdentity && <div><label htmlFor="email" className="mb-2 block text-lg font-black">Your email address</label><input id="email" name="email" type="email" autoComplete="email" value={email} onChange={e=>setEmail(e.target.value)} maxLength={254} required className={field} /><p className="mt-2 text-sm">Start creating now. Verify this email to save drafts to your account.</p></div>}
        <div><label htmlFor="title" className="mb-2 block text-lg font-black">Give your comic a title</label><input id="title" name="title" value={title} onChange={e => setTitle(e.target.value)} maxLength={100} required placeholder="The last delivery" className={field} /></div>
        <div><label htmlFor="plot" className="mb-2 block text-lg font-black">What happens in your story?</label><p className="mb-3 text-sm">A few sentences is plenty. Who is it about, and what do they want?</p><textarea id="plot" name="plot" value={plot} onChange={e => setPlot(e.target.value)} maxLength={3000} minLength={8} required rows={5} placeholder="A courier discovers a clockwork bird carrying a very important key…" className={field} /></div>
<fieldset><legend className="mb-3 text-lg font-black">Choose the look</legend><p className="mb-4 text-sm">Example artwork for each style; your comic will have its own characters and scenes.</p><div className="grid gap-4 md:grid-cols-3">{styles.map(item => <label key={item.id} className={`flex cursor-pointer flex-col border-[3px] p-4 transition-transform focus-within:outline-3 focus-within:outline-offset-4 focus-within:outline-[#1849a9] ${style === item.id ? 'border-[#171717] bg-[#ffd83d] shadow-[4px_4px_0_#171717]' : 'border-[#171717] bg-[#fffef8] hover:-translate-y-px'}`}><input type="radio" name="style" value={item.id} checked={style === item.id} onChange={() => setStyle(item.id)} className="sr-only" /><img src={item.image} alt="" aria-hidden="true" width={640} height={480} className="mb-4 aspect-[4/3] w-full border-2 border-[#171717] object-cover" /><span className="font-black">{item.name}</span><span className="mt-1 text-sm leading-relaxed">{item.description}</span><span className="mt-3 text-xs font-black uppercase">{style === item.id ? '● Selected' : '○ Select style'}</span></label>)}</div></fieldset>
        {error && <Message error>{error}{hosted && pendingCreation && !['failed','obsolete','revoked'].includes(pendingCreation.status ?? '') && <button type="button" disabled={busy} className={`${secondaryButton} mt-3`} onClick={checkCreation}>Check draft request</button>}</Message>}
        <div className="flex flex-wrap items-center justify-between gap-5 border-t-2 border-[#171717] pt-6"><p className="max-w-sm text-sm">Your draft is saved in this browser for 30 days. Starting also uses AI calls to suggest questions and characters.</p><button disabled={busy || !sessionReady} type="submit" className={button}>{busy ? 'Creating your draft…' : 'Start creating →'}</button></div>
      </div>
    </form>
  </main></ComicShell>;
}
