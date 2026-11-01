import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Operator-only recovery. Stop all processes and investigate the provider outcome first.
export function resolveTextOperation(path:string, comicId:string): void {
  if (!comicId || path === ':memory:' || !existsSync(path)) throw new Error('Supply a comic ID and an existing persistent draft database.');
  const db=new DatabaseSync(path);
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      const row=db.prepare('SELECT draft,revision,edition FROM comics WHERE id=?').get(comicId) as {draft:string;revision:number;edition:string|null}|undefined;
      if (!row) throw new Error('Comic not found.');
      if (!db.prepare('SELECT 1 FROM comic_text_operations WHERE comic_id=?').get(comicId)) throw new Error('No unresolved story operation found.');
      const draft=JSON.parse(row.draft) as {initialQuestions?:string;initialSuggestions?:string};
      const recoverQuestions = draft.initialQuestions === 'running' || draft.initialQuestions === 'unknown';
      const recoverSuggestions = draft.initialSuggestions === 'running' || draft.initialSuggestions === 'unknown';
      if (recoverQuestions || recoverSuggestions) {
        if (recoverQuestions) draft.initialQuestions='failed';
        if (recoverSuggestions) draft.initialSuggestions='failed';
        const edition=row.edition ? JSON.parse(row.edition) as {sourceRevision?:number} : null;
        if (edition?.sourceRevision === row.revision) edition.sourceRevision=row.revision+1;
        const changed=db.prepare('UPDATE comics SET draft=?,edition=?,revision=revision+1 WHERE id=? AND revision=?').run(JSON.stringify(draft),edition?JSON.stringify(edition):null,comicId,row.revision);
        if (Number(changed.changes)!==1) throw new Error('Draft changed during recovery.');
      }
      db.prepare('DELETE FROM comic_text_operations WHERE comic_id=?').run(comicId);
      db.exec('COMMIT');
    } catch(error) {db.exec('ROLLBACK');throw error;}
  } finally {db.close();}
}

if (import.meta.main) {
  const [comicId,confirm,...extra]=process.argv.slice(2);
  if (!comicId || confirm !== '--confirm' || extra.length) {console.error('Usage: bun scripts/resolve-text-operation.ts <comic-id> --confirm');process.exitCode=1;}
  else try {resolveTextOperation(process.env.COMEX_DB_PATH || resolve(process.cwd(),'data/comex.sqlite'),comicId);console.log('Story operation released. No provider call was refunded or retried.');}
  catch(error) {console.error(error instanceof Error ? error.message : 'Unable to resolve operation.');process.exitCode=1;}
}
