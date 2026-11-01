import {z} from 'zod';
import type {Operation} from './contracts';
import {safeResult} from '../mcp/results';

const actions=['create','update','initialQuestions','refreshQuestions','suggestCharacters','addCharacter','editCharacter','removeCharacter','generateReference','approveCharacter','planStory','approveStory','acceptStoryReview','generatePage','acceptPanel','editPanel','previewRevision','applyRevision','exportPage','publish','withdraw'] as const;
const requestSchema=z.object({action:z.enum(actions),requestKey:z.string().trim().min(1).max(128),comicId:z.string().trim().min(1).max(300).optional(),expectedRevision:z.number().int().positive().optional(),input:z.record(z.string(),z.unknown())}).strict();
type OperationInput=z.infer<typeof requestSchema>;
type Ticket={id:string;status:string;comicId?:string};
type BrowserOperations = {
  origin:string;
  owner(cookie:string):Promise<string|null>;
  enqueue(cookie:string,owner:string,input:OperationInput):Promise<Ticket>;
  get(owner:string,id:string):Promise<Operation|null>;
  export(owner:string,id:string):Promise<Buffer|null>;
};
const headers={'Cache-Control':'no-store'};
const json=(body:unknown,status=200)=>Response.json(body,{status,headers});

/** Browser adapter for the same durable operations used by MCP. */
export function createBrowserOperations(deps:BrowserOperations) {
  const origin=new URL(deps.origin);
  if(origin.origin!==deps.origin || (origin.protocol!=='https:' && !(origin.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(origin.hostname))))throw new Error('Invalid application origin.');
  const validHost=(request:Request)=>new URL(request.url).origin===origin.origin && request.headers.get('host')===origin.host;
  return {
    async start(request:Request):Promise<Response> {
      if (!validHost(request) || request.headers.get('origin')!==origin.origin) return json({error:'Invalid application origin.'},403);
      if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return json({error:'Send JSON data.'},415);
      const cookie=request.headers.get('cookie') ?? '',owner=await deps.owner(cookie);
      if (!owner) return json({error:'Sign in to continue.'},401);
      let input:unknown;
      try {const text=await request.text();if(Buffer.byteLength(text,'utf8')>128_000)return json({error:'Request is too large.'},413);input=JSON.parse(text);}catch{return json({error:'Invalid JSON.'},400);}
      const parsed=requestSchema.safeParse(input);
      if (!parsed.success) return json({error:'Please check the supplied fields.'},400);
      try {return json(await deps.enqueue(cookie,owner,parsed.data),202);}
      catch(error) {
        const code=error && typeof error==='object' && 'code' in error ? error.code : null;
        if(code==='not_found')return json({error:'Comic not found.'},404);
        if(code==='conflict' || code==='idempotency_conflict')return json({error:'This draft or request changed. Refresh and try again.'},409);
        if(code==='invalid_input')return json({error:'Please check the supplied fields.'},400);
        return json({error:'The operation could not be started.'},503);
      }
    },
    async get(request:Request,id:string,download=false):Promise<Response> {
      if (!validHost(request)) return json({error:'Invalid application origin.'},403);
      const owner=await deps.owner(request.headers.get('cookie') ?? '');
      if (!owner) return json({error:'Operation not found.'},404);
      if (download) {
        const bytes=await deps.export(owner,id);
        return bytes ? new Response(new Uint8Array(bytes),{headers:{...headers,'Content-Type':'image/png','Content-Disposition':'attachment; filename="comex-page.png"','X-Content-Type-Options':'nosniff'}}) : json({error:'Export not found.'},404);
      }
      const operation=await deps.get(owner,id);
      if (!operation) return json({error:'Operation not found.'},404);
      const sanitized=safeResult(operation.result,{actor:owner,scopes:[]},null);
      const result=sanitized && typeof sanitized==='object' && !Array.isArray(sanitized) ? sanitized as Record<string,unknown> : null;
      const comic=result?.comic && typeof result.comic==='object' && !Array.isArray(result.comic) ? result.comic as Record<string,unknown> : null;
      const comicId=operation.targetId || (typeof comic?.id==='string' ? comic.id : undefined);
      const error=operation.status==='unknown_outcome' ? {code:'unknown_outcome',message:'The result could not be confirmed. Review this operation before retrying.'} : operation.status==='failed' || operation.status==='obsolete' || operation.status==='revoked' ? {code:operation.status,message:'The operation did not finish. Refresh the draft before trying again.'} : undefined;
      return json({id:operation.id,status:operation.status,action:operation.action,...(comicId?{comicId}:{}),...(error?{error}:{}),...(sanitized!==null && !error?{result:sanitized}:{})});
    },
  };
}
