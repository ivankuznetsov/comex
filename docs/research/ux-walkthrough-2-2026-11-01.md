# Comex user walkthrough, second pass — 1 November 2026, evening

Scope: a fresh visitor on https://comex-seven.vercel.app (Vercel → tunnel → local gateway → server on port 3188,
build of `main` at `277f408`, `gpt-6.1-terra`). Headless Chromium, 1280×860 and 390×844, every step clicked.
Made *The Lighthouse Keeper's Apprentice* (painted storybook, 3 × 3 panels, two characters), one artwork edit,
one routed edit, one story change attempt, published, read as a second visitor. A first attempt on local port
3188 was cut short when that server was restarted mid-test.

Severity: **B** blocks or loses work · **S** snag that confuses or costs money · **P** polish.

## Fixed since the first walkthrough
Style cards show real example art. My drafts greets a new visitor properly. "Use suggestion" fills an answer.
"Review suggestion" scrolls to the form, fills and focuses it. Notices are toasts. Paid buttons say "(AI call)".
References open full size. A "Review your story" step shows every beat and line before approval. Panel checks
finish before the page request returns; no more stuck "checking". Reviews are advisory and say so. Edit routing
spots a plot change typed into the artwork box in 4 s and offers "Preview as story change". The publish dialog
counts pages honestly and the success toast shows the public URL. The reader has arrow keys, `?page=` in the
URL, controls above the page and a zoom hint.

## Blockers
- **B · Dialogue is unreadable in every newly composed page.** Captions render as rows of empty boxes in the
  reader and in downloaded PNGs. Older editions (Moth) are fine. The lettering code asks for `sans-serif`; the
  same library renders it correctly from a shell in the same build folder, so the running server's launch
  environment cannot resolve fonts. A fresh comic published now has no readable dialogue.
- **B · A failed story preview locks story changes for the comic.** The first "Preview story change" ran 30 s
  and ended with "The operation outcome is unknown. Check its status before trying this action again." The
  "Check status" button under Draft activity does nothing visible. Every retry answers "The previous operation
  has an unknown outcome." There is no way out in the UI. The typed instruction is also lost on reload.

## Snags
- **S** Email is still required to start, enforced only by the browser tooltip. Sign-in fails with "Could not
  send the sign-in email. Please try again." (502), which invites retries that cannot work.
- **S** Thin story setup: one yes/no-style question and one suggested character for a story that names a
  grandmother and fishing boats. Once that suggestion is used, "Suggested from your story" is an empty box.
- **S** "Upload a reference for new character" exists locally but not on Vercel, while the hint under the form
  says "Reference uploads are available before planning pages."
- **S** While a reference draws, the card already shows "Retry reference", which reads as a failure.
- **S** Planning takes ~87 s and pages ~80–87 s each behind a single "…" status line; no panel counter.
- **S** Story logic slips past the checks: page 1 panel 1 showed Tamsin inside the lighthouse looking at a
  second lighthouse, rated **pass**. After fixing it with an artwork edit, panel 2 still shows the second
  lighthouse; edits don't flag neighbouring panels with the same defect.
- **S** False blockers: page 3 panels 1 and 2 were marked **blocker** for "three hands"; two hands are visible.
- **S** After an artwork edit there is no "panel updated" message, and the instruction stays in the box with
  "Apply artwork edit (AI call)" still enabled, so a second click pays to repeat it.
- **S** Edit routing's toast says "Review the current findings and pending decisions before continuing." — jargon.
- **P** "Review your story" prints prompt text under Story rules, with ".;" punctuation glitches.
- **P** Download needs two clicks: "Prepare download", then "Download page".
- **P** Mixed panel shapes: tall and wide panels letterboxed in one vertical page; the editor page is ~4,800 px tall.
- **P** Images load visibly late through the tunnel (blank white panel frames while scrolling).
- **P** Connections page offers "Claim an imported local workspace" with no explanation.

## Numbers
| Step | Time |
|---|---|
| Questions + suggestions | 17 s |
| Each character reference | 18 s |
| Story plan | 87 s |
| Pages 1 / 2 / 3 | 81 / 87 / 79 s |
| Artwork edit | 27 s |
| Edit routing | 4 s |
| Story preview | failed at 30 s |
| Publish | 4 s |
