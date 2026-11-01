import {z} from 'zod';
import type {AIOptions, createAIService, Reference, RevisionResult, Storyboard} from '../ai/service';
import type {ComicDraft} from '../domain/comic';

export type Actor = string;
export type MaybePromise<T> = T | Promise<T>;
export type Json = null | boolean | number | string | Json[] | {[key:string]:Json};
export type FetchLike = NonNullable<AIOptions['fetch']>;
export interface DurableComicContext {
  paid<T>(step:{id:string;input:Json;expectedRevision:number},invoke:(fetch:FetchLike)=>Promise<T>):Promise<T>;
  checkpoint<T extends Json>(key:string,work:(repository:ComicRepository)=>Promise<T>):Promise<T>;
  load<T extends Json>(key:string):Promise<T|null>;
  assetIdFor?(stepId:string):Promise<string|null>;
  stepState?(stepId:string):Promise<'running'|'completed'|'failed'|'unknown'|null>;
}
export type Character = {id: string; name: string; role: string; appearance: string; outfit: string; referenceUrl?: string; referenceAssetId?: string; approved: boolean};
export type PanelReview = {assetId:string; storyRevision:number; panelRevision:number; outcome:'pass' | 'findings' | 'inconclusive' | 'failed'};
export type SuggestedCharacter = {id:string; name:string; role:string; appearance:string; outfit:string};
export type Draft = ComicDraft & {characters: Character[]; answers: Record<string,string>; questions: {id: string; question: string; suggestedAnswer?: string}[]; initialQuestions?: 'pending' | 'running' | 'complete' | 'failed' | 'unknown'; characterSuggestions?: SuggestedCharacter[]; initialSuggestions?: 'pending' | 'running' | 'complete' | 'failed' | 'unknown'; pageCount?: number; panelsPerPage?: number; pageLayout?: 'stack' | 'grid'; storyboard?: Storyboard; storyReview?: unknown; storyReviewRunId?: string; storyReviewAcceptance?: string; pageOperations?: Record<string, {storyRevision:number; baseline:Record<string,number>}>; pendingRevision?: {id:string; baseRevision:number; baseStoryRevision?:number; result:RevisionResult; instruction?:string}; pendingArtworkDecision?: {id:string;panelId:string;instruction:string;assetId:string;storyRevision:number;panelRevision:number;expiresAt:number;reason?:string;intent?:'uncertain' | 'story'}; panelFindings?: Record<string, unknown[]>; panelReviews?: Record<string, PanelReview>; operations?: Record<string, 'running' | 'unknown_outcome'>; durableOperationMarkers?: Record<string,string>};
export type PageIntent = 'generate'|'resume'|'regenerate';
/** The same precondition is checked at enqueue and at durable execution. */
export function pageIntentMatches(draft:Draft,pageId:string,intent:PageIntent):boolean {
  const page=draft.pages.find(p=>p.id===pageId);if(!page)return false;
  const pending=draft.pageOperations?.[page.id]?.storyRevision===draft.storyRevision;
  const progress=page.panels.some(p=>!!p.assetId)||pending;
  const complete=page.panels.length>0&&page.panels.every(p=>!!p.assetId&&p.storyRevision===draft.storyRevision&&['current','needs_review','checking'].includes(p.status));
  return intent==='generate'?!progress:intent==='resume'?pending||(progress&&!complete):complete&&!pending;
}
export type Edition = {id: string; title: string; creator: string; editionId: string; sourceRevision: number; coverUrl?:string; pages: {id: string; imageUrl: string; storage?: 'sqlite'}[]};

/** Atomic compare-and-swap and text reservations are part of the repository contract. */
export interface ComicRepository {
  create(id:string, owner:Actor, data:unknown): MaybePromise<void>;
  getOwned<T = unknown>(id:string, owner:Actor): MaybePromise<{revision:number;data:T} | null>;
  listOwned<T = unknown>(owner:Actor): MaybePromise<T[]>;
  update(id:string, owner:Actor, revision:number, data:unknown): MaybePromise<boolean>;
  updateWithoutActiveWork?(id:string, owner:Actor, revision:number, data:unknown): MaybePromise<boolean>;
  reserveTextOperation(id:string, owner:Actor, revision:number): MaybePromise<boolean>;
  finishTextOperation(id:string, owner:Actor, unknown:boolean): MaybePromise<void>;
  /** Reacquire only this operation's reconciled unknown reservation. */
  resumeTextOperation?(id:string, owner:Actor): MaybePromise<boolean>;
  publish(id:string, owner:Actor, revision:number, edition:unknown, assets:{id:string;data:Uint8Array}[]): MaybePromise<boolean>;
  withdraw(id:string, owner:Actor, revision?:number): MaybePromise<boolean>;
  getPublished<T = unknown>(id:string): MaybePromise<T | null>;
  listPublished<T = unknown>(): MaybePromise<T[]>;
  getPublicationAsset(id:string, assetId:string): MaybePromise<Uint8Array | null>;
}
export interface ComicAssets {
  read(id:string): MaybePromise<Buffer>;
  save(bytes:Buffer): MaybePromise<string>;
  discard(id:string): MaybePromise<void>;
}
export interface ComicDependencies {
  repository: ComicRepository;
  assets: ComicAssets;
  provider(options:{fetch:NonNullable<AIOptions['fetch']>}): ReturnType<typeof createAIService>;
  budgetFetch: NonNullable<AIOptions['fetch']>;
  budgetFetchFor?(comicId:string):NonNullable<AIOptions['fetch']>;
  durable?: DurableComicContext;
  /** Local schedulers persist version-bound advisory results after the draft commit. */
  advisory?: {
    resolve?(draft:Draft):Draft;
    narrative(draft:Draft):void;
    visual(input:{draft:Draft;panelId:string;assetId:string;panelRevision:number;bible:Storyboard['bible'];styleRules:string;beats:Omit<Storyboard['pages'][number]['panels'][number],'dialogue'>;references:Reference[]}):void;
  };
  id(): string;
}
export type ApplicationErrorCode = 'invalid_input' | 'not_found' | 'conflict' | 'invalid_story' | 'invalid_provider_response';
export class ApplicationError extends Error { constructor(readonly code:ApplicationErrorCode, message:string) { super(message); } }
export function parse<T>(value:unknown, schema:z.ZodType<T>): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApplicationError('invalid_input', 'Please check the supplied fields.');
  return parsed.data;
}
export const styles = z.enum(['clear-line-adventure', 'ink-manga', 'painted-storybook']);
export const short = z.string().trim().min(1).max(300);
export const createSchema = z.object({title: short, plot: z.string().trim().min(1).max(4000), style: styles, pageCount:z.number().int().min(1).max(10).optional(), email:z.string().trim().email().max(254).optional()}).strict();
export const patchSchema = z.object({title: short.optional(), plot: z.string().trim().min(1).max(4000).optional(), style: styles.optional(), answers: z.record(z.string().max(100), z.string().max(1000)).optional(), pageCount:z.number().int().min(1).max(10).optional(), panelsPerPage:z.number().int().min(2).max(4).optional(), pageLayout:z.enum(['stack','grid']).optional()}).strict();
export const characterSchema = z.object({name: short, role: short, appearance: z.string().trim().min(1).max(1000), outfit: z.string().trim().min(1).max(1000)}).strict();
export const referenceUploadSchema = characterSchema.pick({appearance:true,outfit:true}).extend({expectedReferenceId:z.string().max(100),expectedCardVersion:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const panelVersionSchema = z.object({assetId:z.string().uuid(),storyRevision:z.number().int().positive(),panelRevision:z.number().int().positive()}).strict();
export const publishSchema = z.object({title: short, creator: z.string().trim().max(100), expectedEditionId:short.nullable().optional()}).strict();
