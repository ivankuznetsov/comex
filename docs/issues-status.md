# Issue verification status

This cross-check covers `docs/issues.md` from the older local test snapshot against the QA integration code as of 1 November 2026. An item marked fixed refers to the reviewed code and named tests, not necessarily an already merged release. “Partial” means the failure is reduced or its handling improved but the original quality claim has not been proved. Visual and narrative judges run in the background as advisory checks at the creator's explicit request; do not read earlier mandatory-review decisions as current product policy.

| Issue | Status | Evidence or remaining work |
| --- | --- | --- |
| 1 | Partial | Dialogue is excluded from raw-art generation and a targeted live image contained no lettering; image output is probabilistic and the original sample remains unchanged. |
| 2 | Partial | The visual judge is told that lettering happens later and does not receive dialogue in its panel input. Detection of text baked into art is not calibrated. |
| 3 | Fixed locally | `displayDialogueLines` removes visual indentation from wrapped continuation lines while `wrapDialogue` retains the exact stored text. |
| 4 | Open | Provider outputs may still have differing aspect ratios; composition contains them in fixed panel frames. |
| 5 | Open | A real lantern-state error was observed; prompts and review do not guarantee its absence. |
| 6 | Open | A real duplicated key was observed; image editing and review cannot guarantee removal. |
| 7 | Open | A real location-staging drift was observed; no calibrated prevention is established. |
| 8 | Open | Background artifacts remain a generative-image limitation. |
| 9 | Historical | The published local sample remains unchanged and has known continuity defects. |
| 10 | Open | Live panels visibly drifted from flat-colour reference styling; style calibration remains needed. |
| 11 | Open | The real key/latch error was missed; revised action-review prompting is not a recall guarantee. |
| 12 | Open | Finding severity is uncalibrated and can vary. |
| 13 | Partial | Duplicate of issue 2; missing-lettering false positives were addressed in prompts, not comprehensively calibrated. |
| 14 | Fixed per user direction | Mandatory panel acceptance is removed; background review does not block creation. |
| 15 | Fixed locally | Background narrative reviews distinguish provider failure from a genuine inconclusive verdict and are version-bound. |
| 16 | User-directed behavior | The creator explicitly wants review to be advisory with no mandatory action. |
| 17 | Partial | One live character reference for each of ink-manga and painted-storybook produced recognizable, style-appropriate model sheets. No labelled precision/recall or systematic comic-panel calibration exists. |
| 18 | Partial | Scene-aware classification plus an explicit uncertain-edit choice exists; one live already-off lighthouse example returned artwork. This is not broad calibration. |
| 19 | Partial | Uncertain edits can be explicitly resolved; genuine story changes still route to downstream revision. Classification remains probabilistic. |
| 20 | Open | Image edits can change unrequested pixels; preservation remains prompt/reference based. |
| 21 | Design trade-off | Artwork-only edits preserve other panels by product choice; story-changing edits must use revision and invalidate the affected suffix. Previous-panel visual continuity may still drift. |
| 22 | Open | A malformed revision start is rejected after a paid call; no bounded repair for this exact response shape is established. |
| 23 | Fixed locally | The revision preview shows old and proposed panel actions and dialogue before the creator applies the version-bound change. |
| 24 | Fixed | Revision persistence and partial render failure are surfaced with a saved-change notice; interrupted page operations are cleared on revision. |
| 25 | Open | Later affected pages are marked outdated and generated explicitly, rather than automatically cascading all page renders. |
| 26 | Partial | Exact duplicate state facts are normalized and conflicts rejected. Deterministic checks cannot prove all within-panel physical actions. |
| 27 | Open | Initial setup answers are not automatically rewritten after story revision. |
| 28 | Design/UX | Direct plot/style/answer changes after planning are restricted to protect downstream continuity; discoverability can improve. |
| 29 | Fixed per user direction | Mandatory blocker acceptance is removed; flags stay advisory. |
| 30 | Fixed per user direction | Version guards still protect edits; page readiness does not require acceptance. |
| 31 | Open | Full-page regeneration still needs clearer call/cost expectations. |
| 32 | Partial | Explicit operator reconciliation exists and does not refund calls. Unknown outcomes remain deliberately reserved until investigated. |
| 33 | Partial | Separate stopped-process operator recovery exists for image, text and stalled review operations; this is not a self-service automatic retry. |
| 34 | Design/UX | No automatic retries remain intentional for ambiguous paid outcomes; known pre-dispatch contention could be handled more gracefully. |
| 35 | Open | The reservation ledger is global and does not establish actual token usage or monetary cost per comic. |
| 36 | Open | Shared SQLite processes can have different environment limits. The user explicitly set the preview to unlimited total calls and concurrency 50; other processes may differ. |
| 37 | Partial | `:memory:` provider budgets now fail closed before dispatch. An isolated explicit database remains a separate ledger by design. |
| 38 | Design/UX | Invalid concurrency configuration fails closed; configuration is process/environment based. |
| 39 | Partial | Persisted local page jobs and polling are integrated for page generation. Character references, panel edits and revision application remain synchronous. |
| 40 | Operational | The active preview uses an unlimited total-call policy and concurrency 50; an older independently running server may retain its prior configuration. |
| 41 | Partial | Page-job status is polled; a precise per-panel percentage/counter is not established. |
| 42 | Partial | Page jobs have owner-checked polling; the generic `jobId` fallback is not evidence that every future job type is polled. |
| 43 | Fixed | Publish dialog focuses correctly and displays errors inside the modal; browser regression exists. |
| 44 | Fixed locally | The reader associates image errors with the failing URL so another page does not inherit the error; browser regression passes. |
| 45 | Open | Reader navigation and zoom remain limited compared with dedicated comic tools. |
| 46 | Open | Mobile editor does not implement the planned inspector accordion. |
| 47 | Fixed | Character cards can be edited or removed before planning; changed references require reapproval. |
| 48 | Open | Download remains per-page PNG; no PDF, CBZ or bundled-comic export. |
| 49 | Partly addressed | Browser tests use accessible roles and scoping; additional distinct accessible labels could improve usability and testability. |
| 50 | Fixed locally | Known domain ownership/not-found errors map to 404 and known stale/conflict errors to 409; unrelated errors still return 500. |
| 51 | Fixed locally | Unmatched owned POST routes return 404 after mutation-origin validation. |
| 52 | Architectural debt | Domain and persistence edition types differ and some domain/contract helpers are not used by the API. |
| 53 | Superseded | Page readiness uses current artwork/version state; review findings are advisory. |
| 54 | Architectural debt | Some domain expected-revision arguments originate from the same object; SQLite compare-and-set separately protects persistence races. |
| 55 | Fixed for new operations | Downloads do not persist composites, new editions store assets atomically, and rejected generated assets are removed. Historical orphan files are not automatically removed. |
| 56 | Trade-off | `unpublishedChanges` compares store revisions; some non-publication changes can mark an edition as changed. |
| 57 | Design/limitation | Previous-panel conditioning and character references preserve continuity but limit image-generation parallelism; checks run separately in the background. |
| 58 | Partial | The endpoint remains fixed, but out-of-process-style mocked browser runs exist through the injected fake-provider harness. |
| 59 | Open | Local SQLite/files and localhost guard are not a Vercel-ready storage or public-auth design; dynamic asset tracing still warns. |
| 60 | Partial | New authenticated and guest sessions are server-issued and checked; legacy owned drafts retain a constrained compatibility path. |
| 61 | Open limitation | Origin is checked when supplied and local binding/JSON/cookies provide other protections; the API is not a hardened public authentication boundary. |
| 62 | Positive checks | These are recorded positive checks, not defects; current supported methods and routes have evolved. |
| 63 | Fixed | The committed mocked suite covers the creator journey, signup, reviews, editing, publication, reader and layout; it does not replace live-quality evaluation. |
| 64 | Fixed | `e2e/run-full-flow.sh` starts its own isolated server and fake providers. |
| 65 | Partial | Live QA exercised generation, plot revision, downstream regeneration, publication and reader. One reference each was generated in the other two styles; their comic-panel continuity and actual billed cost remain unverified. |
| 66 | Fixed | App code and QA changes were merged to `main` after local and hosted checks. The original working checkout remains dirty and was preserved. |
| 67 | Partial | A 43-second captioned demo using simulated providers and example art is available in `docs/demo/`. Final submission links and production deployment remain unverified. |

Recent integrated checks: 110 automated unit/API tests, typecheck, and 15 mocked browser tests passed. Hosted QA passed on the PR and merge commit. Live email delivery has not been configured or tested.
