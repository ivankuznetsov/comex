/** Recompose an unchanged published edition. No AI requests or draft changes.
 * Dry run: bun --env-file=.env.production.local scripts/repair-lettering.ts ID EDITION OUTPUT_DIR
 * Apply the reviewed revision: same command plus --apply REVISION
 */
import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {composePages} from '../src/lib/composition';
import {PostgresAssets,VercelPrivateObjects} from '../src/lib/storage/assets';
import {PostgresRepository} from '../src/lib/storage/postgres';
import type {Draft,Edition} from '../src/lib/application/contracts';

const [id,expectedEdition,out,apply,expectedRevision]=process.argv.slice(2);
if(!id||!expectedEdition||!out||!isAbsolute(out)||!process.env.DATABASE_URL||
   (apply!==undefined&&(apply!=='--apply'||!/^\d+$/.test(expectedRevision??''))))
  throw new Error('Usage: ID EXPECTED_EDITION ABSOLUTE_OUTPUT_DIR [--apply EXPECTED_REVISION]');
await mkdir(out,{recursive:true,mode:0o700});
const pool=new Pool({connectionString:process.env.DATABASE_URL});
try {
  const row=(await pool.query('SELECT owner,revision,draft,edition,import_batch_id FROM comics WHERE id=$1',[id])).rows[0];
  if(!row||row.import_batch_id||!row.edition||row.edition.editionId!==expectedEdition||row.revision!==row.edition.sourceRevision)
    throw new Error('Edition changed, draft differs from publication, or comic is unavailable; repair aborted.');
  if(apply&&row.revision!==Number(expectedRevision)) throw new Error('Revision changed since review.');
  const draft=row.draft as Draft,old=row.edition as Edition;
  const objects=new VercelPrivateObjects(),assets=new PostgresAssets(pool,objects),repository=new PostgresRepository(pool,objects);
  const backupAssets=(await pool.query('SELECT * FROM publication_assets WHERE comic_id=$1',[id])).rows;
  await writeFile(join(out,`before-${row.revision}.json`),JSON.stringify({row,publicationAssets:backupAssets},null,2),{mode:0o600});
  const pages=await composePages(draft,asset=>assets.read(asset));
  for(let i=0;i<pages.length;i++) await writeFile(join(out,`page-${i+1}.png`),pages[i].image);
  console.log(JSON.stringify({mode:apply?'apply':'dry-run',id,revision:row.revision,edition:expectedEdition,pages:pages.length,output:out}));
  if(apply) {
    const editionId=randomUUID();
    const rendered=pages.map(page=>({...page,assetId:randomUUID()}));
    const uploaded=rendered.map(page=>({id:page.assetId,data:page.image}));
    let coverUrl=old.coverUrl;
    if(coverUrl) {
      const oldCoverId=new URL(coverUrl,'https://comex.invalid').pathname.split('/').pop()!;
      const cover=await repository.getPublicationAsset(id,oldCoverId);if(!cover)throw new Error('Published cover missing.');
      const coverId=randomUUID();uploaded.push({id:coverId,data:Buffer.from(cover)});
      coverUrl=`/api/published/${id}/assets/${coverId}?edition=${editionId}`;
    }
    const edition:Edition={...old,editionId,sourceRevision:row.revision+1,coverUrl,pages:rendered.map(page=>({id:page.id,imageUrl:`/api/published/${id}/assets/${page.assetId}?edition=${editionId}`,storage:'sqlite'}))};
    if(!await repository.publish(id,row.owner,row.revision,edition,uploaded)) throw new Error('Concurrent change: no edition was replaced.');
    await writeFile(join(out,'repaired-edition.json'),JSON.stringify(edition,null,2));
    console.log(JSON.stringify({saved:true,editionId,revision:row.revision+1}));
  }
}finally{await pool.end();}
