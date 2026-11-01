import type {Pool,PoolClient} from 'pg';
import {ApplicationError,pageIntentMatches} from '../application/contracts';
import type {Draft,PageIntent} from '../application/contracts';
import {operationActions,type Json,type MutationAction,type OperationIdentity,type OperationRequest,type OperationRepository,type OperationStatus,type PolicyContext} from './contracts';
export type {MutationAction,OperationIdentity,OperationRequest} from './contracts';

const paid=new Set<MutationAction>(['initialQuestions','refreshQuestions','suggestCharacters','generateReference','planStory','generatePage','editPanel','previewRevision','applyRevision']);
const publishing=new Set<MutationAction>(['publish','withdraw']);
const actions=new Set<MutationAction>(operationActions);

/** Only accepts an identity already verified by a browser or bearer-token adapter. */
export class PostgresOperationCoordinator {
  readonly kind='durable' as const;
  constructor(private pool:Pool,private operations:OperationRepository<PoolClient>,private browserIdentity?:(client:PoolClient,identity:OperationIdentity)=>Promise<boolean>) {}
  async enqueue(request:OperationRequest):Promise<{id:string;status:OperationStatus;comicId?:string}> {
    const {identity,action,requestKey,comicId,expectedRevision,input}=request;
    if(!actions.has(action) || !requestKey || requestKey.length>128 || !identity.actor || !identity.scopes.includes('comex:write') || (paid.has(action) && !identity.scopes.includes('comex:generate')) || (publishing.has(action) && !identity.scopes.includes('comex:publish'))) throw new ApplicationError('invalid_input','This operation is not authorized.');
    if(action==='create' ? comicId!==undefined || expectedRevision!==undefined : !comicId || !Number.isSafeInteger(expectedRevision) || expectedRevision!<1) throw new ApplicationError('invalid_input','An existing comic and its revision are required.');
    const check=async (client:PoolClient,context:PolicyContext)=>{
      if(!identity.grantId) {
        if(!this.browserIdentity)throw new Error('Browser identity revalidation is not configured.');
        await client.query('SELECT id FROM auth_guard WHERE id=1 FOR UPDATE');
      }
      if(action!=='create') {
        const found=(await client.query('SELECT owner,revision,draft,import_batch_id FROM comics WHERE id=$1 FOR UPDATE',[context.operation.targetId])).rows[0];
        if(!found || found.owner!==identity.actor || found.import_batch_id!==null) throw new ApplicationError('not_found','Comic not found.');
        if(context.phase==='create') {
          if(found.revision!==expectedRevision) throw new ApplicationError('conflict','This draft changed. Refresh and try again.');
          if(action==='generatePage') validatePageIntent(found.draft as Draft,input);
        }
      }
      if(!identity.grantId && !(await this.browserIdentity!(client,identity))) throw new Error('Browser identity is no longer valid.');
      if(identity.grantId) {
        const grant=await client.query(`SELECT g.id FROM mcp_grants g JOIN "session" s ON s.id=g.session_id AND s."userId"=g.user_id
          WHERE g.id=$1 AND g.owner=$2 AND g.revoked_at IS NULL AND s."expiresAt">now() FOR UPDATE OF g`,[identity.grantId,identity.actor]);
        if(!grant.rowCount)throw new ApplicationError('not_found','Connection not found.');
      }
    };
    const {operation}=await this.operations.start({owner:identity.actor,action,requestKey,targetId:comicId??'',grantId:identity.grantId??null,expectedVersions:expectedRevision??null,input:input as Json},check);
    return {id:operation.id,status:operation.status,...(comicId?{comicId}:{})};
  }
}

function validatePageIntent(draft:Draft,input:Record<string,unknown>):void {
  if(typeof input.pageId!=='string' || !['generate','resume','regenerate'].includes(String(input.intent))) throw new ApplicationError('invalid_input','Choose a page and generation intent.');
  const page=draft.pages.find(p=>p.id===input.pageId);if(!page)throw new ApplicationError('not_found','Page not found.');
  if(!pageIntentMatches(draft,page.id,input.intent as PageIntent)) throw new ApplicationError('conflict','The selected generation intent does not match this page. Refresh and review its current state.');
}
