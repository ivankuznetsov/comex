import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';

// Stop all app processes and inspect provider/panel reservations before either step.
const [id,mode,confirmation,...extra]=process.argv.slice(2);
if (id === '--list' && !mode && !confirmation && !extra.length) {
  const db=new DatabaseSync(process.env.COMEX_DB_PATH || resolve(process.cwd(),'data/comex.sqlite'));
  try {console.log(JSON.stringify(db.prepare("SELECT id,comic_id AS comicId,page_id AS pageId,state,created_at AS createdAt FROM page_jobs WHERE state IN ('running','unknown') ORDER BY created_at").all(),null,2));}
  finally {db.close();}
  process.exit(0);
}
if (!id || !/^[a-f0-9-]{36}$/i.test(id) || !['--mark-unknown','--resolve'].includes(mode ?? '') || confirmation !== '--confirm' || extra.length) {
  console.error('Usage: bun scripts/resolve-page-job.ts --list | <job-id> <--mark-unknown|--resolve> --confirm');
  process.exit(1);
}
const db=new DatabaseSync(process.env.COMEX_DB_PATH || resolve(process.cwd(),'data/comex.sqlite'));
try {
  const from=mode === '--mark-unknown' ? 'running' : 'unknown';
  const to=mode === '--mark-unknown' ? 'unknown' : 'failed';
  const message=mode === '--mark-unknown' ? 'The interrupted page request requires operator investigation.' : 'The operator resolved the interrupted page request. Review the draft before retrying.';
  if (mode === '--resolve') {
    const row=db.prepare('SELECT c.draft FROM page_jobs j JOIN comics c ON c.id=j.comic_id WHERE j.id=?').get(id) as {draft:string}|undefined;
    if (!row) throw new Error('Page job not found.');
    const draft=JSON.parse(row.draft) as {operations?:Record<string,string>;pages?:{panels?:{status?:string}[]}[]};
    if (Object.values(draft.operations ?? {}).some(value=>value==='running' || value==='unknown_outcome') || draft.pages?.some(page=>page.panels?.some(panel=>panel.status==='checking')))
      throw new Error('Resolve outstanding image operations and visual checks before resolving this page job.');
  }
  const updated=db.prepare('UPDATE page_jobs SET state=?,message=? WHERE id=? AND state=?').run(to,message,id,from);
  if (Number(updated.changes)!==1) throw new Error('No matching page job in the expected state.');
  console.log(`Page job marked ${to}; no calls were retried or refunded.`);
} finally {db.close();}
