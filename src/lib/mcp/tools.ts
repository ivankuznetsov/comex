import {McpServer} from '@modelcontextprotocol/server';
import {z} from 'zod';
import {domainFailure, result, resultSchema, safeResult} from './results';
import type {ComexMcpDependencies, ComexScope, McpIdentity, MutationAction} from './contracts';

const id=z.string().trim().min(1).max(300);
const requestKey=z.string().trim().min(1).max(128);
const revision=z.number().int().nonnegative();
const storyRevision=z.number().int().positive();
const assetId=z.string().uuid();
const fingerprint=z.string().regex(/^[a-f0-9]{64}$/);
const instruction=z.string().trim().min(1).max(4000);
const style=z.enum(['clear-line-adventure','ink-manga','painted-storybook']);
const card={name:id,role:id,appearance:z.string().trim().min(1).max(1000),outfit:z.string().trim().min(1).max(1000)};
const version={assetId,storyRevision,panelRevision:z.number().int().positive()};
const existing={comicId:id,expectedRevision:revision,requestKey};
const readAnnotation={readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false};
const mutationAnnotation={readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false};
const paidAnnotation={...mutationAnnotation,openWorldHint:true};
const destructiveAnnotation={...mutationAnnotation,destructiveHint:true,openWorldHint:true};
const ticketSchema=z.object({id, status:z.enum(['queued','running','succeeded','needs_review','failed','unknown_outcome','obsolete','revoked']),comicId:id.optional()}).strict();

export const instructions='Use Comex as a guided workflow. After creating a draft, start its initial questions, then character suggestions, as the editor does. Present the saved questions and suggested answers exactly; let the creator choose. Show the saved character suggestions. After adding a character, start its reference image, then ask the creator to review it. Never invent answers or approve for the creator. Show the current references, story beats and dialogue, findings and exact versions before asking for approval. Narrative and panel blockers may be explicitly accepted only after confirming with the creator. Use the saved next steps; request keys prevent duplicate work. Poll operations and never retry unknown paid outcomes automatically. Export is private; publish or withdraw only on explicit request.';

type ToolDefinition={name:string; action:MutationAction; description:string; schema:z.ZodType; scopes:readonly ComexScope[]; paid?:boolean; destructive?:boolean};
const write=['comex:write'] as const, generate=['comex:write','comex:generate'] as const, publish=['comex:write','comex:publish'] as const;
const definitions:ToolDefinition[]=[
  {name:'comex_create_comic',action:'create',description:'Create a private draft using the creator’s title, plot and style. Once created, start its initial questions and then character suggestions as in the editor.',schema:z.object({requestKey,title:id,plot:z.string().trim().min(1).max(4000),style}).strict(),scopes:write},
  {name:'comex_update_comic',action:'update',description:'Update editor fields or answers by the saved question IDs; never invent answers. Plot, style and answers have existing post-plan restrictions.',schema:z.object({...existing,title:id.optional(),plot:z.string().trim().min(1).max(4000).optional(),style:style.optional(),answers:z.record(z.string().max(100),z.string().max(1000)).optional(),panelsPerPage:z.number().int().min(2).max(4).optional(),pageLayout:z.enum(['stack','grid']).optional()}).strict(),scopes:write},
  {name:'comex_start_initial_questions',action:'initialQuestions',description:'Start or resume the same initial tailored questions used by the editor. Present the saved questions, IDs and suggested answers to the creator.',schema:z.object(existing).strict(),scopes:generate,paid:true},
  {name:'comex_refresh_questions',action:'refreshQuestions',description:'Refresh tailored questions, preserving existing answered questions. Present the resulting actual questions and suggested answers.',schema:z.object(existing).strict(),scopes:generate,paid:true},
  {name:'comex_suggest_characters',action:'suggestCharacters',description:'Start or retry the editor’s character suggestions. Show each saved card and allow the creator to review or edit it.',schema:z.object({...existing,retry:z.boolean().optional()}).strict(),scopes:generate,paid:true},
  {name:'comex_add_character',action:'addCharacter',description:'Add the creator-reviewed character card with name, role, appearance and outfit, then start its reference image as the editor does.',schema:z.object({...existing,...card}).strict(),scopes:write},
  {name:'comex_edit_character',action:'editCharacter',description:'Edit a pre-story character card; changing its details clears the affected reference approval.',schema:z.object({...existing,characterId:id,...card}).strict(),scopes:write},
  {name:'comex_remove_character',action:'removeCharacter',description:'Remove a pre-story character after the creator asks to remove it.',schema:z.object({...existing,characterId:id}).strict(),scopes:write,destructive:true},
  {name:'comex_generate_reference',action:'generateReference',description:'Generate or regenerate one character reference; the creator must inspect and approve it separately.',schema:z.object({...existing,characterId:id}).strict(),scopes:generate,paid:true},
  {name:'comex_approve_reference',action:'approveCharacter',description:'Approve exactly the reference image the creator inspected. Supply the displayed reference asset ID.',schema:z.object({...existing,characterId:id,assetId}).strict(),scopes:write},
  {name:'comex_plan_story',action:'planStory',description:'Plan story beats after character references are approved. Show the resulting beats, dialogue and narrative findings before approval.',schema:z.object(existing).strict(),scopes:generate,paid:true},
  {name:'comex_approve_story',action:'approveStory',description:'Approve the displayed story version only when the creator explicitly approves it. Use its story revision, fingerprint and draft revision.',schema:z.object({...existing,storyRevision,fingerprint}).strict(),scopes:write},
  {name:'comex_accept_story_review',action:'acceptStoryReview',description:'Explicitly accept the displayed narrative blocker review after confirming with the creator; acceptance is tied to its fingerprint.',schema:z.object({...existing,fingerprint}).strict(),scopes:write},
  {name:'comex_generate_page',action:'generatePage',description:'Draw a page only after story approval and earlier review. Specify generate, resume or regenerate; inspect any findings before continuing.',schema:z.object({...existing,pageId:id,intent:z.enum(['generate','resume','regenerate'])}).strict(),scopes:generate,paid:true},
  {name:'comex_accept_panel',action:'acceptPanel',description:'Accept the exact displayed panel image and review version after creator inspection. Ask for explicit confirmation before accepting a blocker.',schema:z.object({...existing,panelId:id,...version}).strict(),scopes:write},
  {name:'comex_edit_panel',action:'editPanel',description:'Request an artwork edit using the inspected panel version. Story changes go through revision preview.',schema:z.object({...existing,panelId:id,instruction:z.string().trim().min(1).max(2000),...version}).strict(),scopes:generate,paid:true},
  {name:'comex_confirm_artwork_edit',action:'editPanel',description:'Confirm an existing ambiguous artwork-only choice after asking the creator; the story and later panels stay unchanged.',schema:z.object({...existing,panelId:id,proposalId:id,decision:z.literal('artwork_only')}).strict(),scopes:generate,paid:true},
  {name:'comex_preview_revision',action:'previewRevision',description:'Preview a story change and its full affected story before applying it. Preserve the creator’s instruction and the inspected panel version when available.',schema:z.object({...existing,panelId:id,instruction,reviewedVersion:z.object(version).strict().optional()}).strict(),scopes:generate,paid:true},
  {name:'comex_apply_revision',action:'applyRevision',description:'Apply only the current displayed revision proposal after explicit creator confirmation. This approves that proposed story and may redraw the affected continuation.',schema:z.object({...existing,proposalId:id}).strict(),scopes:generate,paid:true},
  {name:'comex_export_page',action:'exportPage',description:'Create a private page export. Export does not publish the comic.',schema:z.object({...existing,pageId:id}).strict(),scopes:write},
  {name:'comex_publish_comic',action:'publish',description:'Publish or republish only on explicit creator request. Supply the displayed edition ID, or null for a first publication.',schema:z.object({...existing,title:id,creator:z.string().trim().max(100),expectedEditionId:id.nullable()}).strict(),scopes:publish,destructive:true},
  {name:'comex_withdraw_comic',action:'withdraw',description:'Withdraw the displayed public edition only on explicit creator request; private drafts remain.',schema:z.object({...existing,expectedEditionId:id}).strict(),scopes:publish,destructive:true},
];

export function registerTools(server:McpServer,deps:ComexMcpDependencies,identity:McpIdentity,authorization:string | null) {
  const safe=(value:unknown)=>safeResult(value,identity,authorization);
  const hasScopes=(scopes:readonly ComexScope[])=>scopes.every(scope=>identity.scopes.includes(scope));
  const denied=()=>result('error','This connection does not have the required permission.',null,{code:'insufficient_scope',nextStep:'Reconnect with the required scope.'});
  const registerRead=(name:string,description:string,schema:z.ZodType,run:(args:Record<string,unknown>)=>Promise<ReturnType<typeof result>>)=>{
    server.registerTool(name,{description,inputSchema:schema,outputSchema:resultSchema,annotations:readAnnotation},async (args)=>{
      if (!hasScopes(['comex:read'])) return denied() as never;
      try{return await run(args as Record<string,unknown>) as never;}catch(error){return domainFailure(error) as never;}
    });
  };
  const imageResult=(image:{bytes:Uint8Array;mimeType:'image/png'},metadata:Record<string,unknown>)=>{
    if (!(image.bytes instanceof Uint8Array) || image.mimeType!=='image/png' || image.bytes.length<8 || ![137,80,78,71,13,10,26,10].every((byte,index)=>image.bytes[index]===byte)) throw new Error('Invalid image');
    if (image.bytes.length>10*1024*1024) return result('error','The image is too large for a chat preview.',null,{code:'asset_too_large',nextStep:'Open the comic in the editor to inspect this image.'});
    return result('ok','Private image preview.',safe({...metadata,mimeType:image.mimeType,bytes:image.bytes.length}),null,[{data:Buffer.from(image.bytes).toString('base64'),mimeType:image.mimeType}]);
  };
  registerRead('comex_list_styles','List the available style choices and descriptions.',z.object({}).strict(),async()=>{
    const catalog=await deps.reads.listStyles();
    return result('ok','Available comic styles.',safe({styles:catalog.styles.slice(0,50)}));
  });
  registerRead('comex_list_comics','List this owner’s draft comics without embedding images.',z.object({limit:z.number().int().min(1).max(50).optional(),cursor:id.optional()}).strict(),async args=>{
    const limit=Number(args.limit ?? 20);
    const list=await deps.reads.listComics(identity,{limit,...(typeof args.cursor==='string'?{cursor:args.cursor}:{})});
    const comics=list.comics.slice(0,limit).map(item=>{
      if (!item || typeof item!=='object') return null;
      const c=item as Record<string,unknown>;
      return {id:c.id,title:c.title,plot:c.plot,published:c.published};
    });
    return result('ok','Draft comics.',safe({comics,nextCursor:list.nextCursor ?? null}));
  });
  registerRead('comex_get_comic','Get the current owner’s draft, story beats and dialogue, questions, suggestions, findings, versions, pending choices and next steps.',z.object({comicId:id}).strict(),async args=>{
    const {comic}=await deps.reads.getComic(identity,String(args.comicId));
    return result('ok','Current comic and next steps.',safe({comic,editorUrl:deps.editorOrigin ? `${deps.editorOrigin}/comics/${encodeURIComponent(String(args.comicId))}` : `/comics/${encodeURIComponent(String(args.comicId))}`}));
  });
  registerRead('comex_get_operation','Inspect an owner-authorized operation and its current state; do not automatically retry an unknown outcome.',z.object({operationId:id}).strict(),async args=>{
    const operation=await deps.reads.getOperation(identity,String(args.operationId));
    const nextStep=operation.status==='unknown_outcome' ? 'Inspect and resolve this outcome; do not retry paid work automatically.' : operation.status==='queued' || operation.status==='running' ? 'Poll this operation again.' : operation.status==='needs_review' ? 'Inspect the current comic and review its pending decision.' : operation.status==='succeeded' ? 'Inspect the current comic and follow its next steps.' : 'Inspect the operation and current comic before deciding what to do.';
    return result(operation.status,'Current operation.',safe({...operation,nextStep}));
  });
  registerRead('comex_get_asset','Preview one private image belonging to this owner’s comic; images over 10 MiB must be reviewed in the editor.',z.object({comicId:id,assetId}).strict(),async args=>{
    const image=await deps.reads.getAsset(identity,String(args.comicId),String(args.assetId));
    return imageResult(image,{comicId:args.comicId,assetId:args.assetId});
  });
  registerRead('comex_get_export','Preview the private page produced by an owned export operation; this does not publish it.',z.object({operationId:id}).strict(),async args=>{
    return imageResult(await deps.reads.getExport(identity,String(args.operationId)),{operationId:args.operationId});
  });
  for (const definition of definitions) server.registerTool(definition.name,{
    description:definition.description,inputSchema:definition.schema,outputSchema:resultSchema,
    annotations:definition.destructive?destructiveAnnotation:definition.paid?paidAnnotation:mutationAnnotation,
  },async raw=>{
    if (!hasScopes(definition.scopes)) return denied() as never;
    try {
      const args=raw as Record<string,unknown>;
      const {requestKey:rawKey,comicId:rawComicId,expectedRevision:rawRevision,...input}=args;
      const pending=deps.operations.enqueue({identity,action:definition.action,requestKey:String(rawKey),...(typeof rawComicId==='string'?{comicId:rawComicId}:{}),...(typeof rawRevision==='number'?{expectedRevision:rawRevision}:{}),input});
      if (!pending || typeof pending.then!=='function') throw new Error('Durable dispatcher must return a promise');
      const ticket=ticketSchema.parse(await pending);
      return result(ticket.status,'Operation recorded. Inspect its status before continuing.',safe({operationId:ticket.id,...(ticket.comicId?{comicId:ticket.comicId,editorUrl:deps.editorOrigin ? `${deps.editorOrigin}/comics/${encodeURIComponent(ticket.comicId)}` : `/comics/${encodeURIComponent(ticket.comicId)}`}:{})})) as never;
    } catch(error){return domainFailure(error) as never;}
  });
}
