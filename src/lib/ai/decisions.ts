import {AIError} from './errors';
import type {Reference} from './service';
import {BudgetError, finalizeBudgetedResponse} from '../budget';
import {observeSafely, responseObservation, type ResponseObservation} from './response-metadata';

export type DecisionQuestion = {name:string;instructions:string;choices:string[]};
export type DecisionAnswer = {type:'choice';name:string;choice:string;confidence:number;probabilities:{value:string;probability:number}[]} | {type:'refusal';name:string;choice?:never};
export type DecisionEvidence = {evidence:string;images:Pick<Reference,'mimeType'|'bytes'>[];questions:DecisionQuestion[]};
type FetchLike = (input:string|URL|Request, init?:RequestInit) => Promise<Response>;

export function createDecisionService(options:{apiKey?:string;fetch?:FetchLike;observeResponse?:(value:ResponseObservation)=>void} = {}) {
  const fetcher = options.fetch ?? globalThis.fetch;
  const key = options.apiKey ?? process.env.OPENAI_API_KEY ?? '';
  return {
    async decide(input:DecisionEvidence):Promise<{model:string;answers:DecisionAnswer[];usage:unknown;latencyMs:number}> {
      if (!key.trim()) throw new AIError('missing_key','OPENAI_API_KEY is not configured.');
      const names = new Set(input.questions.map(q => q.name));
      if (!input.evidence.trim() || !input.questions.length || input.questions.length > 400 || names.size !== input.questions.length || input.questions.some(q => !q.name.trim() || !q.instructions.trim() || q.choices.length < 2 || q.choices.length > 255 || q.choices.some(choice=>!choice.trim()) || new Set(q.choices).size !== q.choices.length)) throw new AIError('invalid_input','Invalid decision questions.');
      const content = [{type:'input_text',text:input.evidence},...input.images.map(image=>({type:'input_image',image_url:`data:${image.mimeType};base64,${Buffer.from(image.bytes).toString('base64')}`}))];
      const body = {model:'gpt-6-luna',input:[{role:'user',content}],questions:input.questions.map(q=>({type:'choice',name:q.name,instructions:q.instructions,choices:q.choices.map(value=>({value}))}))};
      let response:Response; const started=performance.now();
      try { response=await fetcher('https://api.openai.com/v1/decisions',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(180_000)}); }
      catch (error) { if (error instanceof BudgetError) throw error; throw new AIError('unknown_outcome','The decision request outcome is unknown.'); }
      if (!response.ok) throw new AIError(response.status===408 || response.status>=500?'unknown_outcome':'provider_error',`The decision request failed (${response.status}).`);
      let result:any, answers:Map<string,DecisionAnswer>, latencyMs:number;
      try {
        result=await response.json(); latencyMs=performance.now()-started;
        observeSafely(options.observeResponse,result,latencyMs);
        if (!result || !responseObservation(result,latencyMs).model || !Array.isArray(result.answers) || result.answers.length !== input.questions.length) throw new Error('Invalid answers');
        answers = new Map<string,DecisionAnswer>();
        const probability = (value:unknown):value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
        for (const answer of result.answers) {
          const question=input.questions.find(q=>q.name===answer?.name);
          if (!question || answers.has(answer.name)) throw new Error('Unexpected or duplicate answer');
          if (answer.type==='refusal') { answers.set(answer.name,{type:'refusal',name:answer.name}); continue; }
          if (answer.type!=='choice' || !question.choices.includes(answer.choice) || !probability(answer.confidence) || !Array.isArray(answer.probabilities) || answer.probabilities.length!==question.choices.length || answer.probabilities.some((p:any)=>!question.choices.includes(p?.value) || !probability(p?.probability)) || new Set(answer.probabilities.map((p:any)=>p.value)).size!==question.choices.length || Math.abs(answer.probabilities.reduce((sum:number,p:{probability:number})=>sum+p.probability,0)-1)>0.01) throw new Error('Invalid answer');
          answers.set(answer.name,{type:'choice',name:answer.name,choice:answer.choice,confidence:answer.confidence,probabilities:answer.probabilities.map((p:{value:string;probability:number})=>({value:p.value,probability:p.probability}))});
        }
      } catch {
        await finalizeBudgetedResponse(response,'unknown');
        throw new AIError('unknown_outcome','The decision response has invalid answers or could not be read. Check the operation before retrying.');
      }
      await finalizeBudgetedResponse(response,'completed');
      return {model:result.model,answers:input.questions.map(q=>answers.get(q.name)!),usage:responseObservation(result,latencyMs).usage,latencyMs};
    },
  };
}
