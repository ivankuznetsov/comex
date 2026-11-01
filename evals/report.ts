export type TrialRecord = {
  caseId:string;check:string;kind:'routing'|'visual';split:'calibration'|'holdout';evaluator:'responses'|'decisions';
  expected:string;prediction:string|null;status:'ok'|'refusal'|'error';latencyMs:number|null;usage:unknown;model:string|null;
  requestId?:string;error?:string;raw?:unknown;assetHashes?:string[];promptHashes?:Record<string,string>;evidenceHash?:string;
};
export type Rates = Record<string,{input:number;cached:number;cacheWrite:number;output:number}>;

/** Rates are dollars per million tokens; cache categories are subsets of input tokens. */
export function estimatedCost(usage:unknown,model:string|null,rates:Rates):number|null {
  if (!usage || !model || !rates[model]) return null;
  const u=usage as {input_tokens?:number;output_tokens?:number;input_tokens_details?:{cached_tokens?:number;cache_write_tokens?:number}};
  const input=u.input_tokens,output=u.output_tokens,cached=u.input_tokens_details?.cached_tokens ?? 0,write=u.input_tokens_details?.cache_write_tokens ?? 0,rate=rates[model];
  if (![input,output,cached,write,rate.input,rate.cached,rate.cacheWrite,rate.output].every(n=>typeof n==='number' && Number.isFinite(n) && n>=0) || cached+write>input!) return null;
  return ((input!-cached-write)*rate.input+cached*rate.cached+write*rate.cacheWrite+output!*rate.output)/1_000_000;
}

function uniqueRequests(rows:TrialRecord[]):TrialRecord[] {
  const seen = new Set<string>();
  return rows.filter(row => {
    if (!row.requestId) return true;
    if (seen.has(row.requestId)) return false;
    seen.add(row.requestId); return true;
  });
}

function summarizeEvaluators(records:TrialRecord[],rates:Rates) {
  const evaluators:Record<string,{total:number;routingTotal:number;routingErrors:number;storyExpected:number;visualTotal:number;visualMismatchExpected:number;visualMatchExpected:number;visualIndeterminateExpected:number;successes:number;failures:number;abstentions:number;unsafeStoryToImage:number;visualFalseNegatives:number;visualFalsePositives:number;visualConfidentOnIndeterminate:number;routingConfusion:Record<string,Record<string,number>>;visualConfusion:Record<string,Record<string,number>>;latencyMs:{median:number|null;p95:number|null};estimatedCost:number|null}>={};
  for (const evaluator of ['responses','decisions'] as const) {
    const rows=records.filter(r=>r.evaluator===evaluator); if (!rows.length) continue;
    const confusion:Record<string,Record<string,number>>={};
    for (const row of rows.filter(r=>r.kind==='routing' && r.status==='ok' && r.prediction)) {
      confusion[row.expected] ??= {}; confusion[row.expected][row.prediction!] = (confusion[row.expected][row.prediction!] ?? 0)+1;
    }
    const visualConfusion:Record<string,Record<string,number>>={};
    for (const row of rows.filter(r=>r.kind==='visual' && r.status==='ok' && r.prediction)) {
      visualConfusion[row.expected] ??= {};visualConfusion[row.expected][row.prediction!]=(visualConfusion[row.expected][row.prediction!] ?? 0)+1;
    }
    const requests=uniqueRequests(rows);
    const caseTimes=new Map<string,number>();
    for (const row of requests) if (typeof row.latencyMs==='number' && Number.isFinite(row.latencyMs)) caseTimes.set(row.caseId,(caseTimes.get(row.caseId) ?? 0)+row.latencyMs);
    const times=[...caseTimes.values()].sort((a,b)=>a-b);
    const percentile=(p:number)=>times.length ? times[Math.ceil(p*times.length)-1] : null;
    const costs=requests.map(r=>estimatedCost(r.usage,r.model,rates));
    evaluators[evaluator]={total:rows.length,routingTotal:rows.filter(r=>r.kind==='routing').length,routingErrors:rows.filter(r=>r.kind==='routing' && r.status==='ok' && r.prediction!==r.expected).length,storyExpected:rows.filter(r=>r.kind==='routing' && r.expected==='story').length,visualTotal:rows.filter(r=>r.kind==='visual').length,visualMismatchExpected:rows.filter(r=>r.kind==='visual' && r.expected==='mismatch').length,visualMatchExpected:rows.filter(r=>r.kind==='visual' && r.expected==='match').length,visualIndeterminateExpected:rows.filter(r=>r.kind==='visual' && r.expected==='cannot_determine').length,successes:rows.filter(r=>r.status==='ok').length,failures:rows.filter(r=>r.status==='error').length,abstentions:rows.filter(r=>r.status==='refusal' || (r.status==='ok' && ['clarify','cannot_determine'].includes(r.prediction ?? ''))).length,
      unsafeStoryToImage:rows.filter(r=>r.kind==='routing' && r.status==='ok' && r.expected==='story' && ['cosmetic','restore'].includes(r.prediction ?? '')).length,
      visualFalseNegatives:rows.filter(r=>r.kind==='visual' && r.status==='ok' && r.expected==='mismatch' && r.prediction==='match').length,
      visualFalsePositives:rows.filter(r=>r.kind==='visual' && r.status==='ok' && r.expected==='match' && r.prediction==='mismatch').length,
      visualConfidentOnIndeterminate:rows.filter(r=>r.kind==='visual' && r.status==='ok' && r.expected==='cannot_determine' && ['match','mismatch'].includes(r.prediction ?? '')).length,
      routingConfusion:confusion,visualConfusion,latencyMs:{median:percentile(0.5),p95:percentile(0.95)},estimatedCost:costs.some(c=>c===null)?null:costs.reduce<number>((sum,c)=>sum+c!,0)};
  }
  return evaluators;
}

export function summarize(records:TrialRecord[],rates:Rates) {
  const evaluators=summarizeEvaluators(records,rates);
  const splits={calibration:summarizeEvaluators(records.filter(r=>r.split==='calibration'),rates),holdout:summarizeEvaluators(records.filter(r=>r.split==='holdout'),rates)};
  const cases=new Set(records.map(r=>r.caseId)); const differences:number[]=[];
  for (const id of cases) {
    const times:Record<string,number>={}; let paired=true;
    for (const evaluator of ['responses','decisions']) {
      const rows=records.filter(r=>r.caseId===id && r.evaluator===evaluator);
      const requests=uniqueRequests(rows);
      if (!rows.length || rows.some(r=>r.status!=='ok') || requests.some(r=>r.latencyMs===null)) {paired=false;break;}
      times[evaluator]=requests.reduce((sum,r)=>sum+r.latencyMs!,0);
    }
    if (paired) differences.push(times.decisions-times.responses);
  }
  differences.sort((a,b)=>a-b);
  const percentile=(p:number)=>differences.length?differences[Math.ceil(p*differences.length)-1]:null;
  return {evaluators,splits,pairedLatencyDifferenceMs:{cases:differences.length,median:percentile(0.5),p95:percentile(0.95)}};
}
