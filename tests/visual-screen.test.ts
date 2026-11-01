import {expect,test} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAIService,AIError,type Reference} from '../src/lib/ai/service';
import {reviewVisual,visualScreenQuestions,type VisualScreenInput} from '../src/lib/ai/visual-screen';
import {createBudgetedFetch,ProviderBudget} from '../src/lib/budget';

const state={location:'lighthouse',time:'night',props:[{key:'lamp',value:'off'}],outfits:[],injuries:[],knowledge:[]};
const refs:Reference[]=[{role:'approved character',id:'pip',bytes:new Uint8Array([1]),mimeType:'image/png'},{role:'previous panel',id:'p0',bytes:new Uint8Array([2]),mimeType:'image/png'},{role:'generated panel',id:'p1',bytes:new Uint8Array([3]),mimeType:'image/png'}];
const input:VisualScreenInput={bible:{setting:'tower'},styleRules:'ink',beats:{id:'p1',index:1,character_ids:['pip'],action:'Pip turns off the lamp',framing:'wide',state_before:state,state_after:state},characters:[{id:'pip',name:'Pip',role:'keeper',appearance:'short hair',outfit:'coat'}],references:refs};
const finding={severity:'warning',dimension:'prop',panel_id:'p1',character_id:null,reference_id:null,expected:'lamp off',observed:'lamp lit',repair:'darken lamp'};

function fake(answer:'match'|'mismatch'|'cannot_determine'|'refusal'|'error') {
  const calls:{url:string;body:any}[]=[];
  const fetch=async (url:string|URL|Request,init?:RequestInit)=>{
    const body=JSON.parse(String(init?.body));calls.push({url:String(url),body});
    if(String(url).endsWith('/responses'))return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({outcome:'findings',findings:[finding]})}]}]});
    if(answer==='error')return Response.json({error:{message:'unavailable'}},{status:404});
    return Response.json({model:'gpt-6-luna',answers:body.questions.map((q:{name:string;choices:{value:string}[]},i:number)=>{
      if(i===0 && answer==='refusal')return {type:'refusal',name:q.name};
      const selected=i===0?answer:'match';
      return {type:'choice',name:q.name,choice:selected,confidence:1,probabilities:q.choices.map(c=>({value:c.value,probability:c.value===selected?1:0}))};
    })});
  };
  return {calls,fetch};
}

test('screens independent visible facts using the generated image and labelled anchors',async()=>{
  const f=fake('match'),provider=createAIService({apiKey:'test',fetch:f.fetch});
  const result=await reviewVisual({screen:()=>provider.visualScreen(input),diagnose:()=>provider.visualJudge(input)});
  expect(result).toEqual({outcome:'pass',findings:[]});expect(f.calls).toHaveLength(1);
  expect(f.calls[0].url).toEndWith('/v1/decisions');const body=f.calls[0].body;
  expect(body.model).toBe('gpt-6-luna');expect(body.questions.map((q:any)=>q.name)).toEqual(['action','location','framing','style','character_0','props_0']);
  expect(body.questions.every((q:any)=>q.choices.map((c:any)=>c.value).includes('cannot_determine'))).toBe(true);
  const evidence=JSON.parse(body.input[0].content[0].text);
  expect(evidence.reference_manifest).toEqual(['Image 1: approved character, ID pip','Image 2: previous panel, ID p0','Image 3: generated panel, ID p1']);
  expect(evidence.characters[0].id).toBe('pip');expect(evidence.beats.state_after.props[0].value).toBe('off');
  expect(body.input[0].content.slice(1).map((x:any)=>x.image_url)).toEqual(refs.map(r=>`data:image/png;base64,${Buffer.from(r.bytes).toString('base64')}`));
});

for(const answer of ['mismatch','cannot_determine','refusal','error'] as const) {
  test(`${answer} falls back to a detailed Responses review`,async()=>{
    const f=fake(answer),provider=createAIService({apiKey:'test',fetch:f.fetch});
    const result=await reviewVisual({screen:()=>provider.visualScreen(input),diagnose:()=>provider.visualJudge(input)});
    expect(result).toMatchObject({outcome:'findings',findings:[finding]});
    expect(f.calls.map(c=>c.url.split('/').pop())).toEqual(['decisions','responses']);
  });
}

test('an unknown decision outcome remains reserved and never dispatches Responses',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'comex-screen-'));let calls=0;
  try {
    const path=join(dir,'budget.sqlite');
    const fetch=createBudgetedFetch(path,async()=>{calls++;throw new Error('lost response');},{maxCalls:3,maxConcurrent:1});
    const provider=createAIService({apiKey:'test',fetch});
    await expect(reviewVisual({screen:()=>provider.visualScreen(input),diagnose:()=>provider.visualJudge(input)})).rejects.toMatchObject({code:'unknown_outcome'});
    expect(calls).toBe(1);const budget=new ProviderBudget(path,{maxCalls:3,maxConcurrent:1});
    expect(budget.summary()).toEqual({used:1,active:1,unknown:1});budget.close();
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('an oversized set of facts skips screening without a Decisions dispatch',async()=>{
  const f=fake('match'),provider=createAIService({apiKey:'test',fetch:f.fetch});
  const large={...input,beats:{...input.beats,state_after:{...state,props:Array.from({length:400},(_,i)=>({key:String(i),value:'visible'}))}}};
  expect(()=>visualScreenQuestions(large)).toThrow(AIError);
  const result=await reviewVisual({screen:()=>provider.visualScreen(large),diagnose:()=>provider.visualJudge(large)});
  expect(result.outcome).toBe('findings');expect(f.calls.map(c=>c.url.split('/').pop())).toEqual(['responses']);
});
