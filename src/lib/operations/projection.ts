import type {Operation} from './contracts';

/** Public status metadata excludes saved inputs, owners, grants and credentials. */
export function operationSummary(operation:Operation) {
  const input=operation.input;
  const targets:Record<string,string>={};
  if(input && typeof input==='object' && !Array.isArray(input)) {
    for(const key of ['pageId','panelId','characterId']) {
      const value=input[key];
      if(typeof value==='string' && value.length<=300)targets[key]=value;
    }
  }
  return {id:operation.id,status:operation.status,action:operation.action,...(operation.targetId?{comicId:operation.targetId}:{}),
    ...(typeof operation.expectedVersions==='number'?{expectedRevision:operation.expectedVersions}:{}),...targets};
}
