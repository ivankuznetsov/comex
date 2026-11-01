# Comic budget estimates

The editor shows a USD planning range next to the page/panel controls. The shared
comic read projection includes `costEstimate`, so browser and MCP clients receive
the same calculation. It requires no provider calls or database writes.

- **Full comic, from scratch:** a hypothetical first pass: all panels, one generated
  reference per character, story questions, suggestions, planning, narrative review
  and one visual check per panel.
- **Estimated remaining:** subtracts saved/uploaded references, current artwork
  (including artwork with advisory findings), completed setup and an existing story.
  Missing/outdated panels still count. Checking panels count for review, not redraw.
- **One panel edit:** includes cast, previous/target image inputs and two text checks.

Neither figure is actual historic spend or a monetary cap. Existing call-count
budgets/concurrency limits are unchanged. Unknown configured models return null
prices and the UI says unavailable; never silently price a different model.

## Rates and assumptions (verified 2026-11-01)

Sources:
- https://developers.openai.com/api/docs/pricing
- https://developers.openai.com/api/docs/guides/image-generation#cost-and-latency

`gpt-image-2.5-flare` and `gpt-image-2.5-sunburst`: $5/M text input,
$8/M image input, $30/M image output. No cached-input discount for direct Images API.
`gpt-6.1-terra`: standard short-context $1/M input and $5/M output.

Image output uses the official calculator's square-1024 formula:
`ceil(grid² × (2,000,000 + width × height) / 4,000,000)`.
Medium grid=24 gives 439 tokens; max grid=96 gives 7,024 tokens.
Generation still uses automatic size/quality; **this is a scenario range, not
lower/upper billing bounds**. Other sizes/quality, retries, edits, or model prices
can fall outside it. No quality or model defaults are changed by this feature.

Unmeasured input-token assumptions per image: 500–2,000 text tokens plus
1,024–4,096 image tokens per reference. Planned panels use their actual character
IDs; before planning assume all cast members. Include a preceding-panel reference
except for the first panel. Text allowances are explicit in `cost-estimate.ts`:
setup 2k–8k input/0.5k–2k output; story scales with panel count (including reasoning
allowance); visual review 2k–8k input/0.3k–2k output. These are modeling assumptions,
not measured usage. Recalibrate from provider usage if adding a spend ledger later.

Only model identifiers reach clients, never API keys. Rates are server-side and
read configured `OPENAI_TEXT_MODEL`/`OPENAI_IMAGE_MODEL`. No new paid dependencies.
