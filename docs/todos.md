> Historical testing snapshot. Status and operating details may have changed; see the newer QA report.

# Comex E2E testing — work tracker

Source handoff: `/tmp/compound-engineering-1000/ce-handoff/comex-99ecec3/comex-e2e-testing.md`
Deadline: **1 Nov 2026 17:00 Europe/London** (= 17:00 GMT). Local only — no deploy, publish, merge, or release.

## Authority & budget

- Original cap: 40 provider-call reservations. At handoff: 36 completed, 4 remain.
- **2026-11-01 ~14:07 GMT: user explicitly authorized more real OpenAI API calls if needed.**
  - This lifts the "do not increase" constraint. It does NOT authorize resetting/creating a fresh
    independent budget DB, overwriting the existing sample, or deployment.
  - Any cap raise must keep using the existing budget DB
    (`COMEX_BUDGET_DB_PATH=<workspace>/data/comex.sqlite`) so accounting stays cumulative.
  - Record the new cap + every reservation delta here and in the final report.
- Existing sample (do not overwrite/withdraw/regenerate/delete):
  `http://127.0.0.1:3000/read/30d50d49-611f-4b8f-9836-e3cfd6aeb8c4`

## Live processes (do not kill/restart — pre-existing, not started by this session)

- Port 3000: `op run --env-file=.env.local -- env -u OP_SERVICE_ACCOUNT_TOKEN bun run dev --hostname 127.0.0.1 --port 3000` (real key, workspace checkout).
- Port 3100: `next dev` from `/tmp/comex-publish-20261101` (Playwright default target per `playwright.config.ts`).
- Any live-test server for this session must use a different free port and be cleaned up at the end.

## Test design (from code map, 2026-11-01)

Call accounting (2 characters): questions 1 + references 2 + plan 2 (storyboard + narrative judge)
+ pages 18 (9 panels × (image + vision judge)) = **23**. Panel artwork edit = **3**
(classifier + image + judge). Post-render revision at page 2 panel 1 = preview 1 + apply
(1 judge + 2×3 suffix-of-page re-render) + page 3 regeneration 6 = **14**. Planned live total ≈ **40**.

- **Cap decision:** raise `COMEX_MAX_PROVIDER_CALLS` to **100** for the test instance only
  (36 already used → 64 headroom; ~40 planned + failure slack). The port-3000 server keeps its
  own env (cap 40, already at 36/40 → it will refuse AI calls once shared count ≥ 40; expected,
  do not "fix" by restarting it). Every dispatched call counts, incl. 400/429; 408/5xx/transport
  → `unknown`, which with concurrency 1 blocks ALL further calls until manual DB intervention.
- **Test instance:** copy of checkout at `/tmp/comex-e2e-live/app`, production build,
  `next start` on port **3200**, `COMEX_DB_PATH=/tmp/comex-e2e-live/comics.sqlite`,
  `COMEX_ASSET_PATH=/tmp/comex-e2e-live/assets`,
  `COMEX_BUDGET_DB_PATH=<workspace>/data/comex.sqlite` (shared, cumulative),
  key via `op run --env-file=.env.local` + headless account file, `OP_SERVICE_ACCOUNT_TOKEN`
  stripped from app env. User's checkout and sample are never written by this instance
  (only the shared budget counter increments).
- **Mock-provider browser E2E is impossible out-of-process today** (OpenAI base URL hard-coded,
  no injection through `handleApi`). Substitute: existing in-process mock suite (45 tests, re-run
  green) + browser E2E for 0-call flows + the live run for AI flows. Record as a test-boundary gap.
- **Live story (probes prop-transfer continuity, AE1/AE3 shape):** Nia, a night-mail courier,
  must deliver a brass key that unlocks the harbor lantern; companion + harbor recipient.
  Post-render revision: at page 2 panel 1, Nia keeps the key and unlocks the lantern herself →
  page 1 must stay byte-identical/ready, suffix outdated, recipient must never use the key.
  Panel edit (AE2): lighting-only change to one panel → all other panel hashes identical.

## Checklist

- [x] Map app surface: API routes, UI journey, budget/provider mechanics (how cap is read, isolation envs, fake-provider hooks).
- [x] Read-only sample checks: gallery → reader (all 3 pages), mobile + desktop, dialogue/composition fidelity, continuity judgment incl. page 2 panel 2 key defect.
- [x] Isolated E2E (mock-provider browser run impossible out-of-process — see design note; substituted as recorded) (temp storage, fake providers):
  - [x] gallery → create plot/style → tailored questions → create/approve references → plan beats → page generation + progress → inspect/accept uncertain findings → read/export/publish → fresh anonymous reader.
  - [x] Panel-only edit: neighboring panels byte-identical (hash compare).
  - [x] Story change after rendered pages: correct outdated suffix, stale-result rejection.
  - [x] Reload/recovery (browser reload + 2 server restarts mid-run, state persisted) mid-flow.
  - [x] Session ownership: second browser cannot read private draft.
  - [x] Withdraw + republish safety.
- [x] Live OpenAI E2E (shared budget DB, raised cap, own port):
  - [x] Verify reservation count before first call; record cap change.
  - [x] Full generation run; record per-step latency + reservation delta.
  - [x] Live plot revision AFTER pages rendered (untested per handoff) — if budget/time allow.
  - [x] Judge story/visual continuity (manual, all panels viewed); do not blindly accept evaluator verdict.
- [x] Final report: passes, failures + repro steps, exact scope, test boundaries, remaining risks, call accounting.

## Baseline (verified 2026-11-01 in prior turn)

- `bun run test`: 45 pass / 0 fail. `bun run typecheck`: pass.
- HEAD `99ecec3`, branch `feat/comex-core`; app code uncommitted/untracked (user work — never reset/clean/stash).
- Reservations: 36 completed / 40 cap (`data/comex.sqlite`, `provider_reservations`).
- Build artifact predates final lettering fix; production build not re-run yet.

## Findings log

_(append as testing proceeds — each item: PASS/FAIL/UNVERIFIED, evidence, repro)_

### 2026-11-01 ~14:10 GMT — Existing sample, visual review (composed pages in `/tmp/comex-live/`)

- **FAIL (known, re-confirmed visually):** Page 2 panel 2 (`final-page-2.png`, post-edit version)
  shows a hand turning the wind-up key on Pip's back. The gate latch is visible but not engaged
  by the key. Required action (Pip's attached key inserted into the latch) is NOT depicted.
  The targeted edit did not fix it; the vision judge did not flag it. Continuity is NOT proven.
- **NOTE (budget anomaly):** At 2026-11-01T14:14:11Z one provider reservation
  (`d1668ca6…`, completed in 3.4s — a text call) appeared in the shared budget DB (36 → 37).
  This session had made only GET requests and isolated-DB tests; the sample is provably untouched
  (draft `revision` 55 == edition `sourceRevision` 55, `published_at` still 14:01:43Z, still 1 comic
  row, no new assets). Two peer agent sessions are live on this machine; the port-3000 server has a
  real key. Attribution unknown — a no-save failure path (e.g. storyboard 422 or edit-classify 409)
  fits the evidence. **Accounting baseline for this session's live run = 37.** Concurrent use risks
  `concurrency_limit` (max 1) collisions; the live driver retries those (they don't consume budget).
- **PASS (re-run):** `bun run test` 45/45, `bun run typecheck`, existing Playwright spec (port-3100
  copy, 1.9s), and **production `next build` on current code** (isolated copy) — all green.
  Build emits the known Turbopack dynamic-path file-tracing warning for `src/lib/local-api.ts`.
- **PASS (read-only API, port 3000):** `GET /api/published` lists only the sample; published asset
  fetch 200 PNG (bytes == composed page 1); wrong `edition` pin → 404; draft + draft-asset without
  session cookie → 404; unknown published id → 404. Port-3100 test server has no API key/budget
  config (`COMEX_DB_PATH=/tmp/comex-e2e.sqlite`) — it cannot spend shared budget.
- **Byte-preservation evidence (existing sample):** both original and edited page-2-panel-2 PNGs
  exist as stored assets (history retained); page-2 panels 1/3 hashes match stored assets.
  All 18 asset files present (2 refs + 9 panels + 1 edit + composed pages + history).
### 2026-11-01 14:21–14:36 GMT — Live run progress (instance :3200, baseline 37)

- **PASS (live):** create + 2 characters (0 calls) → tailored questions (1 call, 3.9s, on-brief)
  → answers → 2 reference images (15.5s/13.9s; faithful turnaround sheets, manually verified)
  → approvals → storyboard (2 calls, 38.2s): narrative judge **pass, zero findings**; key chain
  explicit (carry → hand to Bram → Bram inserts key → lights lamp). Ledger passed first try.
- **PASS (judge true-positive):** Page 1 render (6 calls) → vision judge **blocker on all 3 panels**:
  distant lighthouse lamp lit before unlock. Manually confirmed in the art. (Contrast: first sample's
  key defect was missed. Judge recall is inconsistent across defect classes — prop-state caught here.)
- **FAIL (repair path):** Targeted artwork edit "turn the lamp off" → **409 from edit-intent classifier**
  ("may affect the story… unclear whether that affects story-relevant continuity", 1 call). The classifier
  fails closed on exactly the prop-state repairs the vision judge requests, forcing regenerate/revise.
- **PASS (revision repair):** No-plot-change revision ("lantern dark until final panel" baked into beats):
  preview 1 + apply 7 (judge + page-1 re-render). Page 1 cleared to warnings-only; lamp verified dark
  visually; pages 2–3 correctly `outdated` with corrected beats; user-facing notice accurate.
- **FAIL (dialogue fidelity):** Image model baked a speech balloon ("The bridge is up!") into p1p1 art.
  Lettering is composed separately → duplication risk. Judge flags *missing* balloons (false-positive
  warnings on p1p2/p1p3, same miscalibration as sample) but not baked-in text. Inverted calibration.
- **PASS (partial-failure resume):** Page 2 generated+accepted (warning/uncertain only; AE5-style
  `not_observable` correctly reported for tiny silhouetted Bram). Page 3 collided with concurrent
  external budget use → 429 mid-page; panel 1 persisted (uncertain), panels 2–3 cleanly `outdated`.
- **CONCURRENT EXTERNAL SPEND:** From 14:14Z another process (cap >40, concurrency ≥2 — overlapping
  reservations prove it) is dispatching through the same budget DB. Count 83+ at 14:36 and rising.
  Port-3000 (cap 40) cannot be the source beyond 40. Both peer sessions messaged for coordination.
  Response: restart my instance with cap 140 + concurrency 4 (same DB, no reset) to finish the run.
  Cap history: 40 (handoff) → 100 (my instance, 14:16) → 140 (my instance, 14:36). User authorized
  more calls; every raise recorded here. Attribution in interleaved windows is approximate.
- **PASS (visual, manual):** Character continuity across all 9 panels — Mina (curly dark hair,
  yellow hooded raincoat, brown satchel/boots) and Pip (golden clockwork bird, blue eye/scarf,
  wind-up key) are recognizable in every panel they appear in.
- **PASS (visual, manual):** Narrative arc resolves: find Pip → locked gate → latch too high →
  key beat → through gate → tower → key in music box (p3p2 does show key inserted in box) →
  delivery to the old man. Ending is a resolution, matching the post-revision intent.
- **PASS (visual, manual):** Lettering/composition — caption boxes under panels, word-boundary
  wrapping, no mid-word splits observed. Minor: p3p3 second line has a leading space (" home.").
- **Minor wobbles (visual):** rain begins at p1p3 without setup; barred gate (p1–p2p2) becomes a
  solid door (p2p3 onward); Pip's design varies slightly p1p2. None block comprehension.
- Reader HTML is client-rendered (no `<img>` in SSR HTML) — asset delivery needs browser/API check.

### 2026-11-01 14:38–15:02 GMT — Live run completion

- **PASS (live, v1 story):** Pages 2–3 generated after dark-lantern fix (page 2: 106s; page 3 needed
  a partial-failure resume after an external-budget collision — completed panel preserved, 4 calls).
  Manual visual verdict: key handoff (p3p1), **Bram inserting key into lock (p3p2 — correct this
  time)**, lighting (p3p3) all read correctly; characters continuous; judge raised no prop findings.
  AE5 behavior confirmed (tiny silhouetted Bram → `not_observable`, no invented mismatch).
- **FAIL (dialogue duplication, composed output):** p1p1 shows baked-in balloon "The bridge is up!"
  AND composed caption "Nia: The bridge is up!". Judge simultaneously demands balloons in source art
  (its repair text says "Add a speech balloon") — inverted vs the lettering pipeline.
- **PASS (AE2):** Panel artwork edit ×2 (lighting; then judge-guided repair after my own bad
  "golden evening" instruction was correctly blocker-flagged for night-continuity). Both times only
  the edited panel's SHA-256 changed; story beats untouched. Classifier inconsistency: lamp-off
  prop edit refused (409) but duplicate-key removal allowed (200).
- **PASS (AE3, post-render revision — previously untested live):** "Nia keeps the key" from p2p1.
  First preview 502'd (`Revision start must be at or before the requested panel` — model chose a
  later start; 1 call). Anchored retry: proposal correctly scoped; **page 1 byte-identical with
  acceptances preserved**; suffix outdated; page 2 auto-re-rendered in apply; new beats keep Bram
  from ever touching the key (verified in beats, dialogue, and art). Narrative re-judge: **inconclusive**.
- **FAIL→repaired (render quality):** Revised p3 first staged an exterior ladder (2 location
  blockers — art was story-coherent but ledger-literal interior required; **blockers have no human
  override**). Regeneration fixed location but duplicated the key (lock + cord) — judge caught it;
  targeted edit removed the duplicate (verified visually). Judge severity for identical exterior
  staging varied blocker→warning across attempts (unstable calibration).
- **PASS (AE7/AE8):** Publish → anonymous gallery/reader (browser-verified, mobile+desktop);
  draft-only title edit left edition untouched (`unpublishedChanges` flipped correctly); republish
  minted new editionId and killed old asset URLs (404); withdraw removed listing+access (404);
  republish restored. Owner editor shows Published/downloads; stranger browser denied.
- **PASS (boundaries):** Cross-origin 403, bad Host 403, non-JSON 415, oversized 413, forged/
  malformed session 404, DELETE 405, traversal-ish asset id 404. Server restarts (×2) mid-run lost
  no state (SQLite). Existing sample untouched throughout (revision 55, same `published_at`).
- **UNVERIFIED live:** AE4 late-render race (unit-covered: `commitPanelRender` stale throw,
  store CAS tests); budget-exhaustion 429 path (unit-covered); token/$ usage (app records none);
  Vercel/deployment (out of scope per handoff); styles other than clear-line for generation.

## Final accounting (2026-11-01 15:02 GMT)

- Shared DB `provider_reservations`: **142 completed, 0 running, 0 unknown** (no stuck slots).
- This session's test dispatched **62** calls by designed step costs (questions 1, refs 2, plan 2,
  page renders/judges 34 incl. repairs+resumes, edits 9, revisions 15 incl. one 502 + one 409,
  judges included above). Baseline 37 → expected 99; observed 142 → **≈43 external calls** by the
  concurrent actor (a peer session also added `docs/plans/2026-11-01-1447-feat-comex-mcp-plan.md`
  to the checkout during the run; left untouched). Per-step log: `/tmp/comex-e2e-live/live-log.jsonl`.
- Cap history (my instance only, same DB, never reset): 100 → 140 → 170 (final instance stopped;
  port-3000's own cap remains 40, so it will refuse AI calls at the now-shared 142 until its env is
  deliberately changed — flagging, not fixing, per handoff).
- Artifacts: `/tmp/comex-e2e-live/` (driver, images, hashes, responses, screenshots, isolated DB).
  Live comic: `6fd06890-6559-4c37-81cc-7b456a240d3f` in the isolated DB only.
- Deadline status at close: 15:02 GMT, ~2h before 17:00. Local E2E is demonstrated end-to-end;
  submission packaging (deploy/video/repo publish) was out of scope for this handoff and remains.
