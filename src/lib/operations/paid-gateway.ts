import type {Pool,PoolClient} from 'pg';
import {AIError} from '../ai/service';
import {ApplicationError,type ComicAssets} from '../application/contracts';
import {OperationError,type Json,type OperationRepository,type WorkerLease} from './contracts';

type FetchLike=(input:string|URL|Request,init?:RequestInit)=>Promise<Response>;
async function bestEffort(work:()=>void|Promise<void>):Promise<void> {try {await work();} catch { /* An expired lease is recovered as unknown. */ }}
type Encoded={format:'json';value:Json}|{format:'private_asset';assetId:string};
async function encode(value:unknown,assets:Pick<ComicAssets,'save'|'read'>):Promise<Encoded> {
  if(value instanceof Uint8Array)return {format:'private_asset',assetId:await assets.save(Buffer.from(value))};
  const serialized=JSON.stringify(value);if(serialized===undefined)throw new Error('Provider output is not serializable.');
  return {format:'json',value:JSON.parse(serialized) as Json};
}
async function decode(value:Json|null,assets:Pick<ComicAssets,'save'|'read'>):Promise<unknown> {
  const record=value as Encoded|null;
  if(record?.format==='private_asset')return await assets.read(record.assetId);
  if(record?.format==='json')return record.value;
  throw new Error('The stored provider result is unavailable.');
}

/** A validated provider call runs once; replay returns its stored result or an unknown outcome. */
export class PostgresPaidGateway {
  constructor(private pool:Pool,private operations:OperationRepository<PoolClient>,private assets:Pick<ComicAssets,'save'|'read'>,private fetcher:FetchLike=globalThis.fetch) {}
  async assetIdFor(owner:string,operationId:string,stepId:string):Promise<string|null> {
    const step=await this.operations.getStep(owner,operationId,stepId);
    const result=step?.result as Encoded|null|undefined;
    return step?.state==='completed' && result?.format==='private_asset'?result.assetId:null;
  }
  async run<T>(request:{lease:WorkerLease;owner:string;step:{id:string;input:Json};expectedRevision:number},invoke:(fetch:FetchLike)=>Promise<T>):Promise<T> {
    const {lease,owner,step,expectedRevision}=request,client=await this.pool.connect();
    let transactionOpen=false,claimed:string|undefined,dispatched=false;
    try {
      await client.query('BEGIN');transactionOpen=true;
      const op=(await client.query('SELECT owner,target_id,grant_id,status,lease_token,fence,lease_until FROM operations WHERE id=$1',[lease.operationId])).rows[0];
      if(!op || op.owner!==owner || op.status!=='running' || op.lease_token!==lease.token || Number(op.fence)!==lease.fence)throw new OperationError('lease_lost','The operation worker lease was lost.');
      const comic=(await client.query('SELECT revision,owner,import_batch_id FROM comics WHERE id=$1 FOR UPDATE',[op.target_id])).rows[0];
      if(!comic || comic.owner!==owner || comic.import_batch_id!==null)throw new ApplicationError('not_found','Comic not found.');
      if(comic.revision!==expectedRevision)throw new ApplicationError('conflict','This draft changed. Refresh and try again.');
      const grantCheck=async(c:PoolClient,lock:boolean)=>{
        if(!op.grant_id)return;
        const query=`SELECT g.id FROM mcp_grants g JOIN "session" s ON s.id=g.session_id AND s."userId"=g.user_id WHERE g.id=$1 AND g.owner=$2 AND g.revoked_at IS NULL AND s."expiresAt">now()${lock?' FOR UPDATE OF g':''}`;
        if(!(await c.query(query,[op.grant_id,owner])).rowCount)throw new Error('The connection was revoked or expired.');
      };
      await grantCheck(client,true);
      // These reads share the reservation transaction; the outer transaction holds both row locks.
      const claim=await this.operations.claimPaidStep(lease,step,async(c,context)=>{
        const current=(await c.query('SELECT owner,revision,import_batch_id FROM comics WHERE id=$1',[context.operation.targetId])).rows[0];
        if(!current || current.owner!==owner || current.import_batch_id!==null || current.revision!==expectedRevision)throw new ApplicationError('conflict','This draft changed. Refresh and try again.');
        await grantCheck(c,false);
      });
      if(claim.kind==='completed') {await client.query('COMMIT');transactionOpen=false;return await decode(claim.result,this.assets) as T;}
      if(claim.kind==='unknown')throw new AIError('unknown_outcome','The provider outcome is unknown; resolve it before retrying.');
      if(claim.kind==='failed')throw new AIError('provider_error','The previous provider attempt failed.');
      if(claim.kind!=='claimed')throw new Error(`Provider step is ${claim.kind}; it will not be dispatched again.`);
      claimed=claim.reservationId;
      const guarded:FetchLike=async(input,init)=>{
        if(dispatched)throw new Error('A provider step may dispatch only once.');
        // Recheck expiry while the grant row is locked. Reserve was already committed.
        await grantCheck(client,false);
        const active=await client.query("SELECT 1 FROM operations WHERE id=$1 AND status='running' AND lease_token=$2 AND fence=$3 AND lease_until>floor(extract(epoch FROM clock_timestamp())*1000) FOR UPDATE",[lease.operationId,lease.token,lease.fence]);
        if(!active.rowCount)throw new OperationError('lease_lost','The operation worker lease was lost.');
        dispatched=true;
        let response:Promise<{ok:true;value:Response}|{ok:false;error:unknown}>;
        try {response=Promise.resolve(this.fetcher(input,init)).then(value=>({ok:true as const,value}),error=>({ok:false as const,error}));}
        catch(error) {response=Promise.resolve({ok:false as const,error});}
        await client.query('COMMIT');transactionOpen=false;
        const delivered=await response;if(!delivered.ok)throw delivered.error;return delivered.value;
      };
      const value=await invoke(guarded);
      if(!dispatched)throw new Error('Provider step did not dispatch.');
      await this.operations.completePaidStep(lease,step.id,'completed',await encode(value,this.assets) as unknown as Json);
      return value;
    } catch(error) {
      if(transactionOpen){await client.query('ROLLBACK').catch(()=>{});transactionOpen=false;}
      if(claimed) {
        if(dispatched) {
          const known=error instanceof AIError && (error.code==='provider_error'||error.code==='refusal');
          await bestEffort(()=>this.operations.completePaidStep(lease,step.id,known?'failed':'unknown',null));
          if(!known)throw new AIError('unknown_outcome','The provider outcome could not be confirmed. Check the operation before retrying.');
        } else await bestEffort(()=>this.operations.cancelUndispatchedStep(lease,step.id,claimed!));
      }
      throw error;
    } finally {if(transactionOpen)await client.query('ROLLBACK').catch(()=>{});client.release();}
  }
}
