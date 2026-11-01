import type {Draft} from './application/contracts';

export type CostRange = {low:number;high:number};
export type ComicCostEstimate = {
  currency:'USD'; available:boolean; pricingDate:string; note:string;
  models:{text:string;image:string}; pages:number; panels:number; references:number;
  remainingPanels:number; remainingReferences:number;
  total:CostRange|null; remaining:CostRange|null; redrawPanel:CostRange|null;
  breakdown:{label:string;count:number;remaining:number;cost:CostRange|null}[];
};

// Rates verified 2026-11-01: https://developers.openai.com/api/docs/pricing
// This is a planning model, NOT metered spend or an enforced monetary limit.
// Direct Images API inputs receive no cache discount. Unknown models are not priced.
const imageRates:Record<string,{text:number;image:number;output:number}>={
  'gpt-image-2.5-flare':{text:5,image:8,output:30},
  'gpt-image-2.5-sunburst':{text:5,image:8,output:30},
};
const textRates:Record<string,{input:number;output:number}>={'gpt-6.1-terra':{input:1,output:5}};
const range=(low:number,high:number):CostRange=>({low,high});
const plus=(a:CostRange,b:CostRange)=>range(a.low+b.low,a.high+b.high);
const times=(a:CostRange,n:number)=>range(a.low*n,a.high*n);
const sum=(items:CostRange[])=>items.reduce(plus,range(0,0));

// Official image-generation calculator, square 1024px, GPT Image 2.5.
// Medium uses a 24x24 grid; max uses 96x96. Auto may choose other sizes/quality.
// https://developers.openai.com/api/docs/guides/image-generation#cost-and-latency
export function squareImageOutputTokens(quality:'medium'|'max'):number {
  const grid=quality==='medium'?24:96;
  return Math.ceil(grid*grid*(2_000_000+1024*1024)/4_000_000);
}

export function estimateComicCost(draft:Draft,models:{text:string;image:string}={text:process.env.OPENAI_TEXT_MODEL || 'gpt-6.1-terra',image:process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2.5-flare'}):ComicCostEstimate {
  const planned=draft.pages.flatMap(page=>page.panels);
  const pages=draft.pages.length || draft.pageCount || 3;
  const panels=planned.length || pages*(draft.panelsPerPage || 3);
  const references=draft.characters.length;
  const remainingReferences=draft.characters.filter(c=>!c.referenceAssetId).length;
  const needsImage=(p:(typeof planned)[number])=>!p.assetId || p.storyRevision!==draft.storyRevision || ['planned','outdated'].includes(p.status);
  const remainingPanels=planned.length?planned.filter(needsImage).length:panels;
  const image=Object.hasOwn(imageRates,models.image)?imageRates[models.image]:undefined;
  const text=Object.hasOwn(textRates,models.text)?textRates[models.text]:undefined;
  const available=!!image && !!text;
  // Input-token allowances are planning assumptions, not provider measurements.
  // Image call: 500–2,000 prompt tokens, 1,024–4,096 image tokens per reference.
  const imageCost=(inputs:number)=>!image?range(0,0):range(
    (500*image.text+inputs*1024*image.image+squareImageOutputTokens('medium')*image.output)/1e6,
    (2000*image.text+inputs*4096*image.image+squareImageOutputTokens('max')*image.output)/1e6,
  );
  const textCost=(inputLow:number,inputHigh:number,outputLow:number,outputHigh:number)=>!text?range(0,0):range((inputLow*text.input+outputLow*text.output)/1e6,(inputHigh*text.input+outputHigh*text.output)/1e6);
  const setup=textCost(2000,8000,500,2000);
  const story=textCost(3000+panels*200,8000+panels*600,1000+panels*400,4000+panels*1000);
  const review=textCost(2000,8000,300,2000);
  const specs=draft.storyboard?.pages.flatMap(page=>page.panels);
  // Generation sends approved cast references plus the preceding panel. Use the
  // actual cast per planned panel when known; before planning assume all cards.
  const panelCosts=Array.from({length:panels},(_,i)=>imageCost((specs?.[i]?.character_ids.length ?? references)+(i>0?1:0)));
  const panelTotal=sum(panelCosts);
  const pendingImages=planned.length?sum(panelCosts.filter((_,i)=>needsImage(planned[i]))):panelTotal;
  const pendingChecks=planned.length?planned.filter(p=>needsImage(p) || p.status==='checking').length:panels;
  const referenceTotal=times(imageCost(0),references);
  const textTotal=sum([times(setup,2),times(story,2),times(review,panels)]);
  const pendingText=sum([
    times(setup,Number(draft.initialQuestions!=='complete')+Number(draft.initialSuggestions!=='complete')),
    times(story,draft.storyboard?0:2),times(review,pendingChecks),
  ]);
  return {currency:'USD',available,pricingDate:'2026-11-01',note:'Planning scenarios for 1024px medium–max images with estimated input tokens; not metered spend or a spending limit. Automatic settings, revisions and retries can cost more.',models,pages,panels,references,remainingPanels,remainingReferences,
    total:available?sum([panelTotal,referenceTotal,textTotal]):null,
    remaining:available?sum([pendingImages,times(imageCost(0),remainingReferences),pendingText]):null,
    // Artwork edits add the target panel, intent classification and visual check.
    redrawPanel:available?sum([imageCost(references+2),times(review,2)]):null,
    breakdown:[
      {label:'Panel artwork',count:panels,remaining:remainingPanels,cost:available?panelTotal:null},
      {label:'Character references',count:references,remaining:remainingReferences,cost:available?referenceTotal:null},
      {label:'Story & checks',count:4+panels,remaining:(draft.initialQuestions==='complete'?0:1)+(draft.initialSuggestions==='complete'?0:1)+(draft.storyboard?0:2)+pendingChecks,cost:available?textTotal:null},
    ],
  };
}
