import {Pool} from 'pg';
import {applyMigrations} from '../src/lib/storage/postgres';
import {VercelPrivateObjects} from '../src/lib/storage/assets';
import {importSqlite} from '../src/lib/storage/import';

// An operator must explicitly select the source and destination. Application startup never runs this.
const [action,databasePath,assetPath,batchId,budgetPath]=process.argv.slice(2);
if (!process.env.DATABASE_URL || (action!=='migrate' && action!=='import') || (action==='import' && (!databasePath||!assetPath||!batchId))) {
  throw new Error('Set DATABASE_URL and run: bun scripts/hosted-storage.ts migrate | import <sqlite-path> <asset-directory> <batch-id> [budget-sqlite-path]');
}
const pool=new Pool({connectionString:process.env.DATABASE_URL});
try {
  if(action==='migrate') await applyMigrations(pool);
  else await importSqlite({pool,objects:new VercelPrivateObjects(),databasePath,budgetPath,assetPath,batchId});
} finally {await pool.end();}
