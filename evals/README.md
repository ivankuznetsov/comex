# Decisions comparison

This standalone comparison uses Responses and Decisions on the same evidence. It never updates a comic, approves an image, generates a repair, or changes the application's default model. Offline validation and replay make no provider calls:

```sh
bun run eval:decisions
bun run eval:decisions --replay evals/results/<run>/trial.json
```

The repository-owned synthetic diagrams and manifest under `evals/fixtures/synthetic/` are smoke-test candidates, not a validated benchmark. Every case is marked `reviewed: false`. A person must inspect the images, intended state, question, label and rationale, correct mistakes, and mark cases reviewed before a live run. Calibration and holdout families are separate. The labels and rationales are never passed as model evidence. Private comic artwork, story text, manifests and raw results are not distributed: keep optional private examples under ignored `data/` and results under `evals/results/`. Use `--manifest <path> --image-root <path>` to select another set; image paths must stay under the selected root and match their SHA-256 hashes.

If this checkout has the optional local-only private candidate copy, validate it with `bun run eval:decisions --manifest data/eval-fixtures/private-candidates.json --image-root .`. It is not present in a clean clone and is not a reviewed benchmark.

A separately authorized paid run requires `OPENAI_API_KEY`, a positive finite `COMEX_MAX_PROVIDER_CALLS`, reviewed cases, and an explicit `--live --budget-db <dedicated-sqlite-path> --results evals/results/<run>`. The persistent evaluation budget database must be separate from the application and application budget databases. `COMEX_MAX_CONCURRENT_CALLS` defaults to one. The runner stops on provider errors, does not retry automatically, and records refusals separately. A call budget limits requests, not dollars.

Optional `--rates <file>` accepts the dated and sourced format in `rates.example.json`: rates per million tokens for input, cached input, cache writes and output. Missing usage or rates means unknown cost; batches are counted once. Saved results record per-request usage and latency, model, asset and prompt hashes, and an evidence hash; summaries include routing confusion, unsafe story-to-image routing, visual misses and false alarms, abstentions, failures and paired latency. Costs are estimates, not a spending cap. No live accuracy, latency, availability, or cost has been measured by this offline validation.
