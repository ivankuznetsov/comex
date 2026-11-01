import type {MaybePromise, ComicRepository, ComicAssets} from '../application/contracts';
import type {BudgetConfig} from '../budget';
export type {ComicRepository, ComicAssets, BudgetConfig};
export interface ReservationBudget {
  reserve(stepKey?:string): MaybePromise<string>;
  finish(id:string, state:'completed'|'unknown'): MaybePromise<void>;
  summary(): MaybePromise<{used:number;active:number;unknown:number}>;
  listOutstanding(): MaybePromise<{id:string;state:'running'|'unknown';createdAt:string}[]>;
  markUnknown(id:string): MaybePromise<void>;
  resolveUnknown(id:string): MaybePromise<void>;
}
