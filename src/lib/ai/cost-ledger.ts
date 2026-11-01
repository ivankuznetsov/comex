import {DatabaseSync} from 'node:sqlite';

/** Internal provider accounting only: never attach these records to comic/API views. */
export const COST_SCHEMA=`CREATE TABLE IF NOT EXISTS provider_costs (
  reservation_id text PRIMARY KEY, comic_id text NOT NULL, operation_id text, step_id text,
  endpoint text, model text, request_id text, usage_json text, cost_usd numeric(20,10),
  pricing_version text, rates_json text, cost_state text NOT NULL,
  created_at text NOT NULL, updated_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS provider_costs_comic ON provider_costs(comic_id,created_at);`;
export type CostContext={reservationId:string;comicId:string;operationId?:string;stepId?:string};
type Query={query(sql:string,params:(string|null)[]):Promise<unknown>};
type Db=DatabaseSync|Query;
const isSqlite=(db:Db):db is DatabaseSync=>'prepare' in db;
async function query(db:Db,sql:string,params:(string|null)[]) {
  if(isSqlite(db))db.prepare(sql.replace(/\$\d+/g,'?')).run(...params);
  else await db.query(sql,params);
}
/** Open only for a write; response/network failures never leak SQLite handles. */
export function sqliteCostStore(path:string):Query {
  return {async query(sql,params){const db=new DatabaseSync(path);try{db.exec('PRAGMA busy_timeout=5000');db.prepare(sql.replace(/\$\d+/g,'?')).run(...params);}finally{db.close();}}};
}
function identifier(value:unknown):string|null {return typeof value==='string' && /^[a-zA-Z0-9._:/-]{1,160}$/.test(value)?value:null;}
function obj(value:unknown):Record<string,unknown> {return value && typeof value==='object' && !Array.isArray(value)?value as Record<string,unknown>:{};}
function count(value:unknown):number|null {return typeof value==='number' && Number.isSafeInteger(value) && value>=0?value:null;}
export function requestCostMetadata(input:string|URL|Request,init?:RequestInit) {
  const path=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url).pathname;
  const endpoint=['/v1/responses','/v1/images/edits','/v1/images/generations'].includes(path)?path:null;
  let model:string|null=null;
  try{model=identifier(init?.body instanceof FormData?init.body.get('model'):obj(JSON.parse(String(init?.body))).model);}catch{}
  return {endpoint,model};
}
export async function beginCost(db:Db,context:CostContext,input:string|URL|Request,init?:RequestInit) {
  const {endpoint,model}=requestCostMetadata(input,init),now=new Date().toISOString();
  await query(db,`INSERT INTO provider_costs(reservation_id,comic_id,operation_id,step_id,endpoint,model,cost_state,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(reservation_id) DO NOTHING`,[context.reservationId,context.comicId,context.operationId??null,context.stepId??null,endpoint,model,'unconfirmed',now,now]);
  return {endpoint,model};
}

/** Use actual token usage, never image-count assumptions. USD calculated from a rate snapshot. */
export function priceUsage(endpoint:string|null,model:string|null,value:unknown,serviceTier='default') {
  const raw=obj(value),details=obj(raw.input_tokens_details),outDetails=obj(raw.output_tokens_details);
  const usage:Record<string,unknown>={};
  if(endpoint==='/v1/responses')usage.service_tier=serviceTier;
  for(const key of ['input_tokens','output_tokens','total_tokens'])if(count(raw[key])!==null)usage[key]=raw[key];
  for(const [key,source,keys] of [
    ['input_tokens_details',details,['text_tokens','image_tokens','cached_tokens','cache_write_tokens']],
    ['output_tokens_details',outDetails,['image_tokens','text_tokens','reasoning_tokens']],
  ] as const){const clean=Object.fromEntries(keys.filter(k=>count(source[k])!==null).map(k=>[k,source[k]]));if(Object.keys(clean).length)usage[key]=clean;}
  const result={usage,costUsd:null as string|null,rates:null as Record<string,number>|null,state:'usage_missing'};
  const input=count(raw.input_tokens),output=count(raw.output_tokens);
  if(input===null || output===null)return result;
  if(raw.total_tokens!==undefined && count(raw.total_tokens)!==input+output)return {...result,state:'invalid_usage'};
  let nanos:bigint;
  if(endpoint==='/v1/responses' && model==='gpt-6.1-terra'){
    if(serviceTier!=='default')return {...result,state:'unsupported_service_tier'};
    const cached=details.cached_tokens===undefined?0:count(details.cached_tokens);
    if(cached===null || cached>input)return {...result,state:'invalid_usage'};
    if(details.cache_write_tokens!==undefined && details.cache_write_tokens!==0)return {...result,state:'unsupported_cache_write'};
    const rates=input>272000?{input:2,cached:0.10,output:7.5}:{input:1,cached:0.05,output:5};
    result.rates=rates;
    nanos=BigInt(input-cached)*BigInt(rates.input*1000)+BigInt(cached)*BigInt(rates.cached*1000)+BigInt(output)*BigInt(rates.output*1000);
  }else if(endpoint?.startsWith('/v1/images/') && ['gpt-image-2.5-flare','gpt-image-2.5-sunburst'].includes(model??'')){
    const image=count(details.image_tokens),text=count(details.text_tokens);
    if(image===null || text===null)return result;
    if(image+text!==input)return {...result,state:'invalid_usage'};
    // Do not guess a price for an unrecognized mixed output envelope.
    if(outDetails.text_tokens!==undefined && outDetails.text_tokens!==0)return {...result,state:'unsupported_output_mix'};
    if(outDetails.image_tokens!==undefined && count(outDetails.image_tokens)!==output)return {...result,state:'invalid_usage'};
    result.rates={textInput:5,imageInput:8,imageOutput:30};
    nanos=BigInt(text)*5000n+BigInt(image)*8000n+BigInt(output)*30000n;
  }else return {...result,state:'unsupported_model'};
  return {...result,state:'priced',costUsd:`${nanos/1000000000n}.${(nanos%1000000000n).toString().padStart(9,'0')}`};
}

const receipt=Symbol('internal cost receipt');
type CostResponse=Response & {[receipt]?:(body:unknown)=>Promise<void>};
export function attachCostReceipt(response:Response,db:Db,context:CostContext,meta:{endpoint:string|null;model:string|null}) {
  let recorded=false;
  Object.defineProperty(response,receipt,{value:async(body:unknown)=>{
    if(recorded)return;
    const envelope=obj(body),model=identifier(envelope.model)??meta.model;
    // Response snapshots of the requested model use that model's rate card.
    const pricingModel=model?.startsWith('gpt-6.1-terra-') && /^gpt-6\.1-terra-\d{4}-\d{2}-\d{2}$/.test(model)?'gpt-6.1-terra':model;
    const priced=priceUsage(meta.endpoint,pricingModel,obj(envelope.usage),identifier(envelope.service_tier)??'default');
    await query(db,`UPDATE provider_costs SET model=$1,request_id=$2,usage_json=$3,cost_usd=$4,pricing_version=$5,rates_json=$6,cost_state=$7,updated_at=$8 WHERE reservation_id=$9 AND cost_state='unconfirmed'`,[model,identifier(response.headers.get('x-request-id'))??identifier(envelope.id),JSON.stringify(priced.usage),priced.costUsd,'openai-2026-11-01',priced.rates?JSON.stringify(priced.rates):null,priced.state,new Date().toISOString(),context.reservationId]);
    recorded=true;
  }});
}
/** Accounting failure must not discard paid artwork or change retry/finalization behavior. */
export async function recordCostReceipt(response:Response,body:unknown):Promise<void> {
  try{await (response as CostResponse)[receipt]?.(body);}catch{console.warn('Provider cost receipt could not be persisted; reservation remains unconfirmed.');}
}
