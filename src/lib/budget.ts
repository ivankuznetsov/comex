import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type BudgetErrorCode = 'budget_not_configured' | 'budget_exhausted' | 'concurrency_limit' | 'reservation_exists';
export class BudgetError extends Error {
  constructor(public readonly code: BudgetErrorCode, message: string) {
    super(message);
    this.name = 'BudgetError';
  }
}
export type BudgetConfig = { maxCalls: number | 'unlimited' | undefined; maxConcurrent: number | undefined };
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** An explicit total-call policy is required before any billable request. */
export function budgetFromEnvironment(): BudgetConfig {
  const readInteger = (s: string | undefined): number | undefined => s && /^\d+$/.test(s) ? Number(s) : undefined;
  return {
    maxCalls: process.env.COMEX_MAX_PROVIDER_CALLS === 'unlimited' ? 'unlimited' : readInteger(process.env.COMEX_MAX_PROVIDER_CALLS),
    maxConcurrent: process.env.COMEX_MAX_CONCURRENT_CALLS === undefined ? 1 : readInteger(process.env.COMEX_MAX_CONCURRENT_CALLS),
  };
}

/** Local SQLite reservations; a transaction guards budget and concurrency across connections. */
export class ProviderBudget {
  private readonly db: DatabaseSync;
  constructor(path: string, private readonly config: BudgetConfig = budgetFromEnvironment()) {
    if (path !== ':memory:') mkdirSync(dirname(path), {recursive: true});
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS provider_reservations (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK(state IN ('running', 'completed', 'unknown')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const columns=this.db.prepare('PRAGMA table_info(provider_reservations)').all() as {name:string}[];
      if (!columns.some(column=>column.name==='step_key')) this.db.exec('ALTER TABLE provider_reservations ADD COLUMN step_key TEXT');
      this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS provider_reservations_step_key ON provider_reservations(step_key)');
      this.db.exec('COMMIT');
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
  reserve(stepKey?:string): string {
    const {maxCalls, maxConcurrent} = this.config;
    if ((maxCalls !== 'unlimited' && (!Number.isSafeInteger(maxCalls) || (maxCalls as number) < 1)) ||
        !Number.isSafeInteger(maxConcurrent) || (maxConcurrent as number) < 1) {
      throw new BudgetError('budget_not_configured', 'Set COMEX_MAX_PROVIDER_CALLS to a positive integer or unlimited, and COMEX_MAX_CONCURRENT_CALLS to a positive integer before using AI.');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (stepKey !== undefined && this.db.prepare('SELECT 1 FROM provider_reservations WHERE step_key=?').get(stepKey)) throw new BudgetError('reservation_exists', 'This provider step already has a reservation.');
      const counts = this.summary();
      if (typeof maxCalls === 'number' && counts.used >= maxCalls) throw new BudgetError('budget_exhausted', 'The configured AI call budget is exhausted.');
      if (counts.active >= maxConcurrent!) throw new BudgetError('concurrency_limit', 'The AI concurrency limit is reached or a previous request has an unknown outcome.');
      const id = randomUUID();
      const now = new Date().toISOString();
      this.db.prepare('INSERT INTO provider_reservations(id,state,created_at,updated_at,step_key) VALUES (?,\'running\',?,?,?)').run(id, now, now, stepKey ?? null);
      this.db.exec('COMMIT');
      return id;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  /** Count every dispatched request, including failures. Unknown stays active until reconciled. */
  finish(id: string, state: 'completed' | 'unknown'): void {
    const result = this.db.prepare("UPDATE provider_reservations SET state=?, updated_at=? WHERE id=? AND state='running'").run(state, new Date().toISOString(), id);
    if (Number(result.changes) !== 1) throw new Error('Provider reservation could not be finalized.');
  }
  listOutstanding(): {id: string; state: 'running' | 'unknown'; createdAt: string}[] {
    return this.db.prepare("SELECT id, state, created_at AS createdAt FROM provider_reservations WHERE state IN ('running','unknown') ORDER BY created_at, id").all() as {id: string; state: 'running' | 'unknown'; createdAt: string}[];
  }
  /** Only use after stopping all app processes; a running request may still be billable. */
  markUnknown(id: string): void { this.finish(id, 'unknown'); }
  /** Explicitly release an investigated unknown, without refunding its call. */
  resolveUnknown(id: string): void {
    const result = this.db.prepare("UPDATE provider_reservations SET state='completed', updated_at=? WHERE id=? AND state='unknown'").run(new Date().toISOString(), id);
    if (Number(result.changes) !== 1) throw new Error('Unknown provider reservation could not be resolved.');
  }
  summary(): {used: number; active: number; unknown: number} {
    const row = this.db.prepare("SELECT count(*) AS used, coalesce(sum(CASE WHEN state IN ('running','unknown') THEN 1 ELSE 0 END),0) AS active, coalesce(sum(CASE WHEN state='unknown' THEN 1 ELSE 0 END),0) AS unknown FROM provider_reservations").get() as {used: number; active: number; unknown: number};
    return {used: Number(row.used), active: Number(row.active), unknown: Number(row.unknown)};
  }
  close(): void { this.db.close(); }
}

const finalizeResponse = Symbol('finalize provider reservation');
type BudgetedResponse = Response & {[finalizeResponse]?: (state: 'completed' | 'unknown') => void | Promise<void>};

export function setBudgetFinalizer(response:Response, finalize:(state:'completed'|'unknown')=>void|Promise<void>):void {
  Object.defineProperty(response,finalizeResponse,{value:finalize});
}

/** Called by the adapter after reading and validating the provider response. */
export function finalizeBudgetedResponse(response: Response, state: 'completed' | 'unknown'): void | Promise<void> {
  return (response as BudgetedResponse)[finalizeResponse]?.(state);
}

/** No automatic retries. An indeterminate response remains an outstanding reservation. */
export function createBudgetedFetch(path: string, fetcher: FetchLike = globalThis.fetch,
  config?: BudgetConfig): FetchLike {
  return async (input, init) => {
    const budget = new ProviderBudget(path, config ?? budgetFromEnvironment());
    let reservation: string;
    try { reservation = budget.reserve(); } catch (error) { budget.close(); throw error; }
    let response: Response;
    try {
      response = await fetcher(input, init);
    } catch (error) {
      try { budget.finish(reservation, 'unknown'); } finally { budget.close(); }
      throw error;
    }
    if (!response.ok) {
      try { budget.finish(reservation, response.status === 408 || response.status >= 500 ? 'unknown' : 'completed'); }
      finally { budget.close(); }
      return response;
    }
    // Keep the reservation running until the adapter consumes and checks the body.
    // If the process dies first, it remains running for manual reconciliation.
    setBudgetFinalizer(response, (state: 'completed' | 'unknown') => {
      try { budget.finish(reservation, state); } finally { budget.close(); }
    });
    return response;
  };
}
