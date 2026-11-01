import {Pool} from 'pg';
import {PostgresProviderBudget} from '../../src/lib/storage/postgres';
const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${process.env.TEST_SCHEMA}`});
await new Promise<void>(resolve=>process.stdin.once('data',()=>resolve()));
try {
  const budget=new PostgresProviderBudget(pool,{maxCalls:10,maxConcurrent:2});
  try {await budget.reserve(process.env.TEST_STEP);process.stdout.write(JSON.stringify({ok:true}));}
  catch(error) {process.stdout.write(JSON.stringify({ok:false,code:(error as {code?:string}).code}));}
} finally {await pool.end();}
