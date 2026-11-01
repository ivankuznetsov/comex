'use client';
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ComicShell, Eyebrow, Message, button, field } from './ComicShell';
import { errorMessage, request } from './api';
import { styles, type ComicStyle } from './types';

export default function StorySetup() {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [plot, setPlot] = useState('');
  const [style, setStyle] = useState<ComicStyle>('clear-line-adventure');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const {comic} = await request<{comic:{id:string}}>('/api/comics', {method:'POST',body:JSON.stringify({title:title.trim(),plot:plot.trim(),style})});
      router.push(`/comics/${encodeURIComponent(comic.id)}`);
    } catch (e) { setError(errorMessage(e)); setBusy(false); }
  }
  return <ComicShell><main className="mx-auto max-w-[1000px] px-4 pt-8 sm:px-6 sm:pt-12">
    <Link href="/" className="font-bold underline decoration-2 underline-offset-4">← Back to comics</Link>
    <div className="mt-8"><Eyebrow>Issue no. 01 · the beginning</Eyebrow><h1 className="font-display mt-4 text-5xl font-normal uppercase leading-none tracking-[0.02em] sm:text-6xl">Make it a comic.</h1><p className="mt-4 max-w-2xl text-lg leading-relaxed">Every great story starts somewhere. Pick a style, tell us your idea, and we’ll help you build the rest.</p></div>
    <form onSubmit={submit} className="mt-10 border-[3px] border-[#171717] bg-[#fffef8] shadow-[6px_6px_0_#171717]">
      <div className="border-b-[3px] border-[#171717] bg-[#ffd83d] px-5 py-3 font-black uppercase tracking-wide sm:px-8">01 / The idea</div>
      <div className="space-y-8 p-5 sm:p-8">
        <div><label htmlFor="title" className="mb-2 block text-lg font-black">Give your comic a title</label><input id="title" name="title" value={title} onChange={e => setTitle(e.target.value)} maxLength={100} required placeholder="The last delivery" className={field} /></div>
        <div><label htmlFor="plot" className="mb-2 block text-lg font-black">What happens in your story?</label><p className="mb-3 text-sm">A few sentences is plenty. Who is it about, and what do they want?</p><textarea id="plot" name="plot" value={plot} onChange={e => setPlot(e.target.value)} maxLength={3000} minLength={8} required rows={5} placeholder="A courier discovers a clockwork bird carrying a very important key…" className={field} /></div>
        <fieldset><legend className="mb-3 text-lg font-black">Choose the look</legend><div className="grid gap-4 md:grid-cols-3">{styles.map(item => <label key={item.id} className={`flex cursor-pointer flex-col border-[3px] p-4 transition-transform focus-within:outline-3 focus-within:outline-offset-4 focus-within:outline-[#1849a9] ${style === item.id ? 'border-[#171717] bg-[#ffd83d] shadow-[4px_4px_0_#171717]' : 'border-[#171717] bg-[#fffef8] hover:-translate-y-px'}`}><input type="radio" name="style" value={item.id} checked={style === item.id} onChange={() => setStyle(item.id)} className="sr-only" /><span aria-hidden="true" className="mb-4 flex h-16 items-center justify-center border-2 border-[#171717] text-xl font-black uppercase tracking-wider text-white" style={{backgroundColor:item.color}}>Comex!</span><span className="font-black">{item.name}</span><span className="mt-1 text-sm leading-relaxed">{item.description}</span><span className="mt-3 text-xs font-black uppercase">{style === item.id ? '● Selected' : '○ Select style'}</span></label>)}</div></fieldset>
        {error && <Message error>{error} <Link className="font-bold underline" href="/sign-in">Sign in</Link></Message>}
        <div className="flex flex-wrap items-center justify-between gap-5 border-t-2 border-[#171717] pt-6"><p className="max-w-sm text-sm">Sign in to create and save your drafts.</p><button disabled={busy} type="submit" className={button}>{busy ? 'Creating your draft…' : 'Start creating →'}</button></div>
      </div>
    </form>
  </main></ComicShell>;
}
