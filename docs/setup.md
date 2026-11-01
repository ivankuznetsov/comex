# Local development

Requires Bun 1.4.4 and Node.js 22.13 or newer (the local store uses node:sqlite). Install project dependencies with `bun install --frozen-lockfile`, then run `bun run dev` and open the local URL printed by Next.js. Run `bun run test`, `bun run typecheck`, and `bun run build` for local verification.

For the temporary Vercel demo, set the build-time `COMEX_DEMO_BACKEND_URL` to the HTTPS origin of the local gateway's public tunnel. Next.js forwards API requests there; the database, generated images, provider credentials, and background jobs remain on the local machine. The gateway must allow the exact Vercel browser origin and remain running with the tunnel and local app. If the quick-tunnel URL changes, update the Vercel environment value and redeploy. Guest cookies are scoped to their browser hostname, so drafts from the tunnel do not automatically appear in a Vercel browser session; the public shelf uses the same database. Vercel external rewrites can time out after 120 seconds, while some image and revision operations may continue on the local server. Investigate an uncertain result before retrying. Email sign-in is not configured for this bridge. Managed storage and durable jobs are required for independent Vercel hosting.

Start `scripts/demo-proxy.py` with `--upstream-port` pointing to the local app, `--listen-port` for the tunnel, and one `--allowed-origin https://...` per exact browser origin (the Vercel site and, if desired, the tunnel). It listens only on loopback and forwards a limited set of routes. The origin check protects browser requests from cross-site writes; it is not client authentication. Anyone with access to the demo can consume the configured provider budget.

Page drawing starts a persisted local job and the browser polls for progress, avoiding a long-held page request. It runs only while the local Node server is running; this is not a managed queue and is not suitable for serverless deployment. If the process stops mid-job, stop every Comex process, list jobs using `COMEX_DB_PATH=/path/to/comex.sqlite bun scripts/resolve-page-job.ts --list`, and inspect the draft, provider reservation, and any per-panel operation before using `COMEX_DB_PATH=/path/to/comex.sqlite bun scripts/resolve-page-job.ts JOB_ID --mark-unknown --confirm`. After resolving all corresponding budget/panel locks and determining no provider work remains in flight, use the same command with `--resolve --confirm` to allow an explicit retry. Neither step refunds or retries a provider call. The browser shows interrupted/unknown jobs until the operator resolves them.

Character-reference generation, single-panel edits, and story-revision application still use long-held requests. A tunnel may time out before those requests finish; inspect the draft and any unknown operation before retrying, since provider work may have continued after the client disconnected.

Creators can start a browser-local draft without an email address. To access drafts across browsers, explicitly choose to save the browser's drafts and verify the email by signing in from that same browser; only then are those drafts claimed by the verified account. Other browsers can sign in with a code but cannot claim the first browser's local drafts. Guest sessions expire after 30 days on both server and browser; draft data is retained but inaccessible through an expired guest session. If an email was mistyped, the guest owner can explicitly choose to save the browser's drafts to the corrected address before verifying it. Email sign-in requires `COMEX_APP_URL` set to the exact browser origin, a verified `COMEX_EMAIL_FROM` sender, `RESEND_API_KEY`, and a randomly generated `COMEX_AUTH_SECRET` of at least 32 characters, stored securely in 1Password. The app emails a single-use eight-digit code that expires in 15 minutes. The gallery remains public. Missing delivery configuration is reported in the sign-in screen. The local SQLite store is not suitable for Vercel deployment without managed persistence and a public authentication boundary.

Real generation requires an OpenAI API key and accessible text and image models. Keep credentials in 1Password; resolve them into the local process only when needed. Never commit `.env.local` or paste credentials into issues, prompts, or logs. See `.env.example` for configuration names. Provisioning, hosted storage, Vercel linkage, and secret synchronization are not validated by a local run.

For local generation, set `COMEX_MAX_PROVIDER_CALLS` to an operator-chosen positive integer or explicitly to `unlimited`, and optionally set `COMEX_MAX_CONCURRENT_CALLS` (default 1). A numeric setting limits the number of provider calls, not their monetary cost; `unlimited` removes the total-call cap while retaining concurrency control. Missing, invalid, or exhausted limits prevent dispatch. The SQLite budget is persistent and records calls even in unlimited mode; uncertain outcomes remain reserved to prevent a silent duplicate.

Story-question, planning, and revision requests also hold a per-draft reservation in the `comic_text_operations` table in `COMEX_DB_PATH` (default `data/comex.sqlite`). A process crash or an indeterminate provider response leaves this reservation in place. To recover, first stop every Comex process using the database, back up the database, inspect the draft and provider outcome, and reconcile the separate provider budget reservation without refunding its call. Only after verifying that no request remains in flight, run `COMEX_DB_PATH=/path/to/comex.sqlite bun scripts/resolve-text-operation.ts COMIC_ID --confirm`. This releases the specific reservation and makes interrupted initial questions available for an explicit retry; it does not dispatch or refund calls. Restart Comex afterwards. Retrying a request whose outcome is unclear may result in another charge.

When the OpenAI item exists in 1Password, copy `.env.example` to `.env.local`, set `OPENAI_API_KEY` to its `op://vault/item/field` reference, set the call limit, and start with `op run --env-file=.env.local -- bun run dev --hostname 127.0.0.1`. Do not paste the secret into source files or chat. The selected account must allow that item and model access.

## Hosted MCP

The hosted browser and MCP endpoint share a Postgres database, a private Vercel Blob store, and Vercel Workflow. Configure the canonical HTTPS `COMEX_APP_URL`, `COMEX_RUNTIME=hosted`, `DATABASE_URL`, `BLOB_READ_WRITE_TOKEN`, the OpenAI models and call limit, and separate secrets for browser email authentication (`COMEX_AUTH_SECRET`) and MCP authentication (`COMEX_MCP_AUTH_SECRET`, at least 32 characters). Email sign-in also needs `COMEX_EMAIL_FROM` and `RESEND_API_KEY`. See `.env.example`; supply secrets through the deployment's secret manager.

Apply the versioned database migrations deliberately to the intended database with `bun scripts/hosted-storage.ts migrate`. The app does not migrate or import local drafts automatically. See [MCP authentication and local-draft handoff](mcp-auth.md) for consent, scoped connections, and importing an existing local workspace.

The generation scheduler uses Vercel Workflow and the cron in `vercel.json`. Configure a random `CRON_SECRET` of at least 16 characters and expose Vercel system environment variables, including `VERCEL_DEPLOYMENT_ID`, to the deployment. The bundled daily cron works on the Hobby plan and runs on production deployments, not previews. Authenticated MCP requests and browser polling also retry pending dispatches. If a client disconnects before a pending dispatch starts, recovery can wait until the next daily cron; Vercel does not guarantee the exact minute. See [Vercel cron usage](https://vercel.com/docs/cron-jobs/usage-and-pricing) and [cron setup](https://vercel.com/docs/cron-jobs/quickstart).

`COMEX_MCP_ALLOWED_ORIGINS` may contain additional comma-separated HTTPS browser origins that are allowed to call `/mcp`; native MCP clients do not need an Origin header. Missing hosted configuration prevents private and paid operations from falling back to local state. The [connection guide](mcp.md) and [acceptance procedure](research/mcp-acceptance.md) distinguish local tests from deployed client verification. For an interrupted hosted provider step, use the [hosted reconciliation procedure](research/mcp-reconciliation.md), not the SQLite recovery commands below.

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

To release a specific stuck image operation, first stop **all** Comex processes, back up the draft database, investigate the provider's outcome and reconcile any corresponding budget reservation as described above. Set `COMEX_DB_PATH` to the server's draft database. Find the comic ID in its URL, and list the exact image operations:

```sh
COMEX_DB_PATH=/path/to/comex.sqlite bun scripts/resolve-image-operation.ts COMIC_ID --list
```

After investigation, release the selected `panel:<panel-id>` or `character:<character-id>` operation:

```sh
COMEX_DB_PATH=/path/to/comex.sqlite bun scripts/resolve-image-operation.ts COMIC_ID panel:PANEL_ID --confirm
```

The command releases only that operation, increments the draft revision and never refunds the call or retries it. If the provider completed work that was not saved, a later user-initiated retry can incur another charge. Do not run it while any request may still be in flight. Story-text operations use the separate recovery procedure above.

If the app stops after saving a panel image but before its visual review finishes, that panel may remain in `checking`. Stop **all** Comex processes and reconcile any outstanding provider reservation first. After backing up the draft database, find the comic ID in its URL and list the panels awaiting review:

```sh
COMEX_DB_PATH=/path/to/comex.sqlite bun scripts/resolve-visual-review.ts COMIC_ID --list
```

Choose the affected panel ID and explicitly mark that review incomplete:

```sh
COMEX_DB_PATH=/path/to/comex.sqlite bun scripts/resolve-visual-review.ts COMIC_ID PANEL_ID --confirm
```

This preserves the image and records a failed review for that exact image and version. The result remains advisory and the creator can continue using the saved image. No provider call is retried or refunded. Never run this command while a review may still be in flight.

In the local runtime, character cards can use a generated reference or upload one static PNG, JPEG, or WebP up to 4 MiB and 16,777,216 pixels. Select “Upload a reference for new character” when adding a card to avoid generating an image first. Comex normalizes the upload to PNG and shows the saved preview. Review the appearance and outfit fields and approve that exact image before planning. Replacing a reference clears its approval. Reference uploads are available before planning pages. Characters already used in a planned story remain locked; newly added characters can still generate references. The hosted runtime does not yet support uploads.

The standalone Responses/Decisions comparison is offline by default: run `bun run eval:decisions`. Its synthetic fixtures are unreviewed candidates, not evidence of model accuracy. A live trial requires separately authorized paid calls, reviewed labels, a finite call budget and a dedicated budget database; see [evaluation setup](../evals/README.md). It never changes drafts or enables automatic repairs.
