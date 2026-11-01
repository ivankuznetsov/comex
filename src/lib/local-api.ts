import {randomUUID, randomBytes, randomInt} from 'node:crypto';
import {resolve} from 'node:path';
import {mkdir, open, readFile, unlink} from 'node:fs/promises';
import {NextRequest, NextResponse} from 'next/server';
import {z} from 'zod';
import {createAIService, AIError, type Reference, type Storyboard} from './ai/service';
import {LocalStore, ClaimInProgressError, type PageJob} from './local-store';
import {createBudgetedFetch, BudgetError} from './budget';
import {createComicService} from './application/comics';
import {ApplicationError, createSchema, parse, type Draft} from './application/contracts';
import {sameJson} from './application/json';
import {isPanelReady, isPanelReviewed, type Panel} from './domain/comic';
import {view as comicView} from './application/views';
import type {PostgresAuth} from './storage/auth';
export {validateStoryLedger} from './application/comics';

class HttpError extends Error { constructor(readonly status:number, message:string) { super(message); } }
const globalStore = globalThis as typeof globalThis & { __comexLocalStore?: LocalStore };
const getStore = () => globalStore.__comexLocalStore ??= new LocalStore(process.env.COMEX_DB_PATH || resolve(process.cwd(), 'data/comex.sqlite'));
function reply(data: unknown, status = 200) { return NextResponse.json(data, {status, headers: {'Cache-Control': 'no-store'}}); }
function publicPageJob(job:PageJob|null,draft?:Draft) {
  if(!job)return null;
  const baseline=draft?.pageOperations?.[job.pageId]?.baseline,panels=draft?.pages.find(page=>page.id===job.pageId)?.panels ?? [];
  return {id:job.id,pageId:job.pageId,state:job.state,message:job.message,createdAt:job.createdAt,
    completed:baseline?panels.filter(panel=>baseline[panel.id]!==undefined && panel.revision>baseline[panel.id]).length:0,
    total:baseline?Object.keys(baseline).length:panels.length};
}
type BrowserAuthStore = LocalStore | PostgresAuth;
export type BrowserBackend = {
  auth: BrowserAuthStore;
  service: ReturnType<typeof createComicService>;
  validateRequest(request: NextRequest): boolean;
  workspaceId(owner:string):string;
};
async function owner(request: NextRequest, store: BrowserAuthStore): Promise<string | null> {
  const authenticated = request.cookies.get('comex_auth')?.value;
  if (authenticated && /^[a-f0-9]{64}$/.test(authenticated)) {
    const identity = await store.authIdentity(authenticated);
    if (identity) return identity.owner;
  }
  const guest=request.cookies.get('comex_session')?.value;
  if (!guest || !/^[a-f0-9]{64}$/.test(guest)) return null;
  const identity=await store.guestIdentity(guest);
  if (identity) return identity.owner;
  // Existing drafts used the original random browser cookie as their owner.
  // Do not revive expired guests or treat current internal owner IDs as cookies.
  return !await store.hasGuestToken(guest) && await store.hasLegacyOwner(guest) ? guest : null;
}
function assertMutation(request: NextRequest) {
  const origin = request.headers.get('origin');
  if (origin) {
    let supplied: URL;
    try { supplied = new URL(origin); } catch { throw new HttpError(403, 'Cross-origin requests are not allowed.'); }
    const host = request.headers.get('host') ?? request.nextUrl.host;
    if (supplied.host !== host || supplied.protocol !== request.nextUrl.protocol) throw new HttpError(403, 'Cross-origin requests are not allowed.');
  }
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Send JSON data.');
}
async function input<T>(request: NextRequest, schema: z.ZodType<T>): Promise<T> {
  assertMutation(request);
  const text = await request.text();
  if (Buffer.byteLength(text, 'utf8') > 32_000) throw new HttpError(413, 'Request is too large.');
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw new HttpError(400, 'Invalid JSON.'); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, 'Please check the supplied fields.');
  return parsed.data;
}
const assetRoot = () => resolve(process.env.COMEX_ASSET_PATH || resolve(process.cwd(), 'data/assets'));
async function saveAsset(bytes: Buffer): Promise<string> {
  const id = randomUUID(); await mkdir(assetRoot(), {recursive: true});
  const path = resolve(assetRoot(), `${id}.png`);
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(bytes); await file.close(); }
  catch (error) { await file.close().catch(() => {}); await unlink(path).catch(() => {}); throw error; }
  return id;
}
async function discardAsset(id: string): Promise<void> {
  await unlink(resolve(assetRoot(), `${id}.png`)).catch(() => {});
}
async function asset(id: string): Promise<Buffer> {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new ApplicationError('not_found', 'Image not found.');
  try { return await readFile(resolve(assetRoot(), `${id}.png`)); } catch { throw new ApplicationError('not_found', 'Image not found.'); }
}
function ensureLocal(request: NextRequest) {
  const rawHost = request.headers.get('host') ?? request.nextUrl.host;
  let parsedHost: URL;
  try { parsedHost = new URL(`${request.nextUrl.protocol}//${rawHost}`); } catch { throw new HttpError(403, 'Invalid local host.'); }
  const validHost = ['localhost','127.0.0.1','[::1]'].includes(parsedHost.hostname) && !parsedHost.username && !parsedHost.password && parsedHost.host === rawHost && parsedHost.port === request.nextUrl.port;
  if (process.env.VERCEL || !validHost) throw new HttpError(403, 'Local storage is available only on localhost.');
}
function panelReviewKey(panel:Panel):string {return `panel:${panel.id}:${panel.assetId}:${panel.storyRevision}:${panel.revision}`;}
function advisoryProvider() {
  return createAIService({fetch:createBudgetedFetch(process.env.COMEX_BUDGET_DB_PATH || process.env.COMEX_DB_PATH || resolve(process.cwd(),'data/comex.sqlite'))});
}
function scheduleNarrativeReview(store:LocalStore,draft:Draft) {
  const runId=(draft as Draft & {storyReviewRunId?:string}).storyReviewRunId,storyboard=draft.storyboard;
  if(!runId || !storyboard)return;
  void (async()=>{
    let review:unknown;
    try {
      const answers=Object.fromEntries(draft.questions.filter(question=>draft.answers[question.id]?.trim()).map(question=>[question.question,draft.answers[question.id].trim()]));
      review=await advisoryProvider().narrativeJudge({creatorGoal:draft.plot,answers,bible:storyboard.bible,beats:storyboard.pages});
    } catch {review={outcome:'failed',findings:[]};}
    const latest=store.getReviewTarget<Draft & {storyReviewRunId?:string}>(draft.id);
    if(!latest || latest.data.storyReviewRunId!==runId || latest.data.storyRevision!==draft.storyRevision || !sameJson(latest.data.storyboard,storyboard))return;
    store.putAdvisoryReview(draft.id,latest.owner,`story:${runId}:${draft.storyRevision}`,review);
  })().catch(()=>{});
}
function scheduleVisualReview(store:LocalStore,input:{draft:Draft;panelId:string;assetId:string;panelRevision:number;bible:Storyboard['bible'];styleRules:string;beats:Omit<Storyboard['pages'][number]['panels'][number],'dialogue'>;references:Reference[]}) {
  void (async()=>{
    let findings:unknown[]=[],outcome='failed';
    try {
      const result=await advisoryProvider().visualJudge({bible:input.bible,styleRules:input.styleRules,beats:input.beats,references:[...input.references,{role:'generated panel',id:input.panelId,bytes:await asset(input.assetId),mimeType:'image/png'}]});
      findings=result.findings;outcome=result.outcome;
    } catch { /* Retain the generated image with an incomplete review. */ }
    const latest=store.getReviewTarget<Draft>(input.draft.id);
    if(!latest || latest.data.storyRevision!==input.draft.storyRevision)return;
    const panel=latest.data.pages.flatMap(page=>page.panels).find(item=>item.id===input.panelId);
    if(!panel || panel.assetId!==input.assetId || panel.storyRevision!==input.draft.storyRevision || panel.revision!==input.panelRevision || panel.status!=='checking')return;
    store.putAdvisoryReview(input.draft.id,latest.owner,panelReviewKey(panel),{outcome,findings});
  })().catch(()=>{});
}
/** Overlay only reviews tied to the current story and image; never mutate persisted draft data. */
function resolveAdvisory(store:LocalStore,draft:Draft):Draft {
  const runId=(draft as Draft & {storyReviewRunId?:string}).storyReviewRunId;
  const story=runId ? store.getAdvisoryReview(draft.id,`story:${runId}:${draft.storyRevision}`) : null;
  const panelReviews={...draft.panelReviews},panelFindings={...draft.panelFindings};
  const pages=draft.pages.map(page=>({...page,panels:page.panels.map(panel=>{
    if(!panel.assetId || panel.storyRevision!==draft.storyRevision || panel.status==='outdated')return panel;
    const review=store.getAdvisoryReview<{outcome:'pass'|'findings'|'inconclusive'|'failed';findings:{severity?:string}[]}>(draft.id,panelReviewKey(panel));
    if(!review)return panel;
    panelReviews[panel.id]={assetId:panel.assetId,storyRevision:panel.storyRevision,panelRevision:panel.revision,outcome:review.outcome};
    panelFindings[panel.id]=review.findings;
    if(panel.status!=='checking')return panel;
    const evaluation:Panel['evaluation']=review.findings.some(f=>f.severity==='blocker')?'blocker':review.findings.some(f=>f.severity==='warning')?'warning':review.outcome==='pass'?'pass':'uncertain';
    return {...panel,evaluation,status:evaluation==='pass'?'current' as const:'needs_review' as const};
  })}));
  return {...draft,...(story?{storyReview:story}:{}),pages,panelReviews,panelFindings};
}
function localResult<T>(result:T,store:LocalStore,owner:string,id:string):T {
  if(!result || typeof result!=='object' || !('comic' in result))return result;
  const comic=(result as {comic:any}).comic,record=store.getOwned<Draft & {storyReviewRunId?:string}>(id,owner);
  if(!comic || !record)return result;
  const draft=resolveAdvisory(store,record.data);
  const projected=comicView(draft,store.getPublished(id),record.revision);
  return {...result,comic:{...projected,activePageJob:publicPageJob(store.activePageJob(id,owner),draft)}} as T;
}
function serviceFor(store:LocalStore) {
  const dependencies={
    repository:store, assets:{read:asset,save:saveAsset,discard:discardAsset}, provider:createAIService, id:randomUUID,
    budgetFetch:(input:string|URL|Request,init?:RequestInit) => createBudgetedFetch(process.env.COMEX_BUDGET_DB_PATH || process.env.COMEX_DB_PATH || resolve(process.cwd(),'data/comex.sqlite'))(input,init),
    advisory:{resolve:(draft:Draft)=>resolveAdvisory(store,draft),narrative:(draft:Draft)=>scheduleNarrativeReview(store,draft),visual:(input:Parameters<typeof scheduleVisualReview>[1])=>scheduleVisualReview(store,input)},
  };
  return createComicService(dependencies);
}
function imageResponse(bytes:Uint8Array, filename?:string) {
  return new NextResponse(new Uint8Array(bytes),{headers:{'Content-Type':'image/png',...(filename ? {'Content-Disposition':`attachment; filename="comex-page-${encodeURIComponent(filename)}.png"`} : {}),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
}
export async function handleApi(request:NextRequest,segments:string[],backend?:BrowserBackend) {
  try {
    if (backend) {
      if (!backend.validateRequest(request)) throw new HttpError(403, 'Invalid application host.');
    } else ensureLocal(request);
    const store=backend?.auth ?? getStore();
    const method=request.method;
    if (segments[0] === 'auth') {
      if (segments.length === 2 && segments[1] === 'session' && method === 'GET') {
        const token = request.cookies.get('comex_auth')?.value;
        const identity = token && /^[a-f0-9]{64}$/.test(token) ? await store.authIdentity(token) : null;
        const guestToken=request.cookies.get('comex_session')?.value;
        const guest=guestToken && /^[a-f0-9]{64}$/.test(guestToken) ? await store.guestIdentity(guestToken) : null;
        const effective=identity?.owner ?? guest?.owner ?? (backend ? await owner(request,store) : null);
        let signInAvailable=false;
        try {const url=new URL(process.env.COMEX_APP_URL || '');signInAvailable=url.origin===`${request.nextUrl.protocol}//${request.headers.get('host') ?? request.nextUrl.host}` && !!process.env.RESEND_API_KEY && !!process.env.COMEX_EMAIL_FROM && (process.env.COMEX_AUTH_SECRET?.length??0)>=32;} catch { /* Email delivery has not been configured. */ }
        return reply({user: identity ? {email: identity.email} : null, guest:guest ? {email:guest.email} : null,signInAvailable,...(backend ? {workspaceId:effective ? backend.workspaceId(effective) : null} : {})});
      }
      // Require Origin for these endpoints; never derive an email link from the Host header.
      const requestOrigin = `${request.nextUrl.protocol}//${request.headers.get('host') ?? request.nextUrl.host}`;
      if (method === 'POST' && (!request.headers.get('origin') || request.headers.get('origin') !== requestOrigin)) throw new HttpError(403, 'Cross-origin requests are not allowed.');
      if (backend && segments.length === 2 && segments[1] === 'guest' && method === 'POST') {
        const {email:rawEmail}=await input(request,z.object({email:z.string().trim().email().max(254).optional()}).strict());
        const existing=await owner(request,store);
        if (existing) return reply({ok:true,workspaceId:backend.workspaceId(existing)});
        const at=rawEmail?.lastIndexOf('@') ?? -1;
        const guest=await store.createGuest(rawEmail ? `${rawEmail.slice(0,at)}@${rawEmail.slice(at+1).toLowerCase()}` : '');
        const response=reply({ok:true,workspaceId:backend.workspaceId(guest.owner)});
        response.cookies.set('comex_session',guest.token,{httpOnly:true,sameSite:'strict',secure:request.nextUrl.protocol==='https:',path:'/',maxAge:30*24*60*60});
        return response;
      }
      if (segments.length === 2 && segments[1] === 'request' && method === 'POST') {
        const {email: rawEmail,claimGuest} = await input(request, z.object({email:z.string().trim().email().max(254),claimGuest:z.boolean().optional()}).strict());
        const at = rawEmail.lastIndexOf('@');
        const email = `${rawEmail.slice(0,at)}@${rawEmail.slice(at+1).toLowerCase()}`;
        const configuredUrl=process.env.COMEX_APP_URL, apiKey=process.env.RESEND_API_KEY, from=process.env.COMEX_EMAIL_FROM, secret=process.env.COMEX_AUTH_SECRET;
        if (!configuredUrl || !apiKey || !from || !secret || secret.length<32) throw new HttpError(503,'Email sign-in is not configured yet.');
        let base:URL;
        try {base=new URL(configuredUrl);} catch {throw new HttpError(503,'Email sign-in is not configured yet.');}
        if ((base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(base.hostname))) || base.username || base.password || base.pathname !== '/' || base.search || base.hash || base.origin !== requestOrigin) throw new HttpError(503,'Email sign-in is not configured for this address.');
        const existingBrowser=request.cookies.get('comex_login')?.value;
        const browser=existingBrowser && /^[a-f0-9]{64}$/.test(existingBrowser) ? existingBrowser : randomBytes(32).toString('hex');
        const guestToken=request.cookies.get('comex_session')?.value;
        const validGuestToken=guestToken && /^[a-f0-9]{64}$/.test(guestToken) ? guestToken : null;
        // An explicit choice from the browser owning the guest cookie permits
        // correcting its email; account access still requires the emailed code.
        if (claimGuest && (!validGuestToken || !await store.updateGuestEmail(validGuestToken,email))) throw new HttpError(409,'This browser draft session has expired.');
        const guestIdentity=validGuestToken ? await store.guestIdentity(validGuestToken) : null;
        const mayClaim=!!validGuestToken && (guestIdentity ? guestIdentity.email===email : !await store.hasGuestToken(validGuestToken) && await store.hasLegacyOwner(validGuestToken));
        // The existing guest cookie is stable across simultaneous requests,
        // unlike login cookies whose responses can arrive out of order.
        const claimProof=mayClaim ? validGuestToken! : browser;
        const code=randomInt(100000000).toString().padStart(8,'0');
        const issued=await store.issueCode(email,code,claimProof,secret);
        if (!issued) throw new HttpError(429,'Too many sign-in requests. Please try again later.');
        let delivered=false, knownRejected=false;
        try {
          const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},body:JSON.stringify({from,to:[email],subject:'Your Comex sign-in code',text:`Your Comex sign-in code is ${code}. It expires in 15 minutes.\n\nIf you did not request it, ignore this email.`})});
          delivered=response.ok;
          knownRejected=response.status>=400 && response.status<500 && response.status!==408;
        } catch { /* Never log credentials or codes. */ }
        if (!delivered) {await store.invalidateCode(email,issued,knownRejected);throw new HttpError(502,'Could not send the sign-in email. Please try again.');}
        const response=reply({message:'If the address can receive email, a sign-in code is on its way.'});
        response.cookies.set('comex_login',browser,{httpOnly:true,sameSite:'lax',secure:base.protocol==='https:',path:'/',maxAge:15*60});
        return response;
      }
      if (segments.length === 2 && segments[1] === 'verify' && method === 'POST') {
        const {email:rawEmail,code}=await input(request,z.object({email:z.string().trim().email().max(254),code:z.string().regex(/^\d{8}$/)}).strict());
        const at=rawEmail.lastIndexOf('@'); const email=`${rawEmail.slice(0,at)}@${rawEmail.slice(at+1).toLowerCase()}`;
        const secret=process.env.COMEX_AUTH_SECRET;
        if (!secret || secret.length<32) throw new HttpError(503,'Email sign-in is not configured yet.');
        const browser=request.cookies.get('comex_login')?.value, guest=request.cookies.get('comex_session')?.value;
        const validGuest=guest && /^[a-f0-9]{64}$/.test(guest) ? guest : null;
        const identity=validGuest ? await store.guestIdentity(validGuest) : null;
        const anonymous=validGuest ? identity ? identity.email===email ? identity.owner : null : !await store.hasGuestToken(validGuest) && await store.hasLegacyOwner(validGuest) ? validGuest : null : null;
        const claimProof=anonymous && validGuest ? validGuest : browser && /^[a-f0-9]{64}$/.test(browser) ? browser : null;
        const result=await store.consumeCode(email,code,secret,claimProof,anonymous);
        if (!result) throw new HttpError(400,'This code is invalid, expired, or has already been used. Request a new code.');
        const response=reply({user:{email:result.email}});
        response.cookies.set('comex_auth',result.session,{httpOnly:true,sameSite:'lax',secure:request.nextUrl.protocol==='https:',path:'/',maxAge:30*24*60*60});
        if (result.sameBrowser) {
          response.cookies.set('comex_login','',{httpOnly:true,sameSite:'lax',secure:request.nextUrl.protocol==='https:',path:'/',maxAge:0});
          if (anonymous) response.cookies.set('comex_session','',{httpOnly:true,sameSite:'strict',secure:request.nextUrl.protocol==='https:',path:'/',maxAge:0});
        }
        return response;
      }
      if (segments.length === 2 && segments[1] === 'sign-out' && method === 'POST') {
        await input(request,z.object({}).strict());
        const token = request.cookies.get('comex_auth')?.value;
        if (token && /^[a-f0-9]{64}$/.test(token)) await store.signOut(token);
        const response = reply({ok:true});
        response.cookies.set('comex_auth','',{httpOnly:true,sameSite:'lax',secure:request.nextUrl.protocol === 'https:',path:'/',maxAge:0});
        return response;
      }
      throw new HttpError(404, 'Not found.');
    }
    const service=backend?.service ?? serviceFor(store as LocalStore);
    if (segments[0] === 'published' && method === 'GET') {
      if (segments.length === 4 && segments[2] === 'assets') return imageResponse(await service.getPublishedAsset(segments[1],segments[3],request.nextUrl.searchParams.get('edition')));
      if (segments.length === 1) return reply(await service.listPublished());
      if (segments.length === 2) return reply(await service.getPublished(segments[1]));
    }
    if (segments[0] !== 'comics') throw new HttpError(404,'Not found.');
    if (segments.length === 1 && method === 'GET') {
      const session=await owner(request,store);
      if (!session) {
        if(request.cookies.has('comex_session') || request.cookies.has('comex_auth'))throw new HttpError(401,'This browser session has expired.');
        return reply({comics:[]});
      }
      return reply(await service.list(session));
    }
    if (segments.length === 1 && method === 'POST') {
      const body=parse(await input(request,z.unknown()),createSchema);
      let session=await owner(request,store); let guestToken:string | null=null;
      if (!session) {
        const at=body.email?.lastIndexOf('@') ?? -1; const email=body.email ? `${body.email.slice(0,at)}@${body.email.slice(at+1).toLowerCase()}` : '';
        const guest=await store.createGuest(email); session=guest.owner; guestToken=guest.token;
      }
      const response=reply(await service.create(session,body),201);
      if (guestToken) response.cookies.set('comex_session',guestToken,{httpOnly:true,sameSite:'strict',secure:request.nextUrl.protocol==='https:',path:'/',maxAge:30*24*60*60});
      return response;
    }
    if (segments.length < 2) throw new HttpError(404,'Not found.');
    const id=segments[1], session=await owner(request,store);
    if (!session) throw new HttpError(404,'Comic not found.');
    if (segments.length === 2 && method === 'GET') {
      const result=await service.get(session,id);
      return reply(backend ? result : localResult(result,store as LocalStore,session,id));
    }
    const current=await service.get(session,id);
    const {comic:initial}=backend ? current : localResult(current,store as LocalStore,session,id);
    const respond=<T>(result:T,status=200)=>reply(backend ? result : localResult(result,store as LocalStore,session,id),status);
    const pageStart=segments[2]==='pages' && segments.length===5 && ['generate','generate-async'].includes(segments[4]);
    const draftPatch=method==='PATCH' && segments.length===2;
    if(!backend && ['POST','PATCH','DELETE'].includes(method) && !pageStart && !draftPatch && (store as LocalStore).hasActivePageJob(id,session))
      throw new HttpError(409,'Wait for the page job to finish or resolve its unknown outcome before changing this draft.');
    if (segments[2] === 'assets' && segments.length === 4 && method === 'GET') return imageResponse(await service.getAsset(session,id,segments[3]));
    if (segments[2] === 'pages' && segments.length === 5 && segments[4] === 'download' && method === 'GET') return imageResponse(await service.downloadPage(session,id,segments[3],initial.revision),segments[3]);
    const body = async () => input(request,z.unknown());
    if (segments.length === 2 && method === 'PATCH') return respond(await service.update(session,id,await body(),initial.revision));
    if (segments[2] === 'questions' && segments[3] === 'initial' && segments.length === 4 && method === 'POST') return respond(await service.initialQuestions(session,id,await body(),initial.revision));
    if (segments[2] === 'questions' && segments.length === 3 && method === 'POST') return respond(await service.refreshQuestions(session,id,await body(),initial.revision));
    if (segments[2] === 'characters' && segments[3] === 'suggestions' && segments.length === 4 && method === 'POST') return respond(await service.suggestCharacters(session,id,await body(),initial.revision));
    if (segments[2] === 'story' && segments[3] === 'accept' && segments.length === 4 && method === 'POST') return respond(await service.acceptStoryReview(session,id,await body(),initial.revision));
    if (segments[2] === 'story' && segments[3] === 'approve' && segments.length === 4 && method === 'POST') return respond(await service.approveStory(session,id,await body(),initial.revision));
    if (segments[2] === 'story' && segments[3] === 'plan' && segments.length === 4 && method === 'POST') return respond(await service.planStory(session,id,await body(),initial.revision));
    if (segments[2] === 'characters' && segments.length === 5 && segments[4] === 'reference' && method === 'POST') return respond(await service.generateReference(session,id,segments[3],await body(),initial.revision));
    if (segments[2] === 'characters' && segments.length === 3 && method === 'POST') return respond(await service.addCharacter(session,id,await body(),initial.revision));
    if (segments[2] === 'characters' && segments.length === 4 && method === 'PATCH') return respond(await service.editCharacter(session,id,segments[3],await body(),initial.revision));
    if (segments[2] === 'characters' && segments.length === 4 && method === 'DELETE') return respond(await service.removeCharacter(session,id,segments[3],await body(),initial.revision));
    if (segments[2] === 'characters' && segments.length === 5 && segments[4] === 'approve' && method === 'POST') return respond(await service.approveCharacter(session,id,segments[3],await body(),initial.revision));
    if (segments[2] === 'revisions' && segments[3] === 'preview' && segments.length === 4 && method === 'POST') return respond(await service.previewRevision(session,id,await body(),initial.revision));
    if (segments[2] === 'revisions' && segments.length === 3 && method === 'POST') return respond(await service.applyRevision(session,id,await body(),initial.revision));
    if (!backend && segments[2]==='pages' && segments.length===5 && segments[4]==='job' && method==='GET') {
      const requestId=request.nextUrl.searchParams.get('id') ?? undefined;
      if(requestId && !z.string().uuid().safeParse(requestId).success)throw new HttpError(400,'Invalid page job.');
      const local=store as LocalStore;
      return reply({job:publicPageJob(local.pageJob(id,session,segments[3],requestId),local.getOwned<Draft>(id,session)?.data),comic:initial});
    }
    if (!backend && pageStart && method==='POST') {
      const local=store as LocalStore,asynchronous=segments[4]==='generate-async';
      const payload=asynchronous ? await input(request,z.object({requestId:z.string().uuid(),expectedRevision:z.number().int().positive()}).strict()) : await input(request,z.object({}).strict());
      const requestId=asynchronous ? (payload as {requestId:string;expectedRevision:number}).requestId : randomUUID();
      const expected=asynchronous ? (payload as {requestId:string;expectedRevision:number}).expectedRevision : initial.revision;
      const previous=local.pageJob(id,session,segments[3],requestId);
      if(previous)return reply({job:publicPageJob(previous,local.getOwned<Draft>(id,session)?.data),comic:initial},previous.state==='running'?202:200);
      const raw=local.getOwned<Draft>(id,session);if(!raw)throw new HttpError(404,'Comic not found.');
      const draft=resolveAdvisory(local,raw.data),index=draft.pages.findIndex(page=>page.id===segments[3]);
      if(index<0)throw new HttpError(404,'Page not found.');
      if(index>0 && draft.pages[index-1].panels.some(panel=>panel.storyRevision!==draft.storyRevision || !isPanelReady(panel) || !!draft.operations?.[`panel:${panel.id}`] || !isPanelReviewed(panel)))throw new HttpError(409,'Finish and review the preceding page first.');
      const reservation=local.beginPageJob(id,session,segments[3],requestId,expected);
      if(!reservation)throw new HttpError(409,'The page is already drawing, needs recovery, or the draft changed. Refresh and try again.');
      if(!reservation.created)return reply({job:publicPageJob(reservation.job,draft),comic:initial},reservation.job.state==='running'?202:200);
      const work=async()=>{
        try {
          const result=await service.generatePage(session,id,segments[3],{},expected);
          local.finishPageJob(requestId,session,result.notice?'paused':'completed',result.notice??null);
          return result;
        } catch(error) {
          const unknown=error instanceof AIError && (error.code==='unknown_outcome'||error.code==='invalid_response');
          const message=error instanceof HttpError || error instanceof ApplicationError || error instanceof AIError || error instanceof BudgetError ? error.message : 'Page generation failed. Refresh the draft to inspect its progress.';
          local.finishPageJob(requestId,session,unknown?'unknown':'failed',message);throw error;
        }
      };
      if(!asynchronous)return respond(await work());
      void work().catch(()=>{});
      return reply({job:publicPageJob(reservation.job,draft),comic:initial},202);
    }
    if (segments[2] === 'pages' && segments.length === 5 && segments[4] === 'generate' && method === 'POST') return respond(await service.generatePage(session,id,segments[3],await body(),initial.revision));
    if (segments[2] === 'panels' && segments.length === 5 && segments[4] === 'edit' && method === 'POST') return respond(await service.editPanel(session,id,segments[3],await body(),initial.revision));
    if (segments[2] === 'panels' && segments.length === 5 && segments[4] === 'accept' && method === 'POST') return respond(await service.acceptPanel(session,id,segments[3],await body(),initial.revision));
    if (segments[2] === 'publish' && segments.length === 3 && method === 'POST') return respond(await service.publish(session,id,await body(),initial.revision));
    if (segments[2] === 'unpublish' && segments.length === 3 && method === 'POST') return respond(await service.withdraw(session,id,await body(),initial.revision));
    if (method === 'POST') assertMutation(request);
    throw new HttpError(404,'Not found.');
  } catch (error) {
    if (error instanceof HttpError) return reply({error:error.message},error.status);
    if (error instanceof ApplicationError) {
      const status={invalid_input:400,not_found:404,conflict:409,invalid_story:422,invalid_provider_response:502}[error.code];
      return reply({error:error.message},status);
    }
    if (error instanceof ClaimInProgressError) return reply({error:error.message},409);
    if (error instanceof BudgetError) return reply({error:error.message,code:error.code},error.code === 'budget_not_configured' ? 503 : 429);
    if (error instanceof AIError) return reply({error:error.message,code:error.code},error.code === 'missing_key' ? 503 : error.code === 'invalid_input' ? 400 : 502);
    if (error instanceof Error && /incomplete|unaccepted|stale publication/.test(error.message)) return reply({error:error.message},409);
    console.error('Local API error:',error instanceof Error ? error.message : 'unknown error');
    return reply({error:'The local server could not complete the request.'},500);
  }
}
