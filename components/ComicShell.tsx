import Link from 'next/link';
import type { ReactNode } from 'react';
import AuthMenu from './AuthMenu';

export const button = 'inline-flex min-h-11 items-center justify-center border-2 border-[#171717] bg-[#ffd83d] px-5 py-2 text-sm font-black text-[#171717] shadow-[4px_4px_0_#171717] transition-transform hover:translate-x-px hover:translate-y-px active:shadow-none focus-visible:outline-3 focus-visible:outline-offset-4 focus-visible:outline-[#1849a9] disabled:cursor-not-allowed disabled:opacity-50';
export const secondaryButton = `${button} bg-[#fffef8]`;
export const field = 'w-full border-2 border-[#171717] bg-[#fffef8] px-3 py-3 text-base text-[#171717] focus:outline-3 focus:outline-offset-2 focus:outline-[#1849a9]';

export function ComicShell({ children }: { children: ReactNode }) {
  return <div className="min-h-screen bg-[#fff8e8] text-[#171717]">
    <header className="border-b-[3px] border-[#171717] bg-[#ffd83d]">
      <div className="mx-auto flex min-h-20 max-w-[1200px] flex-wrap items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <Link href="/" aria-label="Comex home" className="comic-wordmark text-4xl sm:text-5xl">COMEX</Link>
        <nav aria-label="Main navigation" className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm font-bold sm:text-base">
          <Link href="/" className="underline-offset-4 hover:underline">Browse comics</Link>
          <Link href="/drafts" className="underline-offset-4 hover:underline">My drafts</Link>
          <AuthMenu />
          <Link href="/create" className={secondaryButton}>Create a comic <span aria-hidden="true" className="ml-2">→</span></Link>
        </nav>
      </div>
    </header>
    {children}
    <footer className="mt-16 border-t-[3px] border-[#171717] bg-[#ffd83d] py-6"><div className="mx-auto flex max-w-[1200px] flex-wrap justify-between gap-3 px-4 text-sm font-bold sm:px-6"><span>COMEX · STORIES MADE BY YOU</span><span>Made for the imagination.</span></div></footer>
  </div>;
}

export function Eyebrow({ children }: { children: ReactNode }) { return <span className="inline-block border-2 border-[#171717] bg-[#ffd83d] px-3 py-1 text-xs font-black uppercase tracking-[0.12em]">{children}</span>; }
export function Message({ children, error = false }: { children: ReactNode; error?: boolean }) { return <div role={error ? 'alert' : 'status'} className={`border-[3px] bg-[#fffef8] p-5 ${error ? 'border-[#cf302b]' : 'border-[#171717]'}`}>{children}</div>; }
