/** Trusted identities are supplied by the authentication adapter, never by tool arguments. */
export type ComexScope = 'comex:read' | 'comex:write' | 'comex:generate' | 'comex:publish';
export type McpIdentity = {actor:string; scopes:readonly ComexScope[]; grantId?:string};
export type MutationAction =
  | 'create' | 'update' | 'initialQuestions' | 'refreshQuestions' | 'suggestCharacters'
  | 'addCharacter' | 'editCharacter' | 'removeCharacter' | 'generateReference' | 'approveCharacter'
  | 'planStory' | 'approveStory' | 'acceptStoryReview' | 'generatePage' | 'acceptPanel'
  | 'editPanel' | 'previewRevision' | 'applyRevision' | 'exportPage' | 'publish' | 'withdraw';
export type OperationStatus = 'queued' | 'running' | 'succeeded' | 'needs_review' | 'failed' | 'unknown_outcome' | 'obsolete' | 'revoked';
export type OperationTicket = {id:string; status:OperationStatus; comicId?:string};
export type OperationRequest = {identity:McpIdentity; action:MutationAction; requestKey:string; comicId?:string; expectedRevision?:number; input:Record<string,unknown>};

/** This adapter must atomically persist the operation and dispatch intent before returning.
 * It owns idempotency, version and scope checks, grant revocation at execution, and provider dispatch.
 * A transport must never substitute an in-request provider call for this interface. */
export interface DurableOperationDispatcher {
  readonly kind:'durable';
  enqueue(request:OperationRequest):Promise<OperationTicket>;
}
/** Each method performs an owner-authorized read. listComics must apply the supplied bound. */
export interface McpReads {
  listStyles():Promise<{styles:unknown[]}>;
  listComics(identity:McpIdentity, options:{limit:number; cursor?:string}):Promise<{comics:unknown[]; nextCursor?:string | null}>;
  getComic(identity:McpIdentity, comicId:string):Promise<{comic:unknown}>;
  getAsset(identity:McpIdentity, comicId:string, assetId:string):Promise<{bytes:Uint8Array; mimeType:'image/png'}>;
  getExport(identity:McpIdentity, operationId:string):Promise<{bytes:Uint8Array; mimeType:'image/png'}>;
  getOperation(identity:McpIdentity, operationId:string):Promise<{id:string;status:OperationStatus;[key:string]:unknown}>;
}
export interface ComexMcpDependencies {
  /** Verify token, issuer, audience, expiry, scopes and grant revocation on every request. */
  authenticate(request:Request):Promise<McpIdentity | null>;
  readonly reads:McpReads;
  readonly operations:DurableOperationDispatcher;
  readonly allowedOrigins:readonly string[];
  readonly resourceMetadata:string;
  readonly editorOrigin?:string;
}
