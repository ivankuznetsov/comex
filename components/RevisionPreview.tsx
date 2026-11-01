'use client';

import {useEffect, useRef, type KeyboardEvent} from 'react';
import {button, secondaryButton, Message} from './ComicShell';

export type RevisionProposal = {
  id:string; affectedPage:number; affectedPanel:number; explanation:string; instruction?:string;
  panels:{id:string;page:number;panel:number;previousAction:string;action:string;dialogue:{speaker:string;text:string}[]}[];
};

export function RevisionPreview({proposal, busy, error, onDismiss, onApply}: {
  proposal:RevisionProposal; busy:boolean; error:string; onDismiss:()=>void; onApply:()=>void;
}) {
  const ref=useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog=ref.current;
    if (!dialog) return;
    const opener=document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    dialog.querySelector<HTMLButtonElement>('[data-revision-cancel]')?.focus();
    return () => {if (dialog.open) dialog.close(); if (opener?.isConnected) opener.focus();};
  }, []);
  function containTab(event:KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== 'Tab') return;
    const controls=Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])'));
    if (!controls.length) {event.preventDefault();return;}
    const first=controls[0],last=controls[controls.length-1];
    if (event.shiftKey && document.activeElement === first) {event.preventDefault();last.focus();}
    else if (!event.shiftKey && document.activeElement === last) {event.preventDefault();first.focus();}
  }
  return <dialog ref={ref} aria-labelledby="revision-preview-title" className="fixed inset-0 m-auto max-h-[calc(100vh-2rem)] w-[calc(100%-2rem)] max-w-2xl overflow-y-auto bg-transparent p-0 backdrop:bg-black/70"
    onCancel={event=>{event.preventDefault();if (!busy) onDismiss();}}
    onClick={event=>{if (event.target===event.currentTarget && !busy) onDismiss();}}
    onKeyDown={containTab}>
    <div className="border-[3px] border-[#171717] bg-[#fffef8] p-6 shadow-[6px_6px_0_#ffd83d]">
      <h2 id="revision-preview-title" className="font-display text-3xl font-normal uppercase">Review your story change</h2>
      <p className="mt-3">Changes start at page {proposal.affectedPage}, panel {proposal.affectedPanel}. Earlier panels stay unchanged.</p>
      <p className="mt-3">The affected part of the first page may be redrawn when you apply the change. Later pages remain outdated until you generate them.</p>
      <p className="mt-3">{proposal.explanation}</p>
      <h3 className="mt-5 font-black">Proposed panel beats</h3>
      <ol className="mt-3 space-y-3">{proposal.panels.map(panel=><li key={panel.id} className="border-2 border-[#171717] p-3">
        <h4 className="font-bold">Page {panel.page}, panel {panel.panel}</h4>
        <p className="mt-2 text-sm"><strong>Before:</strong> {panel.previousAction}</p>
        <p className="mt-2"><strong>After:</strong> {panel.action}</p>
        {panel.dialogue.length>0 && <ul className="mt-2 text-sm">{panel.dialogue.map((line,index)=><li key={index}><strong>{line.speaker}:</strong> {line.text}</li>)}</ul>}
      </li>)}</ol>
      {error && <div className="mt-4"><Message error>{error}</Message></div>}
      <p className="mt-4 text-sm">You can close this preview and return to it while the draft remains unchanged.</p><div className="mt-5 flex flex-wrap gap-3"><button data-revision-cancel type="button" className={secondaryButton} disabled={busy} onClick={onDismiss}>Close preview</button><button type="button" className={button} disabled={busy} onClick={onApply}>{busy?'Applying…':'Apply story change'}</button></div>
    </div>
  </dialog>;
}
