# Local development

Requires Bun 1.4.4 and Node.js 22.13 or newer (the local store uses node:sqlite). Install project dependencies with `bun install --frozen-lockfile`, then run `bun run dev` and open the local URL printed by Next.js. Run `bun run test`, `bun run typecheck`, and `bun run build` for local verification.

Real generation requires an OpenAI API key and accessible text and image models. Keep credentials in 1Password; resolve them into the local process only when needed. Never commit `.env.local` or paste credentials into issues, prompts, or logs. See `.env.example` for configuration names. Provisioning, hosted storage, Vercel linkage, and secret synchronization are not validated by a local run.

For local generation, set `COMEX_MAX_PROVIDER_CALLS` to an operator-chosen positive integer and optionally `COMEX_MAX_CONCURRENT_CALLS` (default 1). This limits the number of provider calls, not their monetary cost. Missing or exhausted limits prevent dispatch. The SQLite budget is persistent; uncertain outcomes remain reserved to prevent a silent duplicate.

Story-question, planning, and revision requests also hold a per-draft reservation in the `comic_text_operations` table in `COMEX_DB_PATH` (default `data/comex.sqlite`). A process crash or an indeterminate provider response leaves this reservation in place. To recover, first stop every Comex process using the database, inspect the draft and provider outcome, and reconcile the separate provider budget reservation without refunding its call. Only after verifying that no request remains in flight may the operator remove the specific affected `comic_text_operations` row by its `comic_id`; keep a database backup and do not clear other drafts' reservations. Restart Comex afterwards. Retrying a request whose outcome is unclear may result in another charge.

When the OpenAI item exists in 1Password, copy `.env.example` to `.env.local`, set `OPENAI_API_KEY` to its `op://vault/item/field` reference, set the call limit, and start with `op run --env-file=.env.local -- bun run dev --hostname 127.0.0.1`. Do not paste the secret into source files or chat. The selected account must allow that item and model access.

## Recovering a provider reservation

A process can stop after dispatch but before saving the response. In that case the reservation remains `running`; a lost or invalid response is recorded as `unknown`. Both block the concurrency slot, even after restart. Neither state proves whether the provider charged for or finished the request. Do not automatically retry or delete reservation records.

To investigate, first stop **all** Comex processes using the budget database and make sure no request is still in flight. Set `COMEX_BUDGET_DB_PATH` to the exact database used by the server (it defaults to `COMEX_DB_PATH`, or `data/comex.sqlite` under the app directory). List outstanding reservation IDs without loading API credentials:

```sh
COMEX_BUDGET_DB_PATH="${COMEX_BUDGET_DB_PATH:-${COMEX_DB_PATH:-$PWD/data/comex.sqlite}}" bun -e 'import {ProviderBudget} from "./src/lib/budget"; const b = new ProviderBudget(process.env.COMEX_BUDGET_DB_PATH!); try { console.log(b.listOutstanding()); } finally { b.close(); }'
```

After checking the provider activity and any saved output, an operator can mark a particular abandoned `running` reservation as `unknown`. Replace the placeholder with the ID from the list; do this only while all Comex processes are stopped:

```sh
COMEX_RESERVATION_ID="REPLACE_WITH_ID" COMEX_BUDGET_DB_PATH="${COMEX_BUDGET_DB_PATH:-${COMEX_DB_PATH:-$PWD/data/comex.sqlite}}" bun -e 'import {ProviderBudget} from "./src/lib/budget"; const b = new ProviderBudget(process.env.COMEX_BUDGET_DB_PATH!); try { b.markUnknown(process.env.COMEX_RESERVATION_ID!); } finally { b.close(); }'
```

An operator who has investigated an `unknown` and explicitly accepts that its output may be lost and the call may have been charged can release its concurrency slot. This does not refund the call budget or automatically retry. The `completed` accounting state after resolution records that the slot was manually released; it does not assert that an output was recovered.

```sh
COMEX_RESERVATION_ID="REPLACE_WITH_ID" COMEX_BUDGET_DB_PATH="${COMEX_BUDGET_DB_PATH:-${COMEX_DB_PATH:-$PWD/data/comex.sqlite}}" bun -e 'import {ProviderBudget} from "./src/lib/budget"; const b = new ProviderBudget(process.env.COMEX_BUDGET_DB_PATH!); try { b.resolveUnknown(process.env.COMEX_RESERVATION_ID!); } finally { b.close(); }'
```

This only reconciles the provider budget. A draft may separately retain a `running` or `unknown_outcome` operation after a crash; resolving the budget does not clear that draft lock or recover its output.
