import {z} from 'zod';
import type {McpIdentity} from './contracts';

export const resultSchema=z.object({
  status:z.enum(['ok','queued','running','succeeded','needs_review','failed','unknown_outcome','obsolete','revoked','error']),
  message:z.string(), data:z.record(z.string(),z.unknown()).nullable(), error:z.object({code:z.string(),nextStep:z.string()}).strict().nullable(),
}).strict();
const forbiddenKeys=/^(owner|ownerId|actor|grantId|token|accessToken|refreshToken|secret|clientSecret|authorization|cookie|apiKey|prompt|providerPrompt|providerPrompts|systemPrompt|providerRequest|providerResponse|rawRequest|credentials|authInfo|costEstimate|providerCosts|costLedger)$/i;
/** Shared views should already omit secrets. Filter again at the protocol boundary. */
export function safeResult(value:unknown, identity:McpIdentity, authorization:string | null):unknown {
  const token=authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  const secrets=[identity.actor,identity.grantId,token].filter((s):s is string=>!!s);
  const clean=(item:unknown):unknown=>{
    if (typeof item === 'string') return secrets.reduce((text,secret)=>text.split(secret).join('[redacted]'),item);
    if (Array.isArray(item)) return item.map(clean);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).filter(([key])=>!forbiddenKeys.test(key)).map(([key,entry])=>[key,clean(entry)]));
    if (item === undefined || typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint') return null;
    return item;
  };
  return clean(value);
}
export function result(status:z.infer<typeof resultSchema>['status'],message:string,data:unknown=null,error:z.infer<typeof resultSchema>['error']=null,images?:{data:string;mimeType:string}[]) {
  // Text-only clients still need the same decisions and versions as clients that read structuredContent.
  const details=data !== null ? JSON.stringify(data) : error ? JSON.stringify(error) : '';
  return {content:[{type:'text' as const,text:details ? `${message}\n${details}` : message},...(images ?? []).map(image=>({type:'image' as const,...image}))],structuredContent:{status,message,data,error},...(error?{isError:true}:{})};
}
export function domainFailure(error:unknown) {
  const code=error && typeof error==='object' && 'code' in error && typeof error.code==='string' ? error.code : 'internal_error';
  switch(code) {
    case 'not_found': return result('error','The requested item was not found.',null,{code,nextStep:'Check the item ID and your connection.'});
    case 'conflict': return result('error','The draft or decision changed.',null,{code,nextStep:'Reload the comic and follow its current next steps.'});
    case 'invalid_input': case 'invalid_story': return result('error','The requested change is not valid.',null,{code,nextStep:'Review the supplied fields and the current story.'});
    case 'unknown_outcome': return result('unknown_outcome','The operation outcome is unknown.',null,{code,nextStep:'Inspect the existing operation; do not retry paid work automatically.'});
    default: return result('error','The request could not be completed.',null,{code:'internal_error',nextStep:'Inspect the current comic or operation before trying again.'});
  }
}
