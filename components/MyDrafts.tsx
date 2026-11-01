'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ComicShell, Eyebrow, Message, button, secondaryButton } from './ComicShell';
import { errorMessage, request } from './api';
import type { DraftComic } from './types';

export default function MyDrafts() {
  const [comics, setComics] = useState<DraftComic[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { let active = true; request<{comics:DraftComic[]}>('/api/comics').then(data => {if(active) setComics(data.comics);}).catch(e => {if(active) setError(errorMessage(e));}); return () => {active=false;}; }, []);
  return <ComicShell><main className="mx-auto max-w-[1000px] px-4 pt-8 sm:px-6 sm:pt-12"><Link href="/" className="font-bold underline decoration-2 underline-offset-4">← Back to comics</Link><div className="mb-8 mt-8 flex flex-wrap items-end justify-between gap-4"><div><Eyebrow>Your creator’s desk</Eyebrow><h1 className="font-display mt-3 text-4xl font-normal uppercase sm:text-5xl">My drafts</h1><p className="mt-3 max-w-xl">Your browser’s drafts appear here. Browser sessions last 30 days.</p></div><Link href="/create" className={button}>Create a comic →</Link></div>
  {error ? <Message error>Couldn’t load drafts. {error} <Link className="font-bold underline" href="/sign-in">Sign in</Link></Message> : comics === null ? <Message>Loading your drafts…</Message> : comics.length === 0 ? <div className="border-[3px] border-[#171717] bg-[#fffef8] p-8 text-center"><h2 className="font-display text-2xl font-normal uppercase">A blank page awaits.</h2><p className="mt-2">You haven’t started a comic yet.</p><Link href="/create" className={`${button} mt-5`}>Create your first comic →</Link></div> : <div className="grid gap-5 sm:grid-cols-2">{comics.map(comic => <article key={comic.id} className="border-[3px] border-[#171717] bg-[#fffef8] p-5 shadow-[4px_4px_0_#171717]"><span className="border-2 border-[#171717] bg-[#ffd83d] px-2 py-1 text-xs font-black uppercase">{comic.published ? 'Published' : 'Private draft'}</span><h2 className="font-display mt-4 text-2xl font-normal">{comic.title}</h2><p className="mt-2 line-clamp-2 text-sm">{comic.plot}</p><Link href={`/comics/${encodeURIComponent(comic.id)}`} className={`${secondaryButton} mt-5`}>Open draft →</Link></article>)}</div>}
  </main></ComicShell>;
}
