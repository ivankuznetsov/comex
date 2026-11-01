> Historical testing snapshot. Status and operating details may have changed; see the newer QA report.

# Comex — Full Issues List

Compiled: 2026-11-01 (Europe/London), after end-to-end testing recorded in `docs/todos.md`.
Sources: live E2E run on isolated instance (real OpenAI calls), read-only checks of the existing
sample, code inspection of `src/lib/local-api.ts`, `src/lib/ai/service.ts`, `src/lib/budget.ts`,
`src/lib/domain/comic.ts`, components, prompts, and existing tests.
Status of every item below: **open** unless marked otherwise. No fixes have been applied yet.

---

## A. Dialogue, lettering, and composed output

1. **Duplicated dialogue in composed pages.** The image model bakes speech balloons into source
   art (e.g. "The bridge is up!"), and deterministic lettering then repeats the same line as a
   caption below the panel. Readers see the line twice.
2. **Vision judge is inverted on dialogue.** It flags *missing* speech balloons in source panels
   (including deliberately text-free panels) and its repair text says "Add a speech balloon",
   while not flagging baked-in text. Source art is supposed to be text-free; dialogue is composed
   separately (`src/lib/lettering.ts`, composition in `src/lib/local-api.ts`).
3. **Lettering polish defects.** Minor artifacts in composed captions, e.g. a leading space in a
   wrapped line (`" home."`) in the first sample.
4. **Inconsistent panel aspect ratios.** Generated panels arrive in mixed portrait/landscape
   shapes and are letterboxed into the page composition, giving uneven pages.

## B. Image generation quality and continuity

5. **Prop-state errors in generated art.** Example: the harbor lantern rendered lit in all of
   page 1 before any unlock event. The error propagated panel-to-panel because each render is
   conditioned on the previous panel.
6. **Prop duplication.** Example: brass key shown simultaneously in the lock and still hanging
   from its cord in the same panel.
7. **Location staging drift.** Example: an interior tower ladder staged as an exterior climb;
   the staging then propagated to following panels via previous-panel conditioning.
8. **Background artifacts.** Example: a second miniature lit lighthouse appearing in the
   background of a panel that is set inside the lantern room.
9. **Original sample defects (historical, still present in the published local sample).**
   Page 2 panel 2 shows Pip's key being wound by hand instead of inserted into the gate latch;
   a targeted edit failed to fix it; rain begins without setup; a barred gate becomes a solid
   door; Pip's design varies between panels. Character identity itself held throughout.
10. **Style drift vs preset.** Panels consistently render more painterly/textured than the flat
    cel-shaded clear-line rules, producing a style warning on nearly every panel (noise that
    drowns real findings).

## C. Evaluator (vision/narrative judge) calibration

11. **Missed story-critical defect (first sample).** The vision judge never identified the
    page-2-panel-2 key/latch error, returning `uncertain` twice.
12. **Unstable severity.** Identical exterior-ladder staging scored `blocker` in one generation
    and `warning` in the next.
13. **False-positive dialogue findings.** Repeated warnings demanding speech balloons in
    text-free source art (see issue 2).
14. **Every AI panel requires manual acceptance.** A clean judge `pass` is deliberately
    downgraded to `uncertain` in `src/lib/local-api.ts`, so every rendered panel lands in
    `needs_review` and must be operator-accepted before the next page, download, or publish.
15. **Narrative judge failures are silent.** Any judge error is caught and replaced with
    `{outcome: 'inconclusive', findings: []}` (`src/lib/local-api.ts`), indistinguishable from a
    genuine inconclusive verdict. Post-revision narrative judgments were inconclusive in both
    live runs.
16. **Narrative judge is advisory only.** Blocker findings in `storyReview` do not block saving,
    planning, or generation; there is no accept/dismiss action in the UI either.
17. **No measured evaluator calibration.** No precision/recall over labeled cases; the prompt
    library and the two non-clear-line styles (`ink-manga`, `painted-storybook`) have not been
    systematically live-tested. Only `clear-line-adventure` has generated live panels.

## D. Panel edits (artwork vs story)

18. **Edit-intent classifier fails closed on prop-state repairs.** "Turn the distant lamp off"
    was refused with 409 ("unclear whether that affects story-relevant continuity"), blocking
    exactly the repair the vision judge requested. Cost: 1 paid call per refusal.
19. **Classifier inconsistency.** A duplicate-prop removal edit was classified `artwork` and
    allowed, while the lamp-state edit was refused. `uncertain` classifications also block.
20. **No intra-panel preservation guarantee.** A panel edit fully regenerates the panel via
    `images/edits` with the old bytes as a reference and prompt-level preserve instructions
    (no mask/composite/pixel check). Unrequested changes can ride along (e.g. a "warmer light"
    edit turned night into sunset).
21. **Edits do not invalidate downstream panels.** Later panels that were conditioned on the
    edited panel keep their `current`/accepted status; only story revisions mark a suffix
    outdated.

## E. Story revision flow

22. **Revision preview can 502 on model output.** If the model returns
    `earliest_affected_panel_id` after the requested panel, the API throws
    `invalid_response` ("Revision start must be at or before the requested panel.",
    `src/lib/ai/service.ts`) and the raw error reaches the user. The failed preview still
    consumes a paid call; the only remedy is rewording and retrying.
23. **Revision apply is blind.** Preview returns only proposal metadata
    (earliest panel, affected page/panel, explanation) — not the revised beats — so the user
    confirms via `window.confirm` without seeing the new story text.
24. **Apply persists before re-rendering.** If the auto-re-render of the first affected page
    fails, the API returns an error but the revision is already saved.
25. **Only the first affected page auto-renders on apply.** Later pages stay `outdated` until
    manually generated (surfaced via notice, but easy to miss before a publish attempt).
26. **Deterministic ledger limits.** Adjacent scene-state consistency is checked, but
    within-panel prop ownership transfer cannot be proven from prose beats; the first live
    storyboard also failed the ledger check once (422) before a prompt change.
27. **Stale setup answers after revision.** The editor's answers section keeps showing the
    pre-revision ending text after a story revision changes that ending.
28. **Direct plot/style/answer edits are blocked once pages exist** (PATCH returns 409); all
    later story changes must go through the revision flow. By design, but undiscoverable.

## F. Blocker handling and review workflow

29. **Blocker deadlock.** Panels evaluated `blocker` can never be operator-accepted
    (`acceptPanel` in `src/lib/domain/comic.ts`); there is no human override. The only exits
    are paid regenerate/edit/revise loops, which may repeat the defect. Ledger-literal findings
    (e.g. interior vs exterior ladder) blocked otherwise coherent art this way.
30. **Acceptance is fragile by design.** Acceptance binds to the exact
    asset/storyRevision/panelRevision triple; any re-render clears it, and readiness for
    next-page generation, download, and publish all hinge on it.
31. **Regenerate-page cost surprise.** Generating an already fully rendered page re-renders
    *all* its panels (full price); an incomplete page resumes only missing/outdated panels.
    The UI label does not communicate the cost difference.

## G. Budget, provider calls, and resilience

32. **`unknown` reservations deadlock all provider calls.** A 408/5xx/transport failure marks
    the reservation `unknown`, which permanently occupies a concurrency slot. At the default
    concurrency of 1, every subsequent call fails with `concurrency_limit`. There is no TTL,
    expiry, or reconcile API (`src/lib/budget.ts`) — recovery requires manually editing SQLite.
33. **`unknown_outcome` latches operations forever.** The per-panel/per-character operation
    flag is kept as `unknown_outcome` with no endpoint to inspect or clear it; that panel or
    character can never be rendered again through the API.
34. **No retries anywhere.** A mid-page `concurrency_limit` (thrown before dispatch, so safe
    to retry) aborts the whole page request; the user must manually resume.
35. **Budget accounting is global and unattributed.** `provider_reservations` has no
    comic/user/model columns; `used = count(*)` over the file's entire history. Failed and
    429 dispatches count against the cap. No token or monetary usage is recorded anywhere.
36. **Shared-file multi-instance hazards.** Instances sharing one budget DB share the cap and
    concurrency gate but read different caps from their own env, so accounting and starvation
    depend on which process asks. Observed live: a concurrent instance consumed ≈43 calls
    during testing and collided with in-flight generation.
37. **Silent budget reset paths.** If `COMEX_BUDGET_DB_PATH` is unset the budget follows
    `COMEX_DB_PATH`, so an "isolated test instance" quietly starts a fresh counter.
    A `:memory:` budget path would reset on every call (new connection per call) and
    effectively disable the cap.
38. **Config footguns.** A set-but-non-numeric `COMEX_MAX_CONCURRENT_CALLS` means
    "unconfigured" (all calls refused) rather than the documented default of 1.
    `COMEX_DB_PATH` is cached at first API use while other env vars are re-read per call.
39. **Long synchronous requests.** Page generation is one HTTP request lasting ~70–110s
    (sequential image+judge calls, 180s provider timeout each). No job queue, polling,
    streaming, or progress beyond a busy label.
40. **Current operational state.** The shared DB stands at 142 completed reservations while
    the port-3000 server's env cap is 40, so that server now refuses all AI calls until its
    env is deliberately changed and the process restarted.

## H. UI and UX

41. **No generation progress.** No percentage, panel counter, or per-panel status during
    generation; the design brief's progress copy ("Drawing page 2 — panel 1 of 3") is not
    implemented.
42. **Async `jobId` dead end.** If an action returns a job id instead of a comic, the editor
    shows "Generation started. Refresh to check its status." and never polls.
43. **Publish error hidden behind modal.** A failed publish leaves the dialog open while the
    error alert renders behind it at the top of the page.
44. **Reader error banner never resets.** `imageError` in `components/ComicReader.tsx` is not
    cleared on page change, so one broken page image banners every subsequent page.
45. **Reader limitations.** No URL sync for page index, no keyboard/swipe navigation, no
    prefetch, plain `<img>` without responsive sizing; "zoom" is open-image-in-new-tab.
46. **Mobile editor is only stacked layout.** The brief's inspector accordion is not
    implemented; the inspector sits below the canvas on small screens.
47. **No character edit/delete.** Characters can be added and re-referenced but not edited
    or removed once created.
48. **Export is per-page only.** Single-page PNG download exists; no whole-comic
    PNG set/PDF/CBZ export.
49. **Testability.** No `data-testid` attributes anywhere; several accessible names collide
    (page rail vs panel buttons, header vs dialog "Republish", multiple "Create a comic"
    links, per-character "Approve" buttons), forcing fragile test scoping.

## I. API, domain, and code health

50. **Error-mapping gap.** Domain errors such as `stale render` / `not authorized` do not
    match the 409 regex in `src/lib/local-api.ts` and would surface as 500 if reached.
51. **Unmatched POST returns 503.** An unknown POST route under an owned comic returns
    503 "AI not configured" instead of 404.
52. **Divergent duplicate models.** Two different `Edition` shapes (domain vs local-api);
    `publishComic` is used only as validation and its result discarded; domain
    `getPublicEdition`/`withdrawComic`/`setPageComposition` are unused by the API layer;
    `src/lib/contracts.ts` defines a storyboard model and validator the API never calls.
53. **Loose derived page status.** The view's page status treats "has any acceptance object"
    as current, which is weaker than the publish/download readiness predicate.
54. **Tautological revision checks.** At revision-apply and publish call sites the
    `expectedRevision` argument is the object's own current revision, so those domain
    checks cannot fail.
55. **Orphaned asset accumulation.** Stale/rejected renders are written to disk before the
    staleness check and never cleaned; page downloads write a new composed asset on every
    request; withdrawn/superseded edition files are never deleted.
56. **`unpublishedChanges` false positives.** It compares store revisions, so even a
    title-only draft edit marks the published edition as having unpublished changes.
57. **Sequential render preconditions.** A panel cannot render until the globally previous
    panel has an asset and every storyboard character has an approved reference; there is
    no parallelism to hide the ~25s-per-panel latency.
58. **Hard-coded provider endpoint.** `https://api.openai.com/v1/` is fixed in
    `src/lib/ai/service.ts` with no base-URL override, so out-of-process mock-provider
    browser E2E is impossible; prompts are re-read from `process.cwd()/prompts` on every
    call, pinning any instance to a repo-root working directory.
59. **Build/deployment readiness.** Dynamic local asset paths trigger broad Turbopack file
    tracing; storage is local SQLite + filesystem and `ensureLocal` refuses to run when
    `VERCEL` is set — the app is not deployable as-is.

## J. Security and privacy (local threat model)

60. **Unsigned bearer session.** Owner identity is any cookie matching `/^[a-f0-9]{64}$/`;
    there is no server-side session record or signing, so knowledge of the value is full
    ownership. (Verified: forged unknown values and missing cookies correctly get 404.)
61. **Mutations allowed without `Origin`.** Same-origin is enforced only when an Origin
    header is present; protection otherwise rests on content-type + `SameSite=strict`
    + the localhost Host gate. No CSRF token.
62. **Positive confirmations (not defects):** cross-origin POST 403, forged Host 403,
    non-JSON 415, oversized body 413, DELETE 405, unknown routes 404, edition-pinned
    published assets (wrong edition 404), private drafts invisible to other browsers.

## K. Testing gaps

63. **One committed browser test.** `e2e/local.spec.ts` covers only draft creation,
    character persistence, and cross-browser privacy. No committed coverage for questions,
    references/approval, planning, generation, accept flow, either edit mode, publish/
    withdraw/republish UI, reader pagination, drafts page, downloads, or desktop layout.
64. **Playwright needs a pre-started server.** `playwright.config.ts` has no `webServer`;
    it assumes something already listens on port 3100.
65. **Not live-verified:** AE4 late-render race rejection (unit-covered via stale-commit and
    CAS tests), budget-exhaustion 429 path (unit-covered), `unknown`-reservation deadlock
    recovery (unit-demonstrated, no product remedy), non-clear-line styles, token/$ spend.

## L. Repository and delivery state

66. **Application code is uncommitted.** As of the handoff, only the planning commit
    (`99ecec3`) is on GitHub; the app, prompts, and tests are untracked working-tree files
    on one machine (plus a peer-authored MCP plan doc added during testing).
67. **Submission packaging outstanding.** No deployment, public links, demo video, or
    fresh-checkout README verification (explicitly out of scope for the E2E handoff;
    deadline 2026-11-01 17:00 Europe/London).
