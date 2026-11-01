# Comex QA — 1 November 2026

## Scope and safety

- Goal: full local end-to-end QA, targeted root-cause fixes, and reviewable PRs. The target of 100 bugs is an investigation goal, not a license to invent findings.
- Baseline: branch `feat/comex-core`, HEAD `99ecec3`; application changes are uncommitted and untracked in the original checkout. Preserve them.
- The existing local sample and its databases/assets are user data; QA uses isolated fixture data and separate ports. No deployment, merge, or release authorized.
- Provider-call cap: 40, reservations at start: 36; 4 remain. Additional live-call authorization pending; mock-provider and deterministic stress tests do not spend calls.
- Requested 12 specialists are scheduled in waves due the available concurrency limit.

## Baseline evidence

- Prior run: 45 automated tests passed; one mobile browser creation/isolation test and read-only three-page browser smoke passed. Prior build passed with a dynamic filesystem tracing warning. These are historical, not current QA results.
- Live sample generated 3 pages. Known visual failure: page 2 panel 2 does not show the key entering the gate latch; a targeted repair did not fix it, and the vision check missed it. Follow-up narrative check was inconclusive. See `docs/research/live-test-2026-11-01.md`.

## Execution log

- 14:09 London: QA started; security, continuity, and browser specialists dispatched. Isolated worktree initialization requested.

## Findings


### Baseline, 14:10 London

- Isolated worktree: `<isolated-worktree>`, branch `qa/full-e2e`, based on `99ecec3`; copied the original uncommitted app without secrets, local data, or unrelated `docs/todos.md`. Original checkout remains untouched apart from this requested report.
- PASS: isolated worktree `bun run test` — 45 tests, 186 assertions; `bun run typecheck` — pass.
- PASS: isolated dev gateway on `127.0.0.1:3111`, separate temporary SQLite and assets. `agent-browser` opens gallery and sees expected navigation and heading. Live API not called.
- 14:11 London: a reviewable baseline of the offered application work was committed **only in the isolated QA worktree** as `326b988`; the original uncommitted checkout remains unchanged. A second isolated worktree `<isolated-worktree>` (`qa/domain-regressions`) is based on that commit. Neither branch has been published.

### Confirmed finding QA-001 — repeated downloads leak disk space

- **Severity:** P2. **Status:** fix pending. **Source:** security specialist; deterministic isolated reproduction `/tmp/comex-qa-security/download-leak.ts`.
- Every owner page download calls `composePages` and permanently stores a new PNG with no reference or cleanup. Ten downloads increased the isolated asset count from 1 to 11. Repeated reads can exhaust disk.
- Root-cause direction: compose/stream bytes for downloads or use properly managed deduplicated assets; preserve immutable publication and private asset boundaries.

- QA-001 fixed in isolated worktree and integrated as `fed720c`: downloads now return composed bytes without saving an asset. Regression reproduced two leaked files before the fix; afterward two downloads return identical PNG bytes and leave the asset directory unchanged. The focused API suite (11 tests) and typecheck pass. Original checkout unchanged.

### Confirmed finding QA-002 — acceptance races with a later blocker

- **Severity:** P1. **Status:** fix pending. **Source:** continuity specialist; isolated mock-provider reproduction `/tmp/comex-qa-continuity/judge-race.ts`.
- Accept a panel while its visual judge is still pending. When the judge later returns a blocker, the acceptance is retained, the page is displayed as current, and the next page can issue paid generation calls despite the blocker. The reproduction received acceptance 200, `blocker` plus `accepted:true`, and two later image dispatches.
- Root-cause direction: treat checking as a distinct state, prevent premature acceptance, invalidate obsolete acceptance, and apply one readiness rule to display and generation gates. Do not change the settled advisory policy or auto-approve.

### Confirmed finding QA-003 — narrative blockers do not stop rendering

- **Severity:** P1. **Status:** fix pending. **Source:** continuity specialist; mock reproduction `/tmp/comex-qa-continuity/story-blocker.ts`.
- Story planning records a narrative-review blocker, but generating the first page still dispatched an image call. Story revision can likewise start rendering even if the revised narrative judge returns a blocker. This spends the creator's budget on a known-contradictory story, contrary to the verification contract.
- Fix must gate all render paths consistently, or implement an explicit version-scoped user override; do not silently equate inconclusive evaluation with a pass.

### Confirmed finding QA-004 — publish dialog is inaccessible by keyboard

- **Severity:** P2. **Status:** fix pending. **Source:** browser specialist; isolated port 3277.
- Create a draft and activate Publish with the keyboard. Focus remains on the background button, Tab reaches background controls, and Escape does not close the dialog because the handler is only on the unfocused dialog. Screen-reader and keyboard users cannot reliably operate it.
- Root-cause direction: manage initial focus, contain focus in the open dialog, handle Escape, and restore focus to the trigger; verify mouse and keyboard paths.

### Stress baseline

- PASS: 100 concurrent isolated draft-creation HTTP requests using 20 workers on port 3111 returned 201 with IDs and session cookies in 0.63 seconds. This did not use a provider key and is not evidence of live API load capacity.

### Confirmed finding QA-005 — duplicate concurrent questions consume two calls

- **Severity:** P2. **Status:** fix pending. **Source:** budget specialist, isolated mock-provider reproduction `/tmp/comex-qa-budget/duplicate.ts`.
- With concurrent limit 2, two simultaneous question requests for the same unchanged draft both dispatch paid calls; one later loses the database compare-and-set and returns 409. Result: statuses 200 and 409, two provider calls for one useful result.
- Root cause is paid dispatch before operation reservation/deduplication. Audit story planning and revision previews for the same pattern; preserve unknown-outcome semantics.
- PASS: live-key smoke on isolated gateway `127.0.0.1:3112` with isolated draft/assets and shared original budget DB: draft creation HTTP 201; tailored questions HTTP 200, 3 questions, 3.5s. Provider counter increased from 36 to 37; **3 of 40 remain**. No live image or stress load dispatched.

### Confirmed finding QA-006 — character cards cannot be corrected

- **Severity:** P2. **Status:** fix pending. **Source:** browser specialist, isolated port 3277.
- Create a character with a mistaken name or description. The card displays fields as static text and offers no edit or removal; all cards require approved references before planning, so an accidental card can block the journey and cause wasted image calls. This conflicts with the confirmed customization requirement.

### Confirmed finding QA-007 — lost provider response body permits duplicate paid requests

- **Severity:** P1. **Status:** fix pending. **Source:** budget specialist; isolated reproduction `/tmp/comex-qa-budget/bodyloss.ts`.
- The budget reservation is marked complete as soon as HTTP 200 headers arrive. If the body stream fails, the image adapter reports `invalid_response`, clears the operation, and a second click sends another provider request. The mock reproduction sent two requests and recorded neither as unknown.
- Root-cause direction: keep the reservation and image operation in an indeterminate state until the body has been consumed and validated; never automatically redispatch after an ambiguous post-dispatch failure.

### Confirmed finding QA-008 — interrupted reservation can block all later requests indefinitely

- **Severity:** P2. **Status:** fix pending. **Source:** budget specialist, isolated two-process reproduction `/tmp/comex-qa-budget/crash.ts`.
- If a process exits after reserving a provider call, the row remains `running`. A fresh process with the default concurrency of one rejects every later call indefinitely; the app provides no supported reconciliation path. Do not auto-retry or delete the record: reconcile the dispatched outcome conservatively and require an explicit operator resolution where outcome is unknowable.

- QA-002 and QA-003 fixed and integrated as `1f71ba9`. Regressions first failed against the original code and pass after the fix: visual checks have a `checking` state, stale acceptances are cleared, shared readiness controls continuation, and narrative blockers prevent rendering. Judge failure remains uncertain and manually reviewable. `bun run test`: 49 pass; typecheck: pass. A process crash mid-visual-check can still leave a `checking` state; recovery needs separate assessment.

### Confirmed findings QA-009 and QA-010 — publication race and orphaned composites

- Two simultaneous publications based on the same draft revision both succeeded, allowing a later completion to overwrite another edition. A real API reproduction returned two 200 responses and only one final edition.
- Repeated republication left obsolete page composite PNGs on disk; ten publishes added ten files while only the latest edition remained reachable. Failed publication could also leave composite assets.
- Fixed and integrated as `0d027e4`: publication uses revision-based concurrency control and stores edition images atomically in SQLite. Tests cover racing publications, rollback, withdrawal, and legacy file-backed editions. Existing historical orphan files are not automatically deleted. Agent verification: 50 tests and typecheck passed.

### QA-007 and QA-008 follow-up

- Fix integrated as `137f00a`: successful provider responses hold their budget reservation until validated; ambiguous outcomes remain unknown, and documented operator reconciliation preserves spent-call counts. Agent tests reproduced both defects and pass after the change. **Remaining limitation:** separate per-draft operation locks can remain stuck after a crash and need coordinated recovery.

### Full creator journey (mock provider)

- PASS: isolated real browser and local database, fake provider, three pages with three panels each. Covered tailored questions, character approval, planning, page generation and review, targeted editing, publication and anonymous reading, downstream plot revision, regeneration, republishing and withdrawal. Commit `664c9a0`; no paid calls. This does not verify live provider output quality or latency.

### Temporary tunnel

- Verified the real sample edition and creator page via a Cloudflare Quick Tunnel. The first preview failed to hydrate due to blocked development assets; a separate production build and narrowly scoped proxy fixed the shelf. Created one local draft titled `Tunnel QA test draft` to verify the creator flow; no paid calls. Creator requests are enabled on the public URL per user instruction, origin-checked, with the existing 40-call cap still active.

### QA-004 and QA-011 — dialog keyboard access and invisible publication error

- A failed publication displayed the error behind the open modal, leaving the user unable to see the reason. Fixed with QA-004 in `c7d06d6`: focus enters and remains in the modal, Escape closes it, focus returns to the trigger, and errors appear inside the dialog. Browser regression covered the real incomplete-publication 409, keyboard behavior, backdrop and cancel; typecheck passed.

### QA-005 follow-up — duplicate provider calls

- Fixed in `06b8158` with a persistent per-draft reservation shared by question, planning, revision-preview and revision-application requests. Parallel requests no longer duplicate calls; unknown outcomes and crashes retain the reservation until deliberate operator recovery. Mock concurrency and persistence tests pass. Integrated suite: 56 tests, 286 assertions; no live calls.

### Requested email sign-in

- Implemented in an isolated worktree and being integrated: expiring single-use email links, confirmation before token consumption, cross-browser sign-in, revocable sessions, and same-browser-only claim of earlier anonymous drafts. Initial tests use mocked delivery. Public gallery remains readable; creators must sign in. Real email delivery is not configured or tested; the sender, Resend credentials, and trusted app URL are still needed. Local SQLite and the localhost-only API boundary remain unsuitable for Vercel or a multi-device public deployment.
- Integrated as `92a7b82` and `9c0542e`. Independent review fixes include multiple-link claims, rate-limit failure reporting, case-sensitive email local parts, publication freshness and avoiding claims while provider operations are active. Combined suite: 66 tests, 442 assertions. The active public tunnel still runs the earlier unauthenticated preview; the new auth requires a suitable trusted gateway and configured email before public use.

### QA-006 follow-up — character editing

- Fixed in `c0fd4cb`: creators can edit or remove character cards before planning, and changed card details invalidate their prior reference and approval. Existing generated stories and unresolved reference operations are protected. API and real-browser tests passed in the isolated worktree without paid calls.

### Auth review findings — fixes in progress

- A second magic-link request overwrote the browser claim nonce, so opening an earlier still-valid link could sign in without claiming existing anonymous drafts. Reproduced in an isolated store; the auth implementer is fixing it.
- Exhausting the global email request limit silently returned success for an unsent link, preventing unrelated users from signing in for an hour. Reproduced without email delivery; the fix will report temporary unavailability. Public rate-limit abuse needs further consideration before public launch.
- The existing localhost-only API boundary and current preview proxy do not yet support the new public magic-link flow; sender configuration and a trusted public origin are required.

### Confirmed finding QA-012 — same-page generation continues after a visual blocker

- **Severity:** P1. An independent continuity review found that after a panel is judged a blocker, the page generation loop can continue to render later panels on that same page because the immediately previous panel only needs an asset. This can spend paid calls using an image known to be inconsistent. A fix and mocked regression are in progress.
- Fixed in `612ce1e`: a blocker pauses the dependent panels until the creator repairs or explicitly accepts the exact reviewed image. The regression showed three image dispatches before the fix and only one after; both repair and manual-acceptance resume paths pass. Explicit acceptance reflects the documented advisory status of the uncalibrated judge; no automatic pass is implied. Narrative-blocker acceptance is under separate assessment.

### External partial review

- The supplied partial review `<local-artifacts>/comex-review-20261101-1340/REVIEW-PARTIAL.md` was run against an older snapshot and was not a final or independently validated review. Its repeated-download leak and stale-findings issues are fixed in the QA branch; global budget reconciliation is now documented. Several claims remain under active validation, including stale page operations after revisions, outdated earlier panels, question context, unsaved answers, and recovery of per-draft image locks.
- Fixed in `88c3ffd`: stale page operations are cleared when the story changes; an outdated preceding panel is regenerated before dependent panels; question text accompanies saved answers; question refresh preserves answered questions and uses new IDs; unsaved answers survive unrelated actions and are saved before planning; an explicit stopped-process operator command can resolve a specific stuck image lock after investigation. Combined tests: 70 pass / 480 assertions, typecheck pass, and five mocked browser journeys pass. These changes do not automatically refund or retry provider calls.
- Confirmed the default Next.js commands previously listened on all interfaces despite a Host-based local guard. Fixed in `f3c8137`: dev and start bind to loopback by default. Verified the dev listener on `127.0.0.1:3201`; the explicitly requested temporary tunnel is a separate gateway.
- Confirmed that republishing after reopening the editor could revert the public title and creator. Fixed in `286f848`: the owned draft view returns current publication details and the dialog restores them; API regression and typecheck pass.
- The final-comic judge prompt is not wired into an assembled-page review. This is a coverage gap; the existing live sample demonstrates that panel-level LLM checks can miss continuity defects.
- Visual and narrative blocker findings remain visible and require explicit version-scoped creator acceptance before proceeding; narrative acceptance added in `25f83f3`. It does not claim the LLM verdict is calibrated.

### Reviewable changes

- Draft PR: https://github.com/ivankuznetsov/comex/pull/1. Its initial head has a sanitized author identity; sign-in, loopback binding, and remaining fixes are still to be integrated and pushed. No deployment or merge performed.

### Shared live budget changed by a separate process

- At 14:28 UTC, the shared original provider database contained at least 54 reservations, exceeding the 40-call limit visible in this conversation. A separate process owned by another local session runs a live gateway on port 3200 with `COMEX_MAX_PROVIDER_CALLS=100` and the same budget database; its active test was still issuing calls. This QA team did not initiate those extra calls and did not interrupt the independent process. The preview gateway on port 3000 remains configured for 40 and will reject further AI calls once the shared count exceeds that cap. The actual invoice/cost has not been verified.
- User subsequently authorized a 200-call cap. Updated the ignored `.env.local` limit without resetting the reservation count and started a separate preview API gateway on loopback port 3188 with the 200-call cap and the same database/assets; the public tunnel now targets it. The independently owned gateway on 3200 retains its own 100-call configuration. A bounded isolated live-provider QA run is underway; no guarantee that all 200 calls will be needed.
- User hit a concurrency rejection while QA and the other gateway were using the shared database. Per their instruction, `.env.local` and the live preview API gateway on port 3186 now use concurrency 50 and the unchanged total cap 200. Other already-running gateways retain their individual limits. Previous preview API gateways were stopped after confirming no live connections; the URL and database are unchanged.
- User then requested removal of the total call cap. The preview now runs an explicitly unlimited setting on port 3184 with concurrency 50; reservations remain recorded. A temporary compatibility ceiling of `9007199254740991` remains in the original ignored `.env.local` because that checkout still runs the older budget code; the reviewed implementation supports the literal `unlimited` option (`034a484`). The independently owned port 3200 gateway is unchanged.

### Live provider journey

- Tailored-question generation returned five questions in 3.8 seconds. Character reference generation returned an image in 12.1 seconds; visual inspection found the requested red hair, freckles, yellow raincoat, blue trousers, and brown boots.
- **Confirmed live planning defect:** story planning returned HTTP 422 after 29.2 seconds and one paid call, citing `p2-panel3: invalid or duplicate knowledge state`. The result was discarded, requiring another paid attempt. A root-cause repair and regression tests are in progress. At this point the live QA journey had used three calls (shared total 57 to 60); another independently owned gateway also uses the shared budget.
- A conservative candidate fix is integrated as `ca1af46`: prompts require unique state keys, and exact repeated key/value facts are deduplicated without discarding conflicting values. Regressions passed for planning and revision, while conflicting values still fail validation. The original provider response was not retained, so this does not yet prove the live failure was an identical-duplicate case; live verification remains pending.
- A fresh live run with the candidate code planned successfully in 39.7 seconds and the narrative judge returned pass. No duplicate keys were generated in that response, so it verifies the ordinary candidate path but not the exact live failure mechanism.
- The candidate rendered three first-page panels in 85.5 seconds. Visual inspection found the approved character's red hair, freckles, yellow coat, blue trousers, brown boots and red bicycle recognizable across the three; the checker reported style warnings consistent with visible extra shading and texture. A hidden key was not observable in later panels, which does not establish it was lost. This is one live sample, not broad visual calibration.
- **Confirmed live visual-review defect:** the model marked intentionally unlettered raw panels as missing dialogue (including a blocker), even though dialogue is added when composing a page. Another source panel rendered a speech balloon with dialogue despite instructions not to, producing a risk of duplicate lettering in the assembled page. Fixes `ed93ac0` and `6a99925` remove dialogue from raw image and visual-judge inputs and explicitly describe the unlettered stage. Mock request assertions pass; live validation of the changes is still needed.
- Targeted live render with `6a99925` completed in 15.3 seconds, and visual inspection found no embedded text or balloon. Three earlier panels were accepted and assembled into a downloadable page with dialogue added separately. The targeted review returned `uncertain` without findings; the existing app conflates a successful empty review with a caught judge error, so this does not prove the judge succeeded. Approximate attributable live-QA usage was 21 calls; the shared ledger cannot independently attribute calls or determine monetary cost, and another gateway also used it.

### Confirmed finding — stale browser can accept a replacement image

- A two-tab test reproduced that panel acceptance used the server's latest image without checking which image the creator reviewed: replacing the panel in another tab and submitting the stale acceptance returned 200 and accepted the replacement. A version-bound acceptance fix and regression are in progress; related character-reference approval is also being checked.
- Fixed panel acceptance in `0441c63`, and the analogous character-reference approval race in `9881b44`. Targeted edits also check the viewed version before classification and again before image generation (`ce4cafb`), preventing paid edits against an image the user did not select. Mocked regressions and the complete five-test browser suite pass.

### Creator sign-up update

- User changed the requested flow from magic links to an email prompt when starting a comic and one-time email codes for later login. The new flow is being implemented; a browser-local draft can start immediately, while account access and claiming drafts require verifying email ownership. The final implementation needs a real email provider, a verified sender, and a configured secret; no real email has been sent or verified.
- Code flow integrated as `7ef2030`; six mocked browser tests and 76 combined unit tests pass. Independent review reproduced a pre-issuance code-guessing lockout and identified that guest-cookie expiry was not enforced server-side; fixes are in progress. Real delivery and the public auth gateway remain untested/unconfigured.
- Independent review also reproduced a concurrent code-request cookie race and a mistyped-email draft-claim failure. Fixes in the auth worktree now pass independent reproductions for both, for pre-issuance guesses, and for server-enforced guest expiry. Known email-provider 4xx rejections release the per-email send quota; 408/5xx/network errors remain counted because delivery may have occurred. Public deployment still needs client/network abuse controls; ten wrong guesses against an active code can temporarily lock that address.
- Hardening integrated as `a87f459`; the creator can explicitly claim same-browser drafts after correcting an email address. Combined suite: 83 unit tests, 620 assertions, and typecheck pass. Seven mocked browser tests are running in the integrated branch; the isolated auth branch passed them serially after resource-related timeouts with five workers. No real email delivery has been tested.
- Integrated browser run: 6/7 passed; corrected-email draft was not visible within the 5-second assertion, although the test database shows it was assigned to the correct account. The log also reports a 28.6-second Next.js cache write. This is not yet classified as a transient delay or product bug; isolated rerun is in progress.
- Immediate integrated rerun passed all 7 browser tests in 17 seconds. The initial timeout remains recorded; it is not proof of a deterministic product failure.

### Review-status and concurrent-image follow-up

- Fixed the visual-review status ambiguity in `2386fdf`: completed, inconclusive, and failed checks are distinguished and tied to the exact image version. An explicit operator recovery can mark a crashed `checking` operation failed while preserving its image and requiring creator acceptance. Combined suite after integration: 85 tests and 643 assertions; browser suite is being rerun.
- **Confirmed paid-image concurrency defect:** an isolated mock reproduction showed that editing a title during character-reference generation causes the completed paid image to fail a whole-draft revision check and leaves an unreferenced PNG. The same save-before-check pattern exists for panels. A fix is in progress; the live preview still runs the earlier snapshot.
- **Confirmed sign-in input race:** an asynchronously fetched guest-email prefill can race typing a corrected address and concatenate the old and new email, preventing code delivery. Observed in a real browser during integration testing; a deterministic regression and fix are in progress. This is separate from the earlier timeout whose exact cause remains unproven.
- Fixed and integrated as `6e23b31`: the email input waits for the session lookup, which times out safely without later overwriting user input. Delayed-response and stalled-lookup browser regressions passed in the isolated auth worktree; combined unit suite remains green.
- Image-generation race fixed and integrated as `0597b79`: successful results survive unrelated draft changes; changed actual inputs reject the result and remove its new unreferenced file. Mock regressions cover character and panel generation for both cases. Combined suite: 86 tests / 663 assertions and typecheck pass; the browser suite will be rerun after the sign-in race fix.
- Draft PR head updated to `0ffe9626591ae484e91808e8d529a02b064539ef` with the integrated email-code flow, budget policy, and above QA fixes. The PR remains draft and has no configured hosted checks; local checks do not imply a deployment.

### Creator-flow change requested during QA

- User requested automatic story-question generation after creating a draft and automatic reference generation after adding a character. Implementation and mock tests are in progress; the flow must retain recoverable errors and avoid duplicate paid dispatches.
- Automatic flow integrated as `b15fcde` and `f5b5a50`, with persisted initial-question state and locks protecting against duplicate requests; failed work offers retry while ambiguous work requires recovery. Legacy browser draft compatibility integrated as `46daff6`, with explicit exclusions for unknown, expired and account-owner tokens. Combined suite: 92 unit tests and 715 assertions, typecheck passes; integrated browser run underway.
- Refreshed the public preview to a production build at integration commit `470b307` on port 3183 after existing preview requests finished. A private SQLite backup was taken beforehand; the original database and assets are retained. Browser verification confirmed an existing legacy draft remained visible. This preview includes email-code UI but actual code delivery is not configured. Its SQLite-backed newly published assets may not be readable by the older still-running port-3000 server.
- Cloudflare documents a default 125-second proxy read timeout, while a page request performs multiple sequential image/review calls and could exceed it. Increased the local preview proxy timeout to 900 seconds, which does not change Cloudflare's edge timeout. A nonblocking page-generation design is under investigation; do not treat the Quick Tunnel as reliable for long-running requests until verified. Source: https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/.

### Product feedback under implementation

- User requested story-derived character suggestions, a less obstructive visual-edit experience, stronger action/narrative checking, and better page composition. Character suggestions, edit intent handling, and bounded layout improvements are being implemented in isolated worktrees. Earlier live evidence shows model review can miss a wrong key action; recognizability is not proof of narrative accuracy.
- The action-review prompts now explicitly compare actors, important props, targets and resulting state (`c8cbbf7`); this is a proposed improvement, not a calibrated or independently validated guarantee. The edit-choice work is integrated as `a720855`: positive story changes route to revision, while uncertain edits offer an explicit, version-bound artwork-only confirmation or revision preview. The lighthouse example has not been retested live. Combined suite: 93 unit tests / 741 assertions and typecheck pass.
- Page settings and story-derived editable character suggestions are being integrated. Separate browser suites encountered intermittent navigation/sign-in timeouts under slow Next.js development-server compilation; these are recorded as unresolved timing observations rather than hidden passes.
- Page settings integrated as `84e7529`: 2–4 panels per page before planning, and vertical or two-column output; captions remain below panels and the current published edition stays unchanged until republished. Combined suite: 94 unit tests / 762 assertions and typecheck pass. The layout specialist's own full browser runs passed 7/9 and 8/9 due to unrelated cold navigation timeouts; its targeted layout test passed both times. Freeform lettering and per-panel positioning remain unimplemented.
- Editable story-derived character suggestions integrated as `7697bad`: one additional structured text request follows the initial questions; a creator reviews or edits a proposed card before adding it, which triggers reference generation. Duplicate and uncertain requests are protected by persisted state and locks. The suggestion prompt is proposed, not live-calibrated. Combined suite: 97 unit tests / 790 assertions, typecheck pass; the newly combined browser suite is running.
- Combined browser suite passed 13/13 with simulated AI/email. The production build passed with Next's existing dynamic-filesystem tracing warning. The public preview was refreshed to this build on port 3182 after confirming no in-flight preview request; a legacy browser draft remained visible. Email delivery is still not configured.
- Draft PR head updated to `78dea248100c0fda5395740aa5b085c41cf79837`, containing the feedback changes. A targeted live check of character suggestions and edit classification is in progress.
- Live browser check on an isolated final-commit gateway: automatic questions completed and a lighthouse plot produced two relevant editable suggestions, a lighthouse keeper and a talking gull. The creator selected and edited one card; its reference generation was in progress at the last update. Email delivery was simulated; no real user draft was touched.
- The selected edited card's live reference completed successfully. Timings: questions 3.908s, suggestions 3.859s, reference 12.001s. In a separate live classification call, asking to turn off a lamp already described as off returned `artwork` in 1.341s. This is one favorable example, not broad classifier calibration. Four calls were made in this phase; a separate revision/publication test is in progress.
- In the live revision setup, generating page 2 stopped after its first panel received a blocker. The inspected panel showed a framing mismatch, and generation resumed after explicit creator acceptance. Further downstream revision and publication verification remains underway.
- The two additional presets were each exercised with one live `gpt-image-2.5-flare` character reference: ink-manga took 14.467s and painted-storybook 24.332s. Visual inspection found their intended black/white ink and warm painted appearances, respectively, with the requested character anchors. These are single model-sheet samples, not multi-panel consistency or evaluator calibration; actual monetary cost is not measured.
- Page 2 resumed and completed in 53.5 seconds after the inspected panel was accepted; the remaining panels preserved the character and bicycle. A live plot-revision preview then succeeded in 22.7 seconds, identifying page 2 panel 3 as the earliest affected point. Applying the revision and later pages remain under test.
- Applying the live revision completed in 35.6 seconds: the unaffected two-panel prefix kept its asset IDs, the revised panel was redrawn, and all page-3 panels became outdated. The new image showed the intended door action; the visual review reported a style warning. Dependent-page generation and publication remain in progress.
- The dependent third page generated in 85.1 seconds. Visual inspection found the requested sequence—door opened, key offered, key turned in the clock—across its three panels. The judge issued style/composition warnings. A supporting clockmaker, who had no approved reference card, may visually drift between panels; that uncertain observation was not flagged. Publication remains under test.
- Live publication succeeded on the final commit: public edition API and all three page PNGs returned 200, and an anonymous browser navigated the three pages. The original page 1 was generated on an earlier candidate and copied into the isolated test fixture; this does not prove three pages were freshly generated on final HEAD. The revision/publication phase used 16 provider calls; the final-commit questions/suggestions/classifier phase used four. No real email was sent.

### Preview page-two report

- The newest preview draft had three page-1 panels with unaccepted blocker findings. The current API refuses page 2 until its preceding page is accepted or repaired. Findings include character-silhouette differences and the ball handover; the creator must inspect and explicitly accept or correct each panel. A UI improvement to make the reason and the way back to the preceding page more obvious is in progress.
- User explicitly rejected mandatory acceptance. This supersedes the earlier acceptance-gate policy: implement advisory-only findings so a completed current page can continue without accepting or dismissing each panel, while retaining true incomplete/in-flight/stale safeguards. Do not fabricate acceptances on the user's draft.
- A temporary preview-only build on port 3180 removes the acceptance and narrative-blocker gates for completed panels; in an isolated copy of the user's database, page 2 reached the missing-key check rather than a review rejection, with no paid call. On the public preview, the actual draft's page 1 now reports `current` with all three `accepted` flags still false. This hotfix does not yet move reviews into the background; permanent implementation and async page-job integration remain underway.
- User explicitly requested merging all open PRs and running the latest version through the tunnel. GitHub lists one open Comex PR, #1 (currently draft). Integration, testing and exact-head hosted checks are being completed before merging and switching the preview.
- Permanent changes are integrated: background visual/narrative reviews are advisory, use version-bound metadata, and do not delay next-page generation or publication; page generation uses a persistent local job with owner-checked polling and crash recovery. A revision preview displays old/new beats and dialogue before applying. Issue-list fixes cover caption indentation, reader errors, unknown-route/domain status and in-memory budget safety. Latest combined local checks: 110 unit/API tests / 893 assertions, typecheck, and 15 mocked browser tests passed. Earlier browser timing failures remain recorded above. Later revised pages are still marked outdated and must be generated individually; automatic cascading is not implemented.
