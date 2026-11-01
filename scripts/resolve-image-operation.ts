import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

// Operator-only recovery. Stop all processes and investigate the provider outcome first.
export function resolveImageOperation(path: string, comicId: string, operation: string): void {
  if (!comicId || !/^(panel|character):[^\x00-\x1f\x7f]{1,300}$/.test(operation)) throw new Error('Supply a comic ID and exact panel:<id> or character:<id> operation.');
  if (path === ':memory:' || !existsSync(path)) throw new Error('A persistent existing draft database is required.');
  const db = new DatabaseSync(path);
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = db.prepare('SELECT draft,revision FROM comics WHERE id=?').get(comicId) as {draft:string;revision:number} | undefined;
      if (!row) throw new Error('Comic not found.');
      const draft = JSON.parse(row.draft) as {operations?:Record<string,string>};
      if (!['running','unknown_outcome'].includes(draft.operations?.[operation] ?? '')) throw new Error('No matching unresolved image operation.');
      delete draft.operations![operation];
      const changed=db.prepare('UPDATE comics SET draft=?,revision=revision+1 WHERE id=? AND revision=?').run(JSON.stringify(draft),comicId,row.revision);
      if (Number(changed.changes)!==1) throw new Error('Draft changed during recovery.');
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally { db.close(); }
}

if (import.meta.main) {
  const [comicId, operation, confirmation, ...extra] = process.argv.slice(2);
  const path=process.env.COMEX_DB_PATH || resolve(process.cwd(),'data/comex.sqlite');
  if (comicId && operation === '--list' && !confirmation && !extra.length) {
    try {
      if (!existsSync(path)) throw new Error('Draft database not found.');
      const db=new DatabaseSync(path,{readOnly:true});
      try {
        const row=db.prepare('SELECT draft FROM comics WHERE id=?').get(comicId) as {draft:string} | undefined;
        if (!row) throw new Error('Comic not found.');
        const draft=JSON.parse(row.draft) as {operations?:Record<string,string>};
        console.log(Object.fromEntries(Object.entries(draft.operations ?? {}).filter(([key]) => /^(panel|character):/.test(key))));
      } finally {db.close();}
    } catch (error) {console.error(error instanceof Error ? error.message : 'Unable to list operations.');process.exitCode=1;}
  } else if (!comicId || !operation || confirmation !== '--confirm' || extra.length) {
    console.error('Usage: bun scripts/resolve-image-operation.ts <comic-id> --list | <comic-id> <panel:id|character:id> --confirm');
    process.exitCode=1;
  } else {
    try {
      resolveImageOperation(path,comicId,operation);
      console.log('Image operation released. No provider call was refunded or retried.');
    } catch (error) { console.error(error instanceof Error ? error.message : 'Unable to resolve operation.'); process.exitCode=1; }
  }
}
