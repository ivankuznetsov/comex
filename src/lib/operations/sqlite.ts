import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import type {BudgetConfig} from '../budget';
import {BaseOperations,type Effect,type Program} from './repository';

/** Initialize only on the same SQLite database that contains provider_reservations. */
export function initializeSqliteOperations(db:DatabaseSync):void {
  const columns=db.prepare('PRAGMA table_info(provider_reservations)').all() as {name:string}[];
  if(!columns.some(c=>c.name==='step_key')) throw new Error('Initialize the provider budget in this same SQLite database first.');
  const migration=readFileSync(join(process.cwd(),'db/migrations/003_operations.sql'),'utf8')
    .replaceAll('CREATE TABLE ','CREATE TABLE IF NOT EXISTS ').replaceAll('CREATE INDEX ','CREATE INDEX IF NOT EXISTS ');
  db.exec('BEGIN IMMEDIATE');
  try {db.exec(migration);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
}

/** Limit a policy's database handle to the duration of its synchronous callback. */
function policyScope(db:DatabaseSync):{client:DatabaseSync;close:()=>void} {
  let active=true;
  const check=()=>{if(!active)throw new Error('SQLite transaction policy has ended.');};
  const client=new Proxy(db,{
    get(target,key) {
      check();
      if(key==='exec')return (sql:string)=>{check();return target.exec(sql);};
      if(key==='prepare')return (sql:string)=>{
        check();const statement=target.prepare(sql);
        return new Proxy(statement,{get(inner,property){
          check();const value=Reflect.get(inner,property,inner);
          return typeof value==='function'?(...args:unknown[])=>{check();return value.apply(inner,args);}:value;
        }});
      };
      throw new Error('SQLite policies may use exec and prepare only.');
    }
  });
  return {client,close:()=>{active=false;}};
}

/** SQLite transaction policies must be synchronous, like DatabaseSync itself. */
export class SqliteOperationRepository extends BaseOperations<DatabaseSync> {
  constructor(private db:DatabaseSync,budget:BudgetConfig){super(budget);}
  protected transact<T>(program:Program<DatabaseSync,T>):T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      let next=program.next();
      while(!next.done){
        const effect:Effect<DatabaseSync>=next.value;let result:unknown;
        if(effect.kind==='time') result=Date.now();
        else if(effect.kind==='budget_lock'||effect.kind==='request_lock') result=undefined;
        else if(effect.kind==='policy') {
          if(Object.prototype.toString.call(effect.policy)==='[object AsyncFunction]') throw new Error('SQLite transaction policies must be synchronous.');
          const scope=policyScope(this.db);
          try {result=effect.policy(scope.client,effect.context);} finally {scope.close();}
          if(result && typeof (result as Promise<unknown>).then==='function') {
            void Promise.resolve(result).catch(()=>{});
            throw new Error('SQLite transaction policies must be synchronous.');
          }
        } else {
          const sql=effect.sql.replace(/ FOR UPDATE OF i SKIP LOCKED/g,'').replace(/ FOR UPDATE/g,'');
          const statement=this.db.prepare(sql);
          if(/^\s*SELECT\b/i.test(sql)||/\bRETURNING\b/i.test(sql)) {const rows=statement.all(...effect.params);result={rows,rowCount:rows.length};}
          else {const outcome=statement.run(...effect.params);result={rows:[],rowCount:Number(outcome.changes)};}
        }
        next=program.next(result);
      }
      this.db.exec('COMMIT');return next.value;
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
}
