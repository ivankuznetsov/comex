import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ComicDraft } from '../src/lib/domain/comic';

type StoredDraft = ComicDraft & {
  panelFindings?:Record<string,unknown[]>;
  panelReviews?:Record<string,{assetId:string;storyRevision:number;panelRevision:number;outcome:'failed'}>;
};

// Operator-only recovery. Stop all Comex processes and reconcile any provider reservation first.
export function resolveVisualReview(path:string,comicId:string,panelId:string):void {
  if (!comicId || !panelId || /[\x00-\x1f\x7f]/.test(panelId)) throw new Error('Supply a comic ID and exact panel ID.');
  if (path === ':memory:' || !existsSync(path)) throw new Error('A persistent existing draft database is required.');
  const db = new DatabaseSync(path);
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = db.prepare('SELECT draft,revision FROM comics WHERE id=?').get(comicId) as {draft:string;revision:number} | undefined;
      if (!row) throw new Error('Comic not found.');
      const draft = JSON.parse(row.draft) as StoredDraft;
      const matches = draft.pages.flatMap(page => page.panels).filter(panel => panel.id === panelId);
      if (matches.length !== 1) throw new Error('Panel not found or ambiguous.');
      const panel = matches[0];
      if (panel.status !== 'checking' || !panel.assetId || panel.storyRevision !== draft.storyRevision) throw new Error('The selected panel is not awaiting review for the current story.');
      panel.status = 'needs_review'; panel.evaluation = 'uncertain'; panel.acceptance = null;
      draft.panelFindings = {...draft.panelFindings,[panelId]:[]};
      draft.panelReviews = {...draft.panelReviews,[panelId]:{assetId:panel.assetId,storyRevision:panel.storyRevision,panelRevision:panel.revision,outcome:'failed'}};
      const changed = db.prepare('UPDATE comics SET draft=?,revision=revision+1 WHERE id=? AND revision=?').run(JSON.stringify(draft),comicId,row.revision);
      if (Number(changed.changes) !== 1) throw new Error('Draft changed during recovery.');
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally { db.close(); }
}

if (import.meta.main) {
  const [comicId,panelId,confirmation,...extra] = process.argv.slice(2);
  const path=process.env.COMEX_DB_PATH || resolve(process.cwd(),'data/comex.sqlite');
  if (comicId && panelId === '--list' && !confirmation && !extra.length) {
    try {
      if (!existsSync(path)) throw new Error('Draft database not found.');
      const db = new DatabaseSync(path,{readOnly:true});
      try {
        const row=db.prepare('SELECT draft FROM comics WHERE id=?').get(comicId) as {draft:string} | undefined;
        if (!row) throw new Error('Comic not found.');
        const draft=JSON.parse(row.draft) as StoredDraft;
        console.log(draft.pages.flatMap(page => page.panels).filter(panel => panel.status === 'checking').map(panel => panel.id));
      } finally {db.close();}
    } catch (error) { console.error(error instanceof Error ? error.message : 'Unable to list reviews.'); process.exitCode = 1; }
  } else if (!comicId || !panelId || confirmation !== '--confirm' || extra.length) {
    console.error('Usage: bun scripts/resolve-visual-review.ts <comic-id> --list | <comic-id> <panel-id> --confirm'); process.exitCode = 1;
  } else {
    try {
      resolveVisualReview(path,comicId,panelId);
      console.log('Review marked incomplete. Inspect and accept the saved panel; no provider call was refunded or retried.');
    } catch (error) { console.error(error instanceof Error ? error.message : 'Unable to resolve review.'); process.exitCode = 1; }
  }
}
