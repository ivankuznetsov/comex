import type {OperationIdentity,OperationRequest,OperationStatus} from '../operations/contracts';
export type {ComexScope,MutationAction,OperationRequest,OperationStatus} from '../operations/contracts';
/** Trusted identities are supplied by the authentication adapter, never by tool arguments. */
export type McpIdentity = OperationIdentity;
export type OperationTicket = {id:string; status:OperationStatus; comicId?:string};

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
  listOperations(identity:McpIdentity, comicId?:string):Promise<{operations:unknown[]}>;
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
