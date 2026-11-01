import {Pool} from 'pg';
import {registerImportBatch} from './claim';
const batchId=process.argv[2],databaseUrl=process.env.DATABASE_URL;
if(!batchId || !databaseUrl)throw new Error('Supply an imported batch ID and DATABASE_URL.');
const pool=new Pool({connectionString:databaseUrl});
try {const count=await registerImportBatch(pool,batchId);console.log(`Registered ${count} imported owner mapping(s).`);}finally{await pool.end();}
