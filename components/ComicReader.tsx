'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ComicShell, Eyebrow, Message, button, secondaryButton } from './ComicShell';
import { errorMessage, request } from './api';
import type { PublicEdition } from './types';

export default function ComicReader({ id }: { id: string }) {
  const [comic, setComic] = useState<PublicEdition | null>(null);
  const [error, setError] = useState('');
  const [page, setPage] = useState(0);
  const [linkStatus, setLinkStatus] = useState('');
  const [imageError, setImageError] = useState(false);
  useEffect(() => { let active = true; request<{comic: PublicEdition}>(`/api/published/${encodeURIComponent(id)}`).then(data => { if (active) setComic(data.comic); }).catch(e => { if (active) setError(errorMessage(e)); }); return () => {active = false;}; }, [id]);
  async function copyLink() { try { await navigator.clipboard.writeText(window.location.href); setLinkStatus('Link copied.'); } catch { setLinkStatus('Copy the URL from your browser.'); } }
  return <ComicShell><main className="mx-auto max-w-[1000px] px-4 pt-8 sm:px-6 sm:pt-12">
    <Link href="/" className="font-bold underline decoration-2 underline-offset-4">← Back to comics</Link>
    {error ? <div className="mt-8"><Message error>This comic is unavailable. <Link href="/" className="font-bold underline">Return to the gallery</Link>.</Message></div> : !comic ? <div className="mt-8"><Message>Opening comic…</Message></div> : <>
      <div className="mt-8 flex flex-wrap items-end justify-between gap-5"><div><Eyebrow>Published comic</Eyebrow><h1 className="font-display mt-3 text-4xl font-normal uppercase leading-none sm:text-5xl">{comic.title}</h1><p className="mt-2">by {comic.creator || 'Anonymous'}</p></div><div><button onClick={copyLink} className={secondaryButton}>Copy link</button><span className="ml-3 text-sm" role="status">{linkStatus}</span></div></div>
      {comic.pages?.length ? <>{imageError && <div className="mt-6"><Message error>This edition may have changed or become unavailable. Reload to open the current edition.</Message></div>}<figure className="mt-8 border-[3px] border-[#171717] bg-white p-2 shadow-[6px_6px_0_#171717] sm:p-4"><a href={comic.pages[page].imageUrl} target="_blank" rel="noreferrer" aria-label="Open full-size page"><img key={comic.pages[page].id} src={comic.pages[page].imageUrl} alt={`Page ${page+1} of ${comic.title}`} onError={() => setImageError(true)} className="mx-auto block h-auto w-full" /></a></figure><div className="mt-8 flex items-center justify-between gap-3"><button className={secondaryButton} disabled={page===0} onClick={() => setPage(n => Math.max(0,n-1))}>← Previous</button><span className="text-center text-sm font-black sm:text-base" aria-live="polite">Page {page+1} of {comic.pages.length}</span><button className={button} disabled={page===comic.pages.length-1} onClick={() => setPage(n => Math.min(comic.pages.length-1,n+1))}>Next →</button></div>{page === comic.pages.length-1 && <div className="mt-12 border-[3px] border-[#171717] bg-[#ffd83d] p-6 text-center"><h2 className="font-display text-3xl font-normal uppercase">The end. For now.</h2><p className="mt-2">Have a story of your own?</p><Link href="/create" className={`${secondaryButton} mt-5`}>Create a comic →</Link></div>}</> : <div className="mt-8"><Message>No pages are available for this comic.</Message></div>}
    </>}
  </main></ComicShell>;
}
