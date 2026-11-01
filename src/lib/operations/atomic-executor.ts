import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {createComicService} from '../application/comics';
import {ApplicationError,type ComicAssets} from '../application/contracts';
import {createAIService} from '../ai/service';
import type {PrivateObjects} from '../storage/assets';
import type {Json,Operation,OperationRepository,WorkerLease} from './contracts';
import {lockCheckpointComic,TransactionComicRepository} from './transaction-repository';

export const atomicActions=new Set(['create','update','addCharacter','editCharacter','removeCharacter','approveCharacter','approveStory','acceptStoryReview','acceptPanel','exportPage','publish','withdraw']);
function ids(operationId:string):()=>string {
  let index=0;
  return ()=>{
    if(index++===0)return operationId;
    const bytes=createHash('sha256').update(`${operationId}:${index}`).digest().subarray(0,16);
    bytes[6]=(bytes[6]&15)|0x40;bytes[8]=(bytes[8]&63)|0x80;
    const hex=bytes.toString('hex');return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  };
}
async function verify(client:PoolClient,op:Operation):Promise<void> {
  if(op.targetId) {
    const comic=(await client.query('SELECT owner,revision,import_batch_id FROM comics WHERE id=$1 FOR UPDATE',[op.targetId])).rows[0];
    if(!comic||comic.owner!==op.owner||comic.import_batch_id!==null)throw new ApplicationError('not_found','Comic not found.');
    if(comic.revision!==op.expectedVersions)throw new ApplicationError('conflict','This draft changed. Refresh and try again.');
  }
  if(op.grantId) {
    const active=await client.query(`SELECT g.id FROM mcp_grants g JOIN "session" s ON s.id=g.session_id AND s."userId"=g.user_id WHERE g.id=$1 AND g.owner=$2 AND g.revoked_at IS NULL AND s."expiresAt">now() FOR UPDATE OF g`,[op.grantId,op.owner]);
    if(!active.rowCount)throw new Error('The connection was revoked or expired.');
  }
}
/** Executes short, non-provider actions in the same transaction as their result checkpoint. */
export class PostgresAtomicExecutor {
  constructor(private operations:OperationRepository<PoolClient>,private objects:PrivateObjects,private assets:ComicAssets) {}
  async execute(operationId:string):Promise<void> {
    const lease=await this.operations.claimOperation(operationId,300000);if(!lease)return;
    await this.executeLeased(lease);
  }
  async executeLeased(lease:WorkerLease):Promise<void> {
    const operation=await this.operations.getLeased(lease);
    if(!atomicActions.has(operation.action))throw new Error('This action requires a resumable generation executor.');
    let result:Json;
    try {
      result=await this.operations.runCheckpoint(lease,'apply',async(client,context)=>{
        const op=context.operation;await verify(client,op);
        const service=createComicService({repository:new TransactionComicRepository(client,this.objects,op.id),assets:this.assets,provider:createAIService,budgetFetch:async()=>{throw new Error('A provider call requires a durable paid step.');},id:ids(op.id)});
        const input=op.input as Record<string,unknown>,actor=op.owner,id=op.targetId,revision=op.expectedVersions as number;
        const {characterId,panelId,pageId,...body}=input;
        let value:unknown;
        switch(op.action) {
          case 'create':value=await service.create(actor,input);break;
          case 'update':value=await service.update(actor,id,input,revision);break;
          case 'addCharacter':value=await service.addCharacter(actor,id,input,revision);break;
          case 'editCharacter':value=await service.editCharacter(actor,id,String(characterId),body,revision);break;
          case 'removeCharacter':value=await service.removeCharacter(actor,id,String(characterId),body,revision);break;
          case 'approveCharacter':value=await service.approveCharacter(actor,id,String(characterId),body,revision);break;
          case 'approveStory':value=await service.approveStory(actor,id,{...input,revision},revision);break;
          case 'acceptStoryReview':value=await service.acceptStoryReview(actor,id,input,revision);break;
          case 'acceptPanel':value=await service.acceptPanel(actor,id,String(panelId),body,revision);break;
          case 'exportPage':{const bytes=await service.downloadPage(actor,id,String(pageId),revision);value={exportAssetId:await this.assets.save(bytes)};break;}
          case 'publish':value=await service.publish(actor,id,input,revision);break;
          case 'withdraw':value=await service.withdraw(actor,id,input,revision);break;
          default:throw new Error('Unsupported atomic action.');
        }
        return JSON.parse(JSON.stringify(value)) as Json;
      },lockCheckpointComic);
    } catch(error) {
      if(error instanceof ApplicationError)await this.operations.finishOperation(lease,error.code==='conflict'?'obsolete':'failed',{code:error.code,message:error.message});
      else if(error instanceof Error && error.message==='The connection was revoked or expired.')await this.operations.finishOperation(lease,'revoked',null);
      else await this.operations.finishOperation(lease,'failed',{code:'operation_failed',message:'The operation could not be completed.'});
      throw error;
    }
    await this.operations.finishOperation(lease,'succeeded',result);
  }
}
/** Call only after authenticating the owner; export IDs alone do not grant access. */
export async function readOwnedExport(operations:OperationRepository<PoolClient>,assets:ComicAssets,owner:string,operationId:string):Promise<Buffer|null> {
  const op=await operations.getOwned(owner,operationId);if(!op||op.action!=='exportPage'||op.status!=='succeeded'||!op.result||typeof op.result!=='object'||Array.isArray(op.result))return null;
  const id=op.result.exportAssetId;return typeof id==='string'?await assets.read(id):null;
}
