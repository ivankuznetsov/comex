/** Only token counts and a bounded model identifier leave the provider envelope. */
export type ResponseObservation = {model:string|null;usage:unknown;latencyMs:number};

export function responseObservation(value:unknown, latencyMs:number):ResponseObservation {
  const raw=value && typeof value==='object' ? value as Record<string,unknown> : {};
  const model=typeof raw.model==='string' && /^[a-zA-Z0-9._:/-]{1,160}$/.test(raw.model) ? raw.model : null;
  const usage=raw.usage && typeof raw.usage==='object' && !Array.isArray(raw.usage) ? raw.usage as Record<string,unknown> : null;
  const copyCounts=(source:Record<string,unknown>,keys:string[]) => Object.fromEntries(keys.flatMap(key => {
    const count=source[key]; return typeof count==='number' && Number.isSafeInteger(count) && count>=0 ? [[key,count]] : [];
  }));
  let sanitized:Record<string,unknown>|null=null;
  if (usage) {
    sanitized=copyCounts(usage,['input_tokens','output_tokens','total_tokens']);
    for (const [field,keys] of Object.entries({input_tokens_details:['cached_tokens','cache_write_tokens'],output_tokens_details:['reasoning_tokens']})) {
      const details=usage[field];
      if (details && typeof details==='object' && !Array.isArray(details)) {
        const counts=copyCounts(details as Record<string,unknown>,keys);
        if (Object.keys(counts).length) sanitized[field]=counts;
      }
    }
  }
  return {model,usage:sanitized,latencyMs};
}

/** Observability must not change provider results or budget finalization. */
export function observeSafely(observer:((value:ResponseObservation)=>void)|undefined, value:unknown, latencyMs:number):void {
  if (!observer) return;
  try {observer(responseObservation(value,latencyMs));} catch {}
}
