# Internal comic cost accounting

Cost data is operator-only database data. **Do not expose prices, estimates, usage,
or the ledger through the editor, public/browser API, MCP, or operation results.**
The prior user-facing estimate was removed at Ivan's explicit request (2026-11-01).

## Storage

Postgres migration `006_provider_costs.sql` creates `provider_costs`, keyed by the
existing provider reservation ID, and the internal `comic_cost_totals` SQL view.
SQLite records the same ledger in the configured budget DB. Rows include comic ID,
operation/step IDs when available, model, endpoint, provider request ID, sanitized
usage counts, USD cost, a rate snapshot/version and timestamps. No prompts, images,
auth tokens, or raw provider envelopes are stored in this ledger.

`cost_usd` is calculated from **actual returned usage**, not an image-count forecast.
A cached durable step does not dispatch or insert another cost row. Reference
images, text planning, revisions, classifications and advisory checks are metered.
A response validation failure still records available usage; an accounting-write
failure must not discard already-paid artwork or cause an automatic paid retry.
An unconfirmed/missing/unsupported usage record has NULL cost, never a zero guess.

`comic_cost_totals.recorded_cost_usd` sums only priced requests; always inspect
`unpriced_requests` and the tracking interval. NULL means no priced calls. Historical
durable calls are attributed where possible, but old usage was not retained and
cannot be reconstructed from the generated image. Older non-durable calls without
comic attribution remain outside per-comic totals. Totals are calculated provider
costs, not an invoice reconciliation, and do not include credits/taxes/hosting.

## Pricing (verified 2026-11-01)

https://developers.openai.com/api/docs/pricing
https://developers.openai.com/api/docs/guides/image-generation#cost-and-latency

GPT Image 2.5 Flare/Sunburst direct Images API: $5/M text input, $8/M image input,
$30/M image output; no cached-input discount. Text/image input breakdown is required.
GPT-6.1 Terra standard Responses: $1/M uncached input, $0.05/M cached input,
$5/M output, including reasoning tokens. Above 272k input tokens: $2/$0.10/$7.50.
Unknown models, non-default service tiers, invalid/incomplete counts, cache-write usage without a known TTL,
or unrecognized mixed image/text outputs remain unpriced for reconciliation.

## Deployment and queries

Apply migrations before deploying the worker code:
`DATABASE_URL=... bun scripts/hosted-storage.ts migrate`

Internal SQL only:
```sql
SELECT * FROM comic_cost_totals ORDER BY last_updated_at DESC NULLS LAST;
SELECT model,cost_state,count(*),sum(cost_usd)
FROM provider_costs WHERE comic_id = '<comic-id>' GROUP BY model,cost_state;
```

The call-count budget and concurrency/recovery policy are unchanged. No new paid
service or user-facing billing flow is introduced.
