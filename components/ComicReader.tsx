'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ComicShell, Eyebrow, Message, button, secondaryButton } from './ComicShell';
import { errorMessage, request } from './api';
import type { PublicEdition } from './types';

function pageFromUrl(total: number) {
  if (!total) return 0;
  const value = Number(new URL(window.location.href).searchParams.get('page'));
  return Number.isInteger(value) && value > 0 ? Math.min(value, total) - 1 : 0;
}

export default function ComicReader({ id }: { id: string }) {
  const [comic, setComic] = useState<PublicEdition | null>(null);
  const [error, setError] = useState('');
  const [page, setPage] = useState(0);
  const [zoom, setZoom] = useState(false);
  const [linkStatus, setLinkStatus] = useState('');
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    request<{comic: PublicEdition}>(`/api/published/${encodeURIComponent(id)}`).then(data => {
      if (active) {setComic(data.comic);setPage(pageFromUrl(data.comic.pages.length));}
    }).catch(e => { if (active) setError(errorMessage(e)); });
    return () => {active = false;};
  }, [id]);
  const goToPage = useCallback((next: number) => {
    if (!comic?.pages.length) return;
    const target = Math.max(0, Math.min(comic.pages.length - 1, next));
    setPage(target);
    setZoom(false);
    const url = new URL(window.location.href);
    url.searchParams.set('page', String(target + 1));
    window.history.pushState(null, '', url);
    setLinkStatus('');
    document.getElementById('reader-controls')?.scrollIntoView({block:'start'});
  }, [comic]);
  useEffect(() => {
    if (!comic?.pages.length) return;
    const onPop = () => {setPage(pageFromUrl(comic.pages.length));setZoom(false);};
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName ?? '')) return;
      if (event.key === 'ArrowLeft' && page > 0) {event.preventDefault();goToPage(page - 1);}
      if (event.key === 'ArrowRight' && page < comic.pages.length - 1) {event.preventDefault();goToPage(page + 1);}
    };
    window.addEventListener('popstate', onPop);
    window.addEventListener('keydown', onKey);
    return () => {window.removeEventListener('popstate', onPop);window.removeEventListener('keydown', onKey);};
  }, [comic,goToPage,page]);
  async function copyLink() {
    try {await navigator.clipboard.writeText(window.location.href);setLinkStatus('Link copied.');}
    catch {setLinkStatus('Copy the URL from your browser.');}
  }
  const current = comic?.pages[page];
  return <ComicShell><main className="mx-auto max-w-[1000px] px-4 pt-8 sm:px-6 sm:pt-12">
    <Link href="/" className="font-bold underline decoration-2 underline-offset-4">← Back to comics</Link>
    {error ? <div className="mt-8"><Message error>This comic is unavailable. <Link href="/" className="font-bold underline">Return to the gallery</Link>.</Message></div> : !comic ? <div className="mt-8"><Message>Opening comic…</Message></div> : <>
      <div className="mt-8 flex flex-wrap items-end justify-between gap-5"><div><Eyebrow>Published comic</Eyebrow><h1 className="font-display mt-3 text-4xl font-normal uppercase leading-none sm:text-5xl">{comic.title}</h1><p className="mt-2">by {comic.creator || 'Anonymous'}</p></div><div><button onClick={copyLink} className={secondaryButton}>Copy link</button><span className="ml-3 text-sm" role="status">{linkStatus}</span></div></div>
      {current ? <>
        <nav id="reader-controls" aria-label="Page controls" className="mt-8 flex scroll-mt-4 flex-wrap items-center justify-between gap-3"><button className={secondaryButton} disabled={page===0} onClick={() => goToPage(page-1)}>← Previous</button><span className="text-center text-sm font-black sm:text-base" aria-live="polite">Page {page+1} of {comic.pages.length}</span><button className={button} disabled={page===comic.pages.length-1} onClick={() => goToPage(page+1)}>Next →</button></nav>
        <div className="mt-5 flex flex-wrap items-center gap-3"><button className={secondaryButton} aria-pressed={zoom} onClick={() => setZoom(value => !value)}>{zoom ? 'Fit page' : 'Zoom in to read'}</button><p className="text-sm">{zoom ? 'Scroll across the page to read it.' : 'Use the arrow keys to turn pages. Zoom in for smaller text.'}</p><a href={current.imageUrl} target="_blank" rel="noreferrer" className="font-bold underline">Open full-size page</a></div>
        {failedImageUrl === current.imageUrl && <div className="mt-6"><Message error>This edition may have changed or become unavailable. Reload to open the current edition.</Message></div>}
        <figure className="mt-5 overflow-x-auto border-[3px] border-[#171717] bg-white p-2 shadow-[6px_6px_0_#171717] sm:p-4" tabIndex={zoom ? 0 : undefined} aria-label={zoom ? 'Zoomed page, scroll horizontally to read' : undefined}><img key={current.id} src={current.imageUrl} alt={`Page ${page+1} of ${comic.title}`} onError={() => setFailedImageUrl(current.imageUrl)} onLoad={() => setFailedImageUrl(value => value === current.imageUrl ? null : value)} style={{width:zoom ? '250%' : '100%',maxWidth:'none'}} className="mx-auto block h-auto" /></figure>
        <a href="#reader-controls" className="mt-6 inline-block font-bold underline">Back to page controls ↑</a>
        {page === comic.pages.length-1 && <div className="mt-12 border-[3px] border-[#171717] bg-[#ffd83d] p-6 text-center"><h2 className="font-display text-3xl font-normal uppercase">The end. For now.</h2><p className="mt-2">Have a story of your own?</p><Link href="/create" className={`${secondaryButton} mt-5`}>Create a comic →</Link></div>}
      </> : <div className="mt-8"><Message>No pages are available for this comic.</Message></div>}
    </>}
  </main></ComicShell>;
}
