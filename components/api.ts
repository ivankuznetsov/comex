export class RequestError extends Error { constructor(message:string,readonly status:number) {super(message);} }
export async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { ...(init?.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...init?.headers }, cache: 'no-store' });
  let data: unknown;
  try { data = await response.json(); } catch { throw new Error(`The server returned an unexpected response (${response.status}).`); }
  if (!response.ok) {
    const error = data && typeof data === 'object' && 'error' in data ? String((data as { error: unknown }).error) : `Request failed (${response.status}).`;
    throw new RequestError(error,response.status);
  }
  return data as T;
}
export function errorMessage(error: unknown) { return error instanceof Error ? error.message : 'Something went wrong. Please try again.'; }

export type HostedOperationStatus = 'queued'|'running'|'succeeded'|'needs_review'|'failed'|'unknown_outcome'|'obsolete'|'revoked';
export type HostedOperation = {id:string;status:HostedOperationStatus;action:string;comicId?:string;result?:unknown;progress?:unknown;error?:unknown};
export type DiscoveredHostedOperation = {id:string;status:HostedOperationStatus;action:string;comicId?:string;expectedRevision?:number;pageId?:string;panelId?:string;characterId?:string};
export type HostedOperationInput = {action:string;comicId?:string;expectedRevision?:number;input:Record<string,unknown>};
export type SavedHostedOperation = HostedOperationInput & {workspaceId:string;requestKey:string;inputHash?:string;redacted?:boolean;id?:string;status?:HostedOperationStatus;progress?:unknown;error?:unknown};
export const hostedCreateKey='comex:active-create';
type BrowserComic = {id:string;revision:number;published?:boolean;publication?:{editionId?:string;title?:string;creator?:string}|null;pages:{id:string;generationPending?:boolean;panels:{imageUrl?:string|null;status?:string}[]}[]};
export function browserOperationFor(comic:BrowserComic,path:string,body:unknown,method:string):HostedOperationInput {
  const parts=path.split('/').filter(Boolean).map(decodeURIComponent);
  const input=(body && typeof body==='object' ? body : {}) as Record<string,unknown>;
  let action:string,values:Record<string,unknown>={...input};
  if(!parts.length && method==='PATCH')action='update';
  else if(parts[0]==='questions')action=parts[1]==='initial'?'initialQuestions':'refreshQuestions';
  else if(parts[0]==='characters' && parts[1]==='suggestions')action='suggestCharacters';
  else if(parts[0]==='characters' && parts.length===1)action='addCharacter';
  else if(parts[0]==='characters' && parts.length>=2) {
    values={...input,characterId:parts[1]};
    action=parts[2]==='reference'?'generateReference':parts[2]==='approve'?'approveCharacter':method==='DELETE'?'removeCharacter':'editCharacter';
  } else if(parts[0]==='story') {
    action=parts[1]==='plan'?'planStory':parts[1]==='approve'?'approveStory':'acceptStoryReview';
    if(action==='approveStory') {const {revision:ignored,...rest}=values;void ignored;values=rest;}
  } else if(parts[0]==='pages' && parts[2]==='download') {
    if(!comic.pages.some(item=>item.id===parts[1]))throw new Error('The page is no longer available.');
    action='exportPage';values={pageId:parts[1]};
  } else if(parts[0]==='pages' && parts[2]==='generate') {
    const page=comic.pages.find(item=>item.id===parts[1]);if(!page)throw new Error('The page is no longer available.');
    const anyImage=page.panels.some(panel=>!!panel.imageUrl);
    const incomplete=page.panels.some(panel=>!panel.imageUrl || ['planned','outdated','checking'].includes(panel.status ?? ''));
    values={pageId:page.id,intent:page.generationPending || (anyImage && incomplete)?'resume':anyImage?'regenerate':'generate'};action='generatePage';
  } else if(parts[0]==='panels' && parts.length===3) {values={...input,panelId:parts[1]};action=parts[2]==='accept'?'acceptPanel':'editPanel';}
  else if(parts[0]==='revisions')action=parts[1]==='preview'?'previewRevision':'applyRevision';
  else if(parts[0]==='publish' || parts[0]==='unpublish') {
    const editionId=comic.publication?.editionId ?? null;
    if(comic.published && !editionId)throw new Error('The current edition is unavailable. Refresh before changing publication.');
    if(parts[0]==='unpublish' && !editionId)throw new Error('There is no current edition to withdraw.');
    values={...input,expectedEditionId:editionId};action=parts[0]==='publish'?'publish':'withdraw';
  } else throw new Error('This editor action is not available.');
  return {action,comicId:comic.id,expectedRevision:comic.revision,input:values};
}
const operationPrefix='comex:browser-operation:';
const dismissedPrefix='comex:dismissed-operation:';
const workspaceMarker='comex:browser-workspace';
type Workspace = {id:string|null;epoch:string};
type BrowserSession = {user:{email:string}|null;guest?:{email:string}|null;workspaceId?:string|null};
let activeWorkspace:Workspace | null=null;
const workspaceListeners=new Set<()=>void>();
const operationKey=(workspaceId:string,key:string)=>operationPrefix+encodeURIComponent(workspaceId)+':'+encodeURIComponent(key);
const marker=():Workspace|null=>{try {const value=localStorage.getItem(workspaceMarker);return value ? JSON.parse(value) as Workspace : null;} catch {return null;}};
const sameWorkspace=(a:Workspace|null,b:Workspace|null)=>!!a && !!b && a.id===b.id && a.epoch===b.epoch;
function context():Workspace & {id:string} {
  if(!activeWorkspace?.id || !sameWorkspace(activeWorkspace,marker()))throw new Error('Your workspace changed. Refresh before continuing.');
  return activeWorkspace as Workspace & {id:string};
}
function safeInput(input:Record<string,unknown>|undefined):Record<string,unknown> {
  return Object.fromEntries(['pageId','panelId','characterId'].filter(key=>typeof input?.[key]==='string').map(key=>[key,input![key]]));
}
function redactOtherWorkspaces(current:string|null) {
  for(let i=0;i<localStorage.length;i++) {
    const key=localStorage.key(i);if(!key?.startsWith(operationPrefix))continue;
    try {
      const entry=JSON.parse(localStorage.getItem(key) ?? 'null') as SavedHostedOperation | null;
      if(!entry || !entry.workspaceId || entry.workspaceId!==current) {
        if(!entry || typeof entry.action!=='string' || typeof entry.requestKey!=='string'){localStorage.removeItem(key);i--;continue;}
        const {progress:_,error:__,input,...receipt}=entry;void _;void __;
        localStorage.setItem(key,JSON.stringify({...receipt,input:safeInput(input),redacted:true}));
      }
    } catch {localStorage.removeItem(key);i--;}
  }
}
/** A marker change fences late responses in every tab before private data is cleared. */
export function activateHostedWorkspace(id:string|null):void {
  const previous=marker();
  const next=previous?.id===id ? previous : {id,epoch:crypto.randomUUID()};
  if(!sameWorkspace(previous,next))localStorage.setItem(workspaceMarker,JSON.stringify(next));
  redactOtherWorkspaces(id);
  const changed=!!activeWorkspace?.id && !sameWorkspace(activeWorkspace,next);
  activeWorkspace=next;
  if(changed)for(const listener of workspaceListeners)listener();
}
export function clearHostedWorkspace():void {activateHostedWorkspace(null);}
export function subscribeHostedWorkspace(listener:()=>void):()=>void {
  workspaceListeners.add(listener);
  const onStorage=(event:StorageEvent)=>{if(event.key===workspaceMarker && activeWorkspace && !sameWorkspace(activeWorkspace,marker()))listener();};
  if(typeof window!=='undefined')window.addEventListener('storage',onStorage);
  return ()=>{workspaceListeners.delete(listener);if(typeof window!=='undefined')window.removeEventListener('storage',onStorage);};
}
export async function hostedSession(required=true):Promise<BrowserSession> {
  for(let attempt=0;attempt<2;attempt++) {
    const before=localStorage.getItem(workspaceMarker),session=await request<BrowserSession>('/api/auth/session');
    if(before!==localStorage.getItem(workspaceMarker))continue;
    if(!('workspaceId' in session)) {if(required)throw new Error('The hosted workspace is unavailable.');return session;}
    activateHostedWorkspace(session.workspaceId ?? null);return session;
  }
  throw new Error('Your workspace changed. Refresh before continuing.');
}
export function hostedWorkspaceFence():()=>void {
  const workspace=context();
  return ()=>{if(!sameWorkspace(workspace,marker()))throw new Error('Your workspace changed. Refresh before continuing.');};
}
export function hostedGuestFence():()=>void {
  const workspace=activeWorkspace;
  if(!workspace || workspace.id!==null || !sameWorkspace(workspace,marker()))throw new Error('Your workspace changed. Refresh before continuing.');
  return ()=>{if(!sameWorkspace(workspace,marker()))throw new Error('Your workspace changed. Refresh before continuing.');};
}
function storeOperation(entry:SavedHostedOperation,expected=context()) {
  if(entry.workspaceId!==expected.id || !sameWorkspace(expected,marker()))throw new Error('Your workspace changed. Refresh before continuing.');
  localStorage.setItem(operationKey(entry.workspaceId,entry.requestKey),JSON.stringify(entry));
}
function savedOperation(key:string,workspace=context()):SavedHostedOperation | null {
  const value=localStorage.getItem(operationKey(workspace.id,key));
  if(!value)return null;
  try {const parsed=JSON.parse(value) as SavedHostedOperation;return parsed && parsed.workspaceId===workspace.id && parsed.requestKey===key && typeof parsed.action==='string' && parsed.input && typeof parsed.input==='object' ? parsed : null;} catch {return null;}
}
function canonical(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value && typeof value==='object')return '{'+Object.entries(value as Record<string,unknown>).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
  return JSON.stringify(value) ?? 'null';
}
async function inputHash(input:Record<string,unknown>):Promise<string> {
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(input)));
  return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
}
/** Pending requests are saved before dispatch so a lost response reuses the same idempotency key. */
export function pendingHostedOperations(comicId?:string):SavedHostedOperation[] {
  let workspace:Workspace & {id:string};try {workspace=context();} catch {return [];}
  const entries:SavedHostedOperation[]=[];
  for(let i=0;i<localStorage.length;i++) {
    const key=localStorage.key(i);
    if(!key?.startsWith(operationPrefix))continue;
    let entry:SavedHostedOperation|null=null;
    try {entry=JSON.parse(localStorage.getItem(key) ?? 'null') as SavedHostedOperation|null;} catch {continue;}
    if(!entry || entry.workspaceId!==workspace.id || key!==operationKey(workspace.id,entry.requestKey))continue;
    if(entry && (comicId===undefined || entry.comicId===comicId))entries.push(entry);
  }
  return entries;
}
export function forgetHostedOperation(entry:SavedHostedOperation):void {
  const workspace=context();if(entry.workspaceId!==workspace.id)return;
  if(entry.id && ['failed','obsolete','revoked'].includes(entry.status ?? ''))localStorage.setItem(dismissedPrefix+workspace.id+':'+entry.id,'1');
  localStorage.removeItem(operationKey(workspace.id,entry.requestKey));
}
export function associateHostedOperation(entry:SavedHostedOperation,comicId:string):void {storeOperation({...entry,comicId});}
/** Discovery returns safe identifiers only, never the original private input. */
export function rememberHostedOperation(operation:DiscoveredHostedOperation):SavedHostedOperation | null {
  const workspace=context();
  if(['failed','obsolete','revoked'].includes(operation.status) && localStorage.getItem(dismissedPrefix+workspace.id+':'+operation.id))return null;
  const previous=pendingHostedOperations().find(item=>item.id===operation.id);
  const input={...(operation.pageId?{pageId:operation.pageId}:{}),...(operation.panelId?{panelId:operation.panelId}:{}),...(operation.characterId?{characterId:operation.characterId}:{})};
  const entry:SavedHostedOperation=previous ? {...previous,status:operation.status} : {workspaceId:workspace.id,requestKey:`discovered:${operation.id}`,id:operation.id,action:operation.action,status:operation.status,comicId:operation.comicId,expectedRevision:operation.expectedRevision,input};
  storeOperation(entry);return entry;
}
export async function startHostedOperation(input:HostedOperationInput,requestKey=crypto.randomUUID(),expectedWorkspaceId?:string):Promise<SavedHostedOperation> {
  const workspace=context(),previous=savedOperation(requestKey,workspace);
  if((expectedWorkspaceId && expectedWorkspaceId!==workspace.id) || ('workspaceId' in input && input.workspaceId!==workspace.id))throw new Error('Your workspace changed. Refresh before continuing.');
  if(previous?.redacted)return recoverHostedOperation(previous,input);
  if(previous && (previous.action!==input.action || previous.comicId!==input.comicId || canonical(previous.input)!==canonical(input.input))) throw new Error('This request key belongs to a different action.');
  const hash=previous?.inputHash ?? await inputHash(input.input);
  const entry:SavedHostedOperation=previous ?? {...input,workspaceId:workspace.id,requestKey,inputHash:hash};
  if(entry.id)return entry;
  storeOperation(entry,workspace);
  const ticket=await request<{id:string;status:HostedOperationStatus;comicId?:string}>('/api/operations',{method:'POST',body:JSON.stringify({action:entry.action,requestKey:entry.requestKey,expectedWorkspaceId:workspace.id,...(entry.comicId?{comicId:entry.comicId}:{}),...(entry.expectedRevision!==undefined?{expectedRevision:entry.expectedRevision}:{}),input:entry.input})});
  const saved={...entry,id:ticket.id,status:ticket.status,...(ticket.comicId?{comicId:ticket.comicId}:{})};
  storeOperation(saved,workspace);return saved;
}
/** Resolve redacted receipts by key before permitting an exact, deliberate retry. */
export async function recoverHostedOperation(entry:SavedHostedOperation,reentered?:HostedOperationInput):Promise<SavedHostedOperation> {
  const workspace=context();if(entry.workspaceId!==workspace.id)throw new Error('Your workspace changed. Refresh before continuing.');
  if(reentered && (entry.action!==reentered.action || entry.comicId!==reentered.comicId || !entry.inputHash || entry.inputHash!==await inputHash(reentered.input)))throw new Error('The re-entered input does not match the original request.');
  if(entry.id)return entry;
  if(!entry.redacted)return startHostedOperation(entry,entry.requestKey);
  try {
    const found=await request<{operation:DiscoveredHostedOperation}>(`/api/operations?requestKey=${encodeURIComponent(entry.requestKey)}&action=${encodeURIComponent(entry.action)}`);
    const saved={...entry,id:found.operation.id,status:found.operation.status,...(found.operation.comicId?{comicId:found.operation.comicId}:{})};
    storeOperation(saved,workspace);return saved;
  } catch(error) {if(!(error instanceof RequestError && error.status===404))throw error;}
  if(!reentered)throw new Error('Re-enter the original input to retry this request.');
  const restored={...entry,input:reentered.input,redacted:false};storeOperation(restored,workspace);
  return startHostedOperation(restored,entry.requestKey);
}
/** This only reads a known operation. An unknown paid outcome is never re-enqueued. */
export async function readHostedOperation(entry:SavedHostedOperation,signal?:AbortSignal):Promise<HostedOperation> {
  const workspace=context();if(entry.workspaceId!==workspace.id)throw new Error('Your workspace changed. Refresh before continuing.');
  const current=savedOperation(entry.requestKey,workspace) ?? entry;
  if(!current.id)throw new Error('The request has no operation ID yet. Retry the same request to find it.');
  const operation=await request<HostedOperation>(`/api/operations/${encodeURIComponent(current.id)}`,{signal});
  storeOperation({...current,status:operation.status,progress:operation.progress,error:operation.error,...(operation.comicId?{comicId:operation.comicId}:{})},workspace);
  return operation;
}
export async function waitForHostedOperation(entry:SavedHostedOperation,onProgress?:(operation:HostedOperation)=>void,signal?:AbortSignal):Promise<HostedOperation> {
  while(true) {
    if(signal?.aborted)throw new DOMException('Polling stopped','AbortError');
    const operation=await readHostedOperation(entry,signal);onProgress?.(operation);
    if(operation.status!=='queued' && operation.status!=='running')return operation;
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},1500);
      const abort=()=>{clearTimeout(timer);reject(new DOMException('Polling stopped','AbortError'));};
      signal?.addEventListener('abort',abort,{once:true});
      if(signal?.aborted)abort();
    });
  }
}
