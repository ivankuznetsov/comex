import {describe,expect,test} from 'bun:test';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {priceUsage} from '../src/lib/ai/cost-ledger';
import {createAIService,type AIOptions} from '../src/lib/ai/service';
import {createBudgetedFetch} from '../src/lib/budget';
import {safeResult} from '../src/lib/mcp/results';
import {view} from '../src/lib/application/views';
import {createBlankComic} from '../src/lib/domain/comic';

const textUsage={input_tokens:1000,output_tokens:500,total_tokens:1500,input_tokens_details:{cached_tokens:200},output_tokens_details:{reasoning_tokens:300}};
const response=()=>Response.json({model:'gpt-6.1-terra',usage:textUsage,status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify({questions:[]})}]}]},{headers:{'x-request-id':'req_123'}});
const input={plot:'A trip',style:'ink-manga',answers:{},limit:5};
function fixture(fetcher:NonNullable<AIOptions['fetch']>) {
 const root=mkdtempSync(join(tmpdir(),'comex-cost-')),path=join(root,'budget.sqlite');
 const ai=createAIService({apiKey:'test-only',textModel:'gpt-6.1-terra',imageModel:'gpt-image-2.5-flare',fetch:createBudgetedFetch(path,fetcher,{maxCalls:10,maxConcurrent:2},'comic-a')});
 return {ai,rows:()=>{const db=new DatabaseSync(path);try{return db.prepare('SELECT * FROM provider_costs').all() as any[];}finally{db.close();}},close:()=>rmSync(root,{recursive:true,force:true})};
}
describe('internal provider costs',()=>{
 test('text cost uses cached input and includes reasoning only once',()=>{
  const p=priceUsage('/v1/responses','gpt-6.1-terra',textUsage);
  expect(p.costUsd).toBe('0.003310000');expect(p.state).toBe('priced');
  expect(priceUsage('/v1/responses','gpt-6.1-terra',{input_tokens:300000,output_tokens:1000}).costUsd).toBe('0.607500000');
 });
 test('direct image requests use text/image input breakdown without a cache discount',()=>{
  const p=priceUsage('/v1/images/edits','gpt-image-2.5-flare',{input_tokens:3000,output_tokens:4000,total_tokens:7000,input_tokens_details:{text_tokens:1000,image_tokens:2000,cached_tokens:2000}});
  expect(p.costUsd).toBe('0.141000000');
 });
 test('missing, invalid and unknown usage is not reported as free',()=>{
  for(const usage of [{},{input_tokens:-1,output_tokens:10},{input_tokens:10,output_tokens:10,total_tokens:0},{input_tokens:10,output_tokens:10,input_tokens_details:{cached_tokens:11}}])expect(priceUsage('/v1/responses','gpt-6.1-terra',usage).costUsd).toBeNull();
  expect(priceUsage('/v1/responses','other',textUsage).state).toBe('unsupported_model');
  expect(priceUsage('/v1/images/edits','gpt-image-2.5-flare',textUsage).costUsd).toBeNull();
 });
 test('records provider usage and comic ID in SQLite, without prompt/secret data',async()=>{
  const f=fixture((async()=>response()) as NonNullable<AIOptions['fetch']>);
  try{await f.ai.questions(input);const [r]=f.rows();expect(r.comic_id).toBe('comic-a');expect(r.cost_state).toBe('priced');expect(Number(r.cost_usd)).toBeCloseTo(0.00331,9);expect(r.request_id).toBe('req_123');expect(r.model).toBe('gpt-6.1-terra');expect(JSON.stringify(r)).not.toContain('test-only');expect(JSON.stringify(r)).not.toContain('A trip');expect(JSON.parse(r.usage_json)).toEqual(textUsage);}finally{f.close();}
 });
 test('image generation records actual usage even without a response model field',async()=>{
  const usage={input_tokens:100,output_tokens:500,input_tokens_details:{text_tokens:100,image_tokens:0}};
  const f=fixture((async()=>Response.json({data:[{b64_json:Buffer.from('image').toString('base64')}],usage})) as NonNullable<AIOptions['fetch']>);
  try{await f.ai.characterReference({character:{id:'hero',name:'Hero',role:'hero',appearance:'blue',outfit:'coat'},styleRules:'ink'});const [r]=f.rows();expect(r.model).toBe('gpt-image-2.5-flare');expect(Number(r.cost_usd)).toBeCloseTo(0.0155,9);}finally{f.close();}
 });
 test('lost responses remain unconfirmed with NULL cost; do not invent or refund usage',async()=>{
  const f=fixture((async()=>{throw Error('network lost');}) as NonNullable<AIOptions['fetch']>);
  try{await expect(f.ai.questions(input)).rejects.toMatchObject({code:'unknown_outcome'});const [r]=f.rows();expect(r.cost_state).toBe('unconfirmed');expect(r.cost_usd).toBeNull();}finally{f.close();}
 });
 test('usage is retained for paid responses that fail domain validation',async()=>{
  const f=fixture((async()=>Response.json({usage:textUsage,status:'completed',output:[]})) as NonNullable<AIOptions['fetch']>);
  try{await expect(f.ai.questions(input)).rejects.toThrow();expect(f.rows()[0].cost_state).toBe('priced');}finally{f.close();}
 });
 test('no cost data reaches current comic views or old cached operation results',()=>{
  const d={...createBlankComic('id','owner'),characters:[],questions:[],answers:{},costEstimate:{total:99}};
  expect(view(d,null,1)).not.toHaveProperty('costEstimate');
  const clean=safeResult({comic:{title:'Keep',costEstimate:{total:99}},providerCosts:[{cost:1}],costLedger:{}},{actor:'owner',scopes:[]},null);
  expect(clean).toEqual({comic:{title:'Keep'}});
 });
});
