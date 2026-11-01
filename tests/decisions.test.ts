import {expect,test} from 'bun:test';
import {createDecisionService} from '../src/lib/ai/decisions';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createBudgetedFetch, ProviderBudget, setBudgetFinalizer} from '../src/lib/budget';

const questions = [
  {name:'route',instructions:'Classify the request.',choices:['cosmetic','restore','story','clarify']},
  {name:'visible',instructions:'Is the prop visible?',choices:['match','mismatch','cannot_determine']},
];
const choice = {type:'choice',name:'route',choice:'restore',confidence:0.8,probabilities:[{value:'cosmetic',probability:0.05},{value:'restore',probability:0.8},{value:'story',probability:0.1},{value:'clarify',probability:0.05}]};

test('validates named choices and per-question refusals with inline image evidence', async () => {
  let sent:any;
  const service=createDecisionService({apiKey:'test',fetch:async (_url,init)=>{sent=JSON.parse(String(init?.body));return Response.json({model:'gpt-6-luna',usage:{input_tokens:12},answers:[choice,{name:'visible',type:'refusal'}]});}});
  const result=await service.decide({evidence:'The intended state is dark.',images:[{mimeType:'image/png',bytes:new Uint8Array([1,2])}],questions});
  expect(result.answers[0].choice).toBe('restore'); expect(result.answers[1].type).toBe('refusal');
  expect(sent.model).toBe('gpt-6-luna'); expect(sent.input[0].content[1].image_url).toStartWith('data:image/png;base64,');
  expect(sent.questions).toHaveLength(2); expect(result.usage).toEqual({input_tokens:12});
});

test('rejects missing, duplicate, unexpected, or malformed answers', async () => {
  let answers:unknown[]=[choice];
  const service=createDecisionService({apiKey:'test',fetch:async()=>Response.json({model:'gpt-6-luna',answers})});
  const input={evidence:'scene',images:[],questions};
  await expect(service.decide(input)).rejects.toThrow('answers');
  answers=[choice,choice]; await expect(service.decide(input)).rejects.toThrow('answers');
  answers=[choice,{type:'choice',name:'visible',choice:'match',confidence:3,probabilities:[]}]; await expect(service.decide(input)).rejects.toThrow('answer');
});

test('records usage from malformed answers and includes body transfer in latency', async () => {
  let observed:{model:string|null;usage:unknown;latencyMs:number}|undefined;
  let release!:()=>void,reading!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{reading=resolve;});
  const service=createDecisionService({apiKey:'test',observeResponse:value=>{observed=value;},fetch:async()=>{
    const body=JSON.stringify({model:'gpt-6-luna',usage:{input_tokens:42},answers:[]});
    return new Response(new ReadableStream({async pull(controller){reading();await gate;controller.enqueue(new TextEncoder().encode(body));controller.close();}}));
  }});
  const pending=service.decide({evidence:'scene',images:[],questions});await started;expect(observed).toBeUndefined();release();
  await expect(pending).rejects.toThrow('answers');
  expect(observed?.usage).toEqual({input_tokens:42});expect(observed?.latencyMs).toBeGreaterThanOrEqual(0);
});

test('a malformed or truncated decision response stays unknown and prevents a second dispatch', async () => {
  for (const body of ['{"model":', JSON.stringify({model:'gpt-6-luna',answers:[]})]) {
    const dir=await mkdtemp(join(tmpdir(),'comex-decisions-budget-'));
    const path=join(dir,'budget.sqlite'); let calls=0;
    try {
      const fetch=createBudgetedFetch(path,async()=>{calls++; return new Response(body);},{maxCalls:3,maxConcurrent:1});
      const service=createDecisionService({apiKey:'test',fetch});
      const input={evidence:'scene',images:[],questions};
      await expect(service.decide(input)).rejects.toThrow();
      const budget=new ProviderBudget(path,{maxCalls:3,maxConcurrent:1});
      expect(budget.summary()).toEqual({used:1,active:1,unknown:1});budget.close();
      await expect(service.decide(input)).rejects.toThrow(); expect(calls).toBe(1);
    } finally {await rm(dir,{recursive:true,force:true});}
  }
});

test('a complete valid response including an individual refusal releases its reservation', async () => {
  const dir=await mkdtemp(join(tmpdir(),'comex-decisions-budget-'));
  const path=join(dir,'budget.sqlite'); let calls=0;
  try {
    const fetch=createBudgetedFetch(path,async()=>{calls++;return Response.json({model:'gpt-6-luna',answers:[choice,{name:'visible',type:'refusal'}]});},{maxCalls:2,maxConcurrent:1});
    const service=createDecisionService({apiKey:'test',fetch});const input={evidence:'scene',images:[],questions};
    expect((await service.decide(input)).answers[1].type).toBe('refusal');
    await service.decide(input);expect(calls).toBe(2);
    const budget=new ProviderBudget(path,{maxCalls:2,maxConcurrent:1});expect(budget.summary()).toEqual({used:2,active:0,unknown:0});budget.close();
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('waits for asynchronous budget finalization on valid and invalid responses', async () => {
  for (const valid of [true,false]) {
    let release!:()=>void,started!:()=>void,settled=false,state:string|undefined;
    const gate=new Promise<void>(resolve=>{release=resolve;}),finalizing=new Promise<void>(resolve=>{started=resolve;});
    const response=Response.json({model:'gpt-6-luna',answers:valid?[choice,{name:'visible',type:'refusal'}]:[]});
    setBudgetFinalizer(response,async result=>{state=result;started();await gate;});
    const service=createDecisionService({apiKey:'test',fetch:async()=>response});
    const pending=service.decide({evidence:'scene',images:[],questions}).then(()=>{settled=true;},()=>{settled=true;});
    await finalizing;
    expect(state).toBe(valid?'completed':'unknown');
    expect(settled).toBe(false);
    release();await pending;expect(settled).toBe(true);
  }
});
