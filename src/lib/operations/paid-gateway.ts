import {beginCost,attachCostReceipt,requestCostMetadata} from '../ai/cost-ledger';
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
    const {lease,owner,step,expectedRevision}=request;
    let claimed:string|undefined,dispatched=false,fetchStarted=false,targetId='',grantId:string|null=null,preDispatchError:unknown;
    const grantCheck=async(client:PoolClient)=>{
      if(!grantId)return;
      const query=`SELECT g.id FROM mcp_grants g JOIN "session" s ON s.id=g.session_id AND s."userId"=g.user_id WHERE g.id=$1 AND g.owner=$2 AND g.revoked_at IS NULL AND s."expiresAt">clock_timestamp() FOR UPDATE OF g`;
      if(!(await client.query(query,[grantId,owner])).rowCount)throw new Error('The connection was revoked or expired.');
    };
    const comicCheck=async(client:PoolClient)=>{
      const comic=(await client.query('SELECT revision,owner,import_batch_id FROM comics WHERE id=$1 FOR UPDATE',[targetId])).rows[0];
      if(!comic || comic.owner!==owner || comic.import_batch_id!==null)throw new ApplicationError('not_found','Comic not found.');
      if(comic.revision!==expectedRevision)throw new ApplicationError('conflict','This draft changed. Refresh and try again.');
    };
    try {
      // Commit the reservation while holding the comic and grant locks, before
      // invoking any provider preparation or opening a dispatch transaction.
      const claim=await this.operations.claimPaidStep(lease,step,async(c,context)=>{
        if(context.operation.owner!==owner)throw new OperationError('lease_lost','The operation worker lease was lost.');
        targetId=context.operation.targetId;grantId=context.operation.grantId;
        await comicCheck(c);await grantCheck(c);
      });
      if(claim.kind==='completed')return await decode(claim.result,this.assets) as T;
      if(claim.kind==='unknown')throw new AIError('unknown_outcome','The provider outcome is unknown; resolve it before retrying.');
      if(claim.kind==='failed')throw new AIError('provider_error','The previous provider attempt failed.');
      if(claim.kind!=='claimed')throw new Error(`Provider step is ${claim.kind}; it will not be dispatched again.`);
      claimed=claim.reservationId;
      const guarded:FetchLike=async(input,init)=>{
        if(fetchStarted)throw new Error('A provider step may dispatch only once.');fetchStarted=true;
        let client:PoolClient;
        try {client=await this.pool.connect();} catch(error) {preDispatchError=error;throw error;}
        let open=false;
        let response!:Promise<{ok:true;value:Response}|{ok:false;error:unknown}>;
        try {
          await client.query('BEGIN');open=true;await comicCheck(client);
          const active=await client.query("SELECT 1 FROM operations WHERE id=$1 AND owner=$2 AND target_id=$3 AND grant_id IS NOT DISTINCT FROM $4 AND status='running' AND lease_token=$5 AND fence=$6 FOR UPDATE",[lease.operationId,owner,targetId,grantId,lease.token,lease.fence]);
          if(!active.rowCount)throw new OperationError('lease_lost','The operation worker lease was lost.');
          await grantCheck(client);
          const unexpired=await client.query('SELECT 1 FROM operations WHERE id=$1 AND lease_until>floor(extract(epoch FROM clock_timestamp())*1000)',[lease.operationId]);
          if(!unexpired.rowCount)throw new OperationError('lease_lost','The operation worker lease was lost.');
          await beginCost(client,{reservationId:claimed!,comicId:targetId,operationId:lease.operationId,stepId:step.id},input,init);
          dispatched=true;
          try {response=Promise.resolve(this.fetcher(input,init)).then(value=>({ok:true as const,value}),error=>({ok:false as const,error}));}
          catch(error) {response=Promise.resolve({ok:false as const,error});}
          await client.query('COMMIT');open=false;
        } catch(error) {if(!dispatched)preDispatchError=error;if(open)await client.query('ROLLBACK').catch(()=>{});throw error;} finally {client.release();}
        const delivered=await response;if(!delivered.ok)throw delivered.error;
        attachCostReceipt(delivered.value,this.pool,{reservationId:claimed!,comicId:targetId,operationId:lease.operationId,stepId:step.id},requestCostMetadata(input,init));
        return delivered.value;
      };
      const value=await invoke(guarded);
      if(!dispatched)throw new Error('Provider step did not dispatch.');
      await this.operations.completePaidStep(lease,step.id,'completed',await encode(value,this.assets) as unknown as Json);
      return value;
    } catch(error) {
      if(!dispatched && preDispatchError!==undefined)error=preDispatchError;
      if(claimed) {
        if(dispatched) {
          const known=error instanceof AIError && (error.code==='provider_error'||error.code==='refusal');
          await bestEffort(()=>this.operations.completePaidStep(lease,step.id,known?'failed':'unknown',null));
          if(!known)throw new AIError('unknown_outcome','The provider outcome could not be confirmed. Check the operation before retrying.');
        } else await bestEffort(()=>this.operations.cancelUndispatchedStep(lease,step.id,claimed!));
      }
      throw error;
    }
  }
}
