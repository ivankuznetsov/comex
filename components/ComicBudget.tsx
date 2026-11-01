import type {ComicCostEstimate,CostRange} from '../src/lib/cost-estimate';

const dollars=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'});
function price(value:CostRange) {
  if(value.high===0)return '$0.00';
  return `${dollars.format(Math.floor(value.low*100)/100)}–${dollars.format(Math.ceil(value.high*100)/100)}`;
}
export function ComicBudget({estimate}:{estimate:ComicCostEstimate}) {
  return <section aria-label="Estimated budget" className="mt-5 border-2 border-[#171717] bg-[#fff8e8] p-4">
    <div className="flex flex-wrap items-baseline justify-between gap-2"><h3 className="font-bold">Estimated budget</h3><p className="text-xl font-black" aria-live="polite">{estimate.total ? `${price(estimate.total)} USD` : 'Price unavailable'}</p></div>
    <p className="mt-1 text-sm">Full comic, from scratch · {estimate.pages} {estimate.pages===1?'page':'pages'} · {estimate.panels} panels · {estimate.references} character {estimate.references===1?'reference':'references'}</p>
    {estimate.remaining && <p className="mt-2 text-sm"><strong>Estimated remaining: {price(estimate.remaining)}</strong> · {estimate.remainingPanels} panels and {estimate.remainingReferences} references left to draw.</p>}
    <p className="mt-2 text-sm">Planning estimate, not money spent or a spending limit. Automatic image settings and retries can cost more.</p>
    <details className="mt-3 text-sm"><summary className="cursor-pointer font-bold underline">Cost breakdown</summary>
      <dl className="mt-3 space-y-2">{estimate.breakdown.map(row=><div key={row.label} className="flex flex-wrap justify-between gap-2"><dt>{row.label} ({row.count})</dt><dd>{row.cost?price(row.cost):'Unavailable'}</dd></div>)}</dl>
      {estimate.redrawPanel && <p className="mt-3">One panel edit: roughly {price(estimate.redrawPanel)} extra.</p>}
      <p className="mt-3">Assumes one pass, 1024 × 1024 images at medium–max quality, and estimated input tokens for prompts and references. Uploaded or existing references are excluded from the remaining estimate. More characters, larger images, revisions and regeneration change the cost.</p>
      <p className="mt-2 break-words">Models: {estimate.models.image} and {estimate.models.text}. Rates checked {estimate.pricingDate}. {!estimate.available && 'No estimate is available for these configured models.'} <a href="https://developers.openai.com/api/docs/pricing" target="_blank" rel="noreferrer" className="underline">OpenAI pricing</a></p>
    </details>
  </section>;
}
