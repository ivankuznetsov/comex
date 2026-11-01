import type {Pool} from 'pg';
import type {BudgetConfig} from '../budget';
import {BaseOperations,type Program} from './repository';
import type {PoolClient} from 'pg';

/** Policies receive the same client and may lock the active grant and target rows. */
export class PostgresOperationRepository extends BaseOperations<PoolClient> {
  constructor(private pool:Pool,budget:BudgetConfig){super(budget);}
  protected async transact<T>(program:Program<PoolClient,T>):Promise<T> {
    const client=await this.pool.connect();
    try {
      await client.query('BEGIN');let next=program.next();
      while(!next.done){
        const effect=next.value;let result:unknown;
        if(effect.kind==='time') result=Number((await client.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now')).rows[0].now);
        else if(effect.kind==='budget_lock') {await client.query('SELECT id FROM provider_budget_guard WHERE id=1 FOR UPDATE');result=undefined;}
        else if(effect.kind==='request_lock') {await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[effect.key]);result=undefined;}
        else if(effect.kind==='policy') result=await effect.policy(client,effect.context);
        else {let index=0;const sql=effect.sql.replace(/\?/g,()=>`$${++index}`);const out=await client.query(sql,effect.params);result={rows:out.rows,rowCount:out.rowCount??0};}
        next=program.next(result);
      }
      await client.query('COMMIT');return next.value;
    } catch(error) {await client.query('ROLLBACK').catch(()=>{});throw error;} finally {client.release();}
  }
}
