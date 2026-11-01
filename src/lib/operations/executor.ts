import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {AIError,createAIService,type AIOptions} from '../ai/service';
import {ApplicationError,type ComicAssets,type ComicDependencies,type ComicRepository} from '../application/contracts';
import type {createComicService} from '../application/comics';
import {PostgresRepository} from '../storage/postgres';
import type {PrivateObjects} from '../storage/assets';
import type {Json,OperationRepository,WorkerLease} from './contracts';
import type {PoolClient} from 'pg';
import {PostgresAtomicExecutor,atomicActions} from './atomic-executor';
import {PostgresPaidGateway} from './paid-gateway';
import {lockCheckpointComic,TransactionComicRepository} from './transaction-repository';

type FetchLike=NonNullable<AIOptions['fetch']>;
export type DurableContext={
  paid<T>(step:{id:string;input:Json;expectedRevision:number},invoke:(fetch:FetchLike)=>Promise<T>):Promise<T>;
  checkpoint<T extends Json>(key:string,work:(repository:ComicRepository)=>Promise<T>):Promise<T>;
  load<T extends Json>(key:string):Promise<T|null>;
  assetIdFor(stepId:string):Promise<string|null>;
  stepState(stepId:string):Promise<'running'|'completed'|'failed'|'unknown'|null>;
};
/** Adapter must use the durable context for every paid call and durable mutation. */
export interface DurableServiceAdapter {
  readonly kind:'comex-durable-service-v1';
  create(deps:ComicDependencies,durable:DurableContext):ReturnType<typeof createComicService>;
}
function toJson(value:unknown):Json {
  const inspect=(v:unknown):void=>{if(v instanceof Uint8Array || v instanceof ArrayBuffer)throw new Error('Binary data must be stored as a private asset.');if(Array.isArray(v))v.forEach(inspect);else if(v && typeof v==='object')Object.values(v).forEach(inspect);};
  inspect(value);const text=JSON.stringify(value);if(text===undefined)throw new Error('Operation result must be serializable.');return JSON.parse(text) as Json;
}
async function bestEffort(work:()=>void|Promise<void>):Promise<void> {try {await work();} catch { /* Lease recovery handles a lost worker. */ }}

export class PostgresComicExecutor {
  private atomic:PostgresAtomicExecutor;
  private paid:PostgresPaidGateway;
  constructor(private pool:Pool,private operations:OperationRepository<PoolClient>,private objects:PrivateObjects,private assets:ComicAssets,private adapter:DurableServiceAdapter,fetcher:FetchLike=globalThis.fetch) {
    if(adapter.kind!=='comex-durable-service-v1')throw new Error('A durable comic service adapter is required.');
    this.atomic=new PostgresAtomicExecutor(operations,objects,assets);this.paid=new PostgresPaidGateway(pool,operations,assets,fetcher);
  }
  async execute(operationId:string):Promise<void> {
    let lease=await this.operations.claimOperation(operationId,300000);if(!lease)return;
    const operation=await this.operations.getLeased(lease);
    if(atomicActions.has(operation.action)){await this.atomic.executeLeased(lease);return;}
    const current=()=>lease as WorkerLease;
    const renew=async()=>{lease=await this.operations.renewOperation(current(),300000);};
    const durable:DurableContext={
      paid:async(step,invoke)=>{await renew();return this.paid.run({lease:current(),owner:operation.owner,step,expectedRevision:step.expectedRevision},invoke);},
      checkpoint:async(key,work)=>{return await this.operations.runCheckpoint(current(),key,async client=>toJson(await work(new TransactionComicRepository(client,this.objects,operation.id))),lockCheckpointComic) as never;},
      load:async(key)=>await this.operations.getCheckpoint(operation.owner,operation.id,key) as never,
      assetIdFor:async(stepId)=>await this.paid.assetIdFor(operation.owner,operation.id,stepId),
      stepState:async(stepId)=>(await this.operations.getStep(operation.owner,operation.id,stepId))?.state ?? null,
    };
    const deps:ComicDependencies={repository:new PostgresRepository(this.pool,this.objects),assets:this.assets,provider:createAIService,budgetFetch:async()=>{throw new Error('A provider call requires a durable paid step.');},id:randomUUID};
    const service=this.adapter.create(deps,durable);
    const input=operation.input as Record<string,unknown>,id=operation.targetId,actor=operation.owner,revision=operation.expectedVersions as number;
    const {characterId,panelId,pageId,...body}=input;
    try {
      let result:unknown;
      switch(operation.action) {
        case 'initialQuestions':result=await service.initialQuestions(actor,id,input,revision);break;
        case 'refreshQuestions':result=await service.refreshQuestions(actor,id,input,revision);break;
        case 'suggestCharacters':result=await service.suggestCharacters(actor,id,input,revision);break;
        case 'planStory':result=await service.planStory(actor,id,input,revision);break;
        case 'generateReference':result=await service.generateReference(actor,id,String(characterId),body,revision);break;
        case 'previewRevision':result=await service.previewRevision(actor,id,input,revision);break;
        case 'applyRevision':result=await service.applyRevision(actor,id,input,revision);break;
        case 'generatePage':result=await service.generatePage(actor,id,String(pageId),input,revision);break;
        case 'editPanel':result=await service.editPanel(actor,id,String(panelId),body,revision);break;
        default:throw new Error('Unsupported generation action.');
      }
      await renew();
      const needsReview=operation.action==='previewRevision'||!!(result && typeof result==='object' && ('editDecision' in result || ('notice' in result && (result as {notice?:unknown}).notice)));
      await this.operations.finishOperation(current(),needsReview?'needs_review':'succeeded',toJson(result));
    } catch(error) {
      if(error instanceof AIError && (error.code==='unknown_outcome'||error.code==='invalid_response')) {await bestEffort(()=>this.operations.releaseUnknown(current()));return;}
      if(error instanceof Error && error.message==='The connection was revoked or expired.') {await bestEffort(()=>this.operations.finishOperation(current(),'revoked',null));return;}
      if(error instanceof ApplicationError) {await bestEffort(()=>this.operations.finishOperation(current(),error.code==='conflict'?'obsolete':'failed',{code:error.code,message:error.message}));return;}
      await bestEffort(()=>this.operations.finishOperation(current(),'failed',{code:'operation_failed',message:'The operation could not be completed.'}));
    }
  }
}
