import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetError, createBudgetedFetch, finalizeBudgetedResponse, ProviderBudget } from '../src/lib/budget';

function db() { const dir = mkdtempSync(join(tmpdir(), 'comex-budget-')); return {dir, path: join(dir, 'budget.sqlite')}; }
const ok = async () => new Response('{}', { status: 200 });

describe('provider-call budget', () => {
  test('missing configuration fails closed before dispatch', async () => {
    const {dir,path} = db(); let calls=0;
    const request = createBudgetedFetch(path, async () => { calls++; return ok(); }, {maxCalls: undefined, maxConcurrent: 1});
    try { await request('https://example.test'); throw new Error('expected error'); }
    catch (e) { expect(e).toBeInstanceOf(BudgetError); expect((e as BudgetError).code).toBe('budget_not_configured'); }
    expect(calls).toBe(0); rmSync(dir,{recursive:true,force:true});
  });
  test('successful and provider-error requests consume a finite durable budget', async () => {
    const {dir,path} = db(); let calls=0;
    const config={maxCalls:2,maxConcurrent:1};
    const first = createBudgetedFetch(path, async () => { calls++; return ok(); }, config);
    const firstResponse=await first('https://example.test');
    expect(firstResponse.status).toBe(200); await firstResponse.json(); finalizeBudgetedResponse(firstResponse,'completed');
    const second = createBudgetedFetch(path, async () => { calls++; return new Response(null,{status:400}); }, config);
    expect((await second('https://example.test')).status).toBe(400);
    await expect(first('https://example.test')).rejects.toMatchObject({code:'budget_exhausted'});
    expect(calls).toBe(2); rmSync(dir,{recursive:true,force:true});
  });
  test('two independent instances cannot exceed the concurrent limit', async () => {
    const {dir,path} = db(); let release!: () => void; let calls=0;
    const gate = new Promise<void>(resolve => { release=resolve; });
    const config={maxCalls:3,maxConcurrent:1};
    const first=createBudgetedFetch(path, async () => { calls++; await gate; return ok(); }, config);
    const second=createBudgetedFetch(path, async () => { calls++; return ok(); }, config);
    const pending=first('https://example.test');
    await expect(second('https://example.test')).rejects.toMatchObject({code:'concurrency_limit'});
    release(); const response=await pending;
    await expect(second('https://example.test')).rejects.toMatchObject({code:'concurrency_limit'});
    await response.json(); finalizeBudgetedResponse(response,'completed');
    const next=await second('https://example.test'); expect(next.status).toBe(200); await next.json(); finalizeBudgetedResponse(next,'completed');
    expect(calls).toBe(2); rmSync(dir,{recursive:true,force:true});
  });
  test('unknown dispatch outcome stays consumed and prevents implicit retry', async () => {
    const {dir,path} = db(); let calls=0; const config={maxCalls:3,maxConcurrent:1};
    const request=createBudgetedFetch(path, async () => {calls++; throw new Error('connection dropped');}, config);
    await expect(request('https://example.test')).rejects.toThrow('connection dropped');
    await expect(request('https://example.test')).rejects.toMatchObject({code:'concurrency_limit'});
    const b = new ProviderBudget(path, config); expect(b.summary()).toMatchObject({used:1, active:1, unknown:1}); b.close();
    expect(calls).toBe(1); rmSync(dir,{recursive:true,force:true});
  });
  test('a server timeout response remains an unknown reservation', async () => {
    const {dir,path}=db(); let calls=0; const config={maxCalls:3,maxConcurrent:1};
    const request=createBudgetedFetch(path, async () => {calls++; return new Response(null,{status:503});}, config);
    expect((await request('https://example.test')).status).toBe(503);
    await expect(request('https://example.test')).rejects.toMatchObject({code:'concurrency_limit'});
    const b=new ProviderBudget(path,config); expect(b.summary()).toEqual({used:1,active:1,unknown:1}); b.close();
    expect(calls).toBe(1); rmSync(dir,{recursive:true,force:true});
  });

});

test('abandoned reservations require explicit reconciliation and retain their cost', () => {
  const {dir,path}=db(); const config={maxCalls:3,maxConcurrent:1};
  const crashed=new ProviderBudget(path,config); const id=crashed.reserve(); crashed.close();
  const operator=new ProviderBudget(path,config);
  expect(operator.listOutstanding()).toMatchObject([{id,state:'running'}]);
  expect(()=>operator.resolveUnknown(id)).toThrow();
  expect(()=>operator.reserve()).toThrow(BudgetError);
  operator.markUnknown(id);
  expect(operator.summary()).toEqual({used:1,active:1,unknown:1});
  expect(()=>operator.reserve()).toThrow(BudgetError);
  operator.resolveUnknown(id);
  expect(operator.summary()).toEqual({used:1,active:0,unknown:0});
  expect(()=>operator.resolveUnknown(id)).toThrow();
  operator.close(); rmSync(dir,{recursive:true,force:true});
});
