'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ComicShell, Eyebrow, Message, button } from './ComicShell';
import { errorMessage, request } from './api';
import type { PublicComic } from './types';

export default function ComicGallery() {
  const [comics, setComics] = useState<PublicComic[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { let active = true; request<{comics: PublicComic[]}>('/api/published').then(data => { if (active) setComics(data.comics); }).catch(e => { if (active) setError(errorMessage(e)); }); return () => { active = false; }; }, []);
  return <ComicShell>
    <main className="mx-auto max-w-[1200px] px-4 pt-7 sm:px-6 sm:pt-10">
      <section className="relative overflow-hidden border-[3px] border-[#171717] bg-[#1849a9] px-6 py-10 text-white shadow-[6px_6px_0_#171717] sm:px-10 sm:py-14">
        <div className="pointer-events-none absolute inset-y-0 right-0 w-1/3 opacity-20" aria-hidden="true" style={{backgroundImage:'radial-gradient(#fff 1.5px, transparent 1.5px)',backgroundSize:'10px 10px'}} />
        <div className="relative max-w-3xl"><span className="inline-block border-2 border-[#171717] bg-[#ffd83d] px-3 py-1 text-xs font-black uppercase tracking-[0.12em] text-[#171717]">Your story starts here</span>
          <h1 className="font-display mt-5 max-w-[700px] text-5xl font-normal uppercase leading-[0.95] tracking-[0.02em] sm:text-7xl">Your next great adventure.</h1>
          <p className="mt-5 max-w-xl text-lg leading-relaxed text-white">Original comics, made by people with a story to tell. Pick an issue and jump in—or make your own.</p>
          <Link href="/create" className={`${button} mt-7`}>Create a comic <span aria-hidden="true" className="ml-2">→</span></Link>
        </div>
      </section>
      <section aria-labelledby="gallery-title" className="mt-14">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3 border-b-[3px] border-[#171717] pb-4"><div><Eyebrow>The community shelf</Eyebrow><h2 id="gallery-title" className="font-display mt-3 text-3xl font-normal uppercase tracking-[0.02em] sm:text-4xl">Fresh off the press</h2></div><p className="text-sm font-bold">Published comics · free to read</p></div>
        {error ? <Message error>Couldn’t load the gallery. {error}</Message> : comics === null ? <Message>Loading the comic shelf…</Message> : comics.length === 0 ? <div className="border-[3px] border-[#171717] bg-[#fffef8] px-6 py-12 text-center shadow-[5px_5px_0_#171717]"><span className="text-4xl" aria-hidden="true">✦</span><h3 className="mt-3 text-2xl font-black uppercase">The first issue is yours to make.</h3><p className="mx-auto mt-2 max-w-md text-base leading-relaxed">There aren’t any published comics yet. Start with an idea and make the first one.</p><Link href="/create" className={`${button} mt-6`}>Create a comic →</Link></div> : <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">{comics.map(comic => <article key={comic.id} className="flex flex-col border-[3px] border-[#171717] bg-[#fffef8] p-3 shadow-[5px_5px_0_#171717]">
          <Link href={`/read/${encodeURIComponent(comic.id)}`} className="group relative flex aspect-[4/3] items-center justify-center overflow-hidden border-[3px] border-[#171717] bg-[#1849a9] text-white">{comic.coverUrl ? <img src={comic.coverUrl} alt={`Cover of ${comic.title}`} className="h-full w-full object-cover" /> : <><span aria-hidden="true" className="absolute inset-0 opacity-20" style={{backgroundImage:'radial-gradient(#fff 1.5px,transparent 1.5px)',backgroundSize:'10px 10px'}} /><span className="relative p-5 text-center text-3xl font-black uppercase">{comic.title}</span></>}</Link>
          <div className="flex flex-1 flex-col px-1 pb-1 pt-4"><h3 className="text-xl font-black">{comic.title}</h3><p className="mt-1 text-sm">by {comic.creator || 'Anonymous'} · {comic.pageCount} {comic.pageCount === 1 ? 'page' : 'pages'}</p><Link href={`/read/${encodeURIComponent(comic.id)}`} className="mt-5 self-end font-black underline decoration-2 underline-offset-4">Read comic →</Link></div>
        </article>)}</div>}
      </section>
    </main>
  </ComicShell>;
}
