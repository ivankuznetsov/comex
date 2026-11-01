# Comex user walkthrough — 1 November 2026

Scope: one real end-to-end pass as a first-time visitor against the locally deployed production instance
(`bun run start` on 127.0.0.1:3179, served from `/tmp/comex-merged-candidate`, real OpenAI key, unlimited call cap,
main `data/comex.sqlite`). Driven with headless Chromium (Playwright) at 1280×860 and 390×844.
Everything below was actually clicked; nothing is from code reading unless marked. 39 provider calls were spent
(shared reservation count went 164 → 203). Screenshots: the session scratchpad `shots/` folder.

What was made: *Moth and the Night Market* (ink manga, 3 pages × 3 panels, two characters, one artwork edit, one
story revision, published → withdrawn → republished → layout switched → republished), plus a second draft
*The Lighthouse Keeper's Apprentice* (painted storybook) used to probe refresh / edit-card / remove.
Sample `/read/30d50d49-…` was only read, never touched.

Severity: **B** = blocks or silently loses work · **S** = snag that confuses or costs money · **P** = polish.

## 1. Landing and gallery
- **P** Two identical "Create a comic" calls to action in the header and hero, four if you count the reader's end card and the empty-drafts page. Fine, but the header one opens the same page with an "↗" external-link glyph, which reads as leaving the site.
- **P** Cover thumbnails are a tight crop of the top of page 1, so the gallery card leads with a caption box ("Moth: The whole market went dark.") instead of art.
- **P** The reader link wraps the whole cover image but has no accessible name (empty `<a>`); only "Read comic →" is labelled.

## 2. Reader (existing sample and the new comic)
- **S** A page is one tall image; Previous / Next sit under it, roughly 1,800 px down at desktop width. First-time readers see no way to turn the page without scrolling to the bottom. Arrow keys do nothing.
- **S** Page position is not in the URL. Reload or share and you are back on page 1; "Copy link" copies the comic, not the page.
- **S** In headless Chromium "Copy link" fell back to the text "Copy the URL from your browser." The fallback is fine but appears inline next to the button with no spacing, so it reads as a label.
- **P** Vertical-stack pages waste roughly 60 % of the width: landscape or portrait panels are letterboxed into a cream frame, and dialogue is a plain grey box under each panel rather than anything balloon-like. Text wraps early (`"Moth: I'll get you to the\n tower."`, with the stray leading space from the known lettering bug).
- **B** On a phone the two-column layout is unreadable: the whole composed page is 336 px wide and caption text renders at ~6 px. There is no pinch/zoom affordance except an unlabelled link to the raw asset.
- **P** Unknown comic id shows "This comic is unavailable. Return to the gallery." Good. But a draft opened in another browser shows a bare red "Comic not found." with no hint that drafts live in the browser that created them.

## 3. Create form (`/create`)
- **B** "Start creating" silently does nothing unless you type an email, even though the helper text says "Start now in this browser." The email box is the first field and is `required`; the only feedback is the browser's native tooltip, which disappears on the next click. Screenshot 008.
- **B** The email is demanded again for every new comic by the same browser (the guest session already stores it). Second draft: form refused to submit until the address was retyped.
- **S** "Sign in / save drafts" → "Email me a code" fails with "Email sign-in is not configured yet." (503). The header still advertises it on every page. On this instance it is a dead end; the copy on `/create` and `/drafts` keeps pointing at it.
- **S** `/drafts` as a fresh visitor shows two contradictory messages at once: "Sign in to save your browser's drafts…" and a red "Couldn't load drafts. Sign in to see your drafts." (the API returns 401 for a browser without a guest cookie). Also one console error on every `/create` visit for the same reason.
- **P** Style cards show a coloured "COMEX!" block instead of a sample of the style. Choosing ink manga vs painted storybook is blind.
- **P** Browser Back from the editor lands on an empty create form; nothing says the draft was saved under "My drafts".

## 4. Editor, before any pages
- **S** The whole editor is one long single-column page (5,600 px on a phone, ~2,800 px on desktop). Every error and status banner renders at the very top, next to the title. Clicking "Plan story →" at the bottom produced "Approve reference images for every selected character first." 1,600 px above the viewport, invisible, and the page did not scroll. Measured: scrollY unchanged, banner out of view.
- **S** "Publish" is live on an empty draft. The dialog says "0 pages will be included" and still offers "Publish comic"; pressing it answers "All current panels must be generated before publishing." while the dialog stays open.
- **S** The four suggested answers are placeholders, not values. "Save answers" with nothing typed reports "Answers saved." and saves four empty strings. There is no "use this suggestion" action; you retype or copy by hand.
- **S** "Review and add" on a suggested character does not add anything. It silently copies the suggestion into the "Add a character" form further down (outside the viewport, no scroll, no feedback); you must find that form and press "Add character". Measured: form not in viewport after the click.
- **S** "Add character" immediately starts a paid reference drawing with no confirmation. While it runs, every control on the page is disabled, including the answer inputs and the other character's Approve button. The progress banner "Drawing reference…" is at the top of the page, not on the card; the card itself shows "Needs approval" and a "Retry reference" button before any image exists, which reads as a failure.
- **S** Reference images are shown at 505×188 px (natural 1224×1285) with no way to enlarge. You approve a character sheet you cannot really inspect. Moth's reference drew a dress and jacket; the card text says kimono, leggings, apron. Not visible at that size.
- **S** Once a character is approved, "Edit card" and "Remove" disappear and "Regenerate reference" is disabled with no explanation. The "Suggested from your story" box and the "Add a character" form vanish after planning, so a character the planner invents later (Oriel, see below) can never be given a reference.
- **P** "Plan story →" stays enabled after planning and after pages exist. Nothing says what pressing it again would do or cost (code: it replans a suffix).
- **P** "Panels per page" is disabled after planning, "Page layout" is not; the helper copy "Choose before planning." / "Applies to downloads and the next published edition." is the only hint.
- **S** Second draft: pressing "Refresh questions" produced the message "A story request is already running, has an unknown outcome, or the draft changed." and the character suggestions box emptied to a lone "Retry suggestions" button (the auto-fired suggestions request lost a race with my refresh and 409'd). The paid suggestion call was wasted; the error text is developer language.

## 5. Planning and the story review
- **S** Planning took 92 s behind a static "Planning story…" banner at the top of the page; the pages appear far below, and the page does not scroll to them when done.
- **S** The planner introduced a third on-page character, Oriel, from my answers. He has no card, no reference, and the editor never prompts for one. "Story review" then warns about exactly this in raw schema language: "its character_ids list only Moth and Biscuit. Oriel is likewise omitted from the character_ids in p3-panel-1 through p3-panel-3…". A user cannot act on it: there is no way to add Oriel now.
- **P** "Story review: pending" is displayed right after planning with no explanation of what it is waiting for; later it becomes "findings" with a paragraph but no action (no dismiss, no "fix this").
- **P** Planned panels show beats only, no dialogue, until rendered. The only way to change a beat before paying for art is the revision flow, which is itself a paid call.

## 6. Generating pages
- **S** Each page is a single 85–105 s request. The only feedback is "Drawing page…" at the top of the page; the three panels pop in one by one about 25 s apart with no "panel 2 of 3" counter. The design brief's "Drawing page 2 — panel 1 of 3" is not implemented.
- **B** When the request returns, the last panel of the page is still "Panel 3 · checking / Check: checking" and stays that way until you reload. No polling: I waited 90 s on page 2 and 100 s on page 3 and the state never updated in place. Reload showed the finished verdict (page 3 panel 3: blocker). Same after the artwork edit: the panel sat at "checking" with the banner gone.
- **B** The review step has no accept action in this build. Every panel lands in "needs_review" with "Check: blocker / warning / uncertain", and the inspector offers only Edit artwork, Regenerate (page), Change the story. There is no "Accept and continue", no "Check this panel" wording, and nothing explains what needs_review requires. Yet the page header says "current", page 2 can be generated, and the comic can be published. So the whole review surface is noise that looks like a gate.
- **S** Page 1 panel 1 came back "blocker" for framing ("viewed at character height rather than from above") and because Moth was not a silhouette. The findings are long, jargon-labelled (`framing/composition`, `prop_state_continuity`, `not_observable`) and offer no one-click remedy.
- **S** "Regenerate page" on a finished page re-renders all three panels at full price; the label does not say so. There is no plain per-panel regenerate: the per-panel button is "Regenerate panel" but it is disabled until you type an "Edit artwork" instruction, so a targeted edit and a regenerate are the same control with a misleading name.
- **P** "Download page" is a link styled like a button, sitting next to the "Regenerate page" button; keyboard and screen-reader users get two different widget types.

## 7. Artwork edit
- **S** The edit ran 48 s under "Checking edit…", then the banner cleared and the panel showed "Check: checking" with no "Panel updated" notice and the instruction textarea wiped. On reload the panel had a new image and a new blocker (now "location_continuity: water-level canal market, no airborne platforms"). The user cannot tell whether the edit was applied, and the request ("pure black silhouettes") was only partially honoured (figures darkened, not silhouetted). Each attempt is a paid roll with a new, different objection.

## 8. Story revision
- **P** Good: the preview is a proper dialog with before/after beats and the affected range. Two snags remain.
- **S** The preview is lost on reload or navigation, and the typed instruction is cleared, so coming back costs a second preview call (34 s).
- **S** After "Apply story change" on the last panel of the last page, the notice says "Later pages remain outdated until you generate them." There are no later pages. The re-rendered panel again sat at "checking" until reload, and the story review silently swapped to a new finding ("motivation and causal setup…") with no indication it changed.
- **P** The explanation text leaks internal ids ("Panels through p3-panel-2 already establish…").

## 9. Publishing
- **B** Publishing succeeded with every panel unreviewed and one marked "blocker"; republishing after the revision succeeded with the revised panel also "blocker". Combined with the missing accept action this means the gate described in the design ("Show unresolved accepted findings before confirmation") does not exist.
- **S** The dialog's page count is wrong while pages are missing: with only page 1 rendered it said "3 pages will be included."
- **S** Success feedback is a one-line "Published! Your comic is now on the community shelf." at the top of the page; the public URL is not shown, only a "View published" link. The dialog does not show the cover or page count it promised.
- **S** "Withdraw from gallery" is the last element on the page, 3,700 px below "Republish" and "View published". Withdrawal uses a bare `window.confirm`.
- **P** Switching page layout flips the header to "Published · Unpublished changes" immediately; correct, but nothing near the layout control says "republish to apply".
- **S** Two-column layout output: panels sit small inside wide frames, captions wrap into 3–4 word lines ("Moth: Give me the / lantern. I can / fix it."), and a 3-panel page leaves the fourth cell empty with the third panel orphaned bottom-left.

## 10. Which server is "the app"
- **S** Port 3000 (dev server, the one the README tells you to run) is a different UI from port 3179: no email field, a manual "Ask story questions" button instead of auto-fire, and a call cap of 40 already exhausted at 164+ shared reservations, so every AI action there fails. Port 3179 serves a merged candidate copy, not this checkout. A user following the README gets the broken one.

## Not reproduced / confirmed working
- Draft privacy: another browser gets 404 on a draft, withdrawn comics 404 publicly, unknown ids get a friendly page.
- Edit card (shows "Changing a card clears its reference image and approval…"), Remove with confirm, Retry suggestions (4 s) all worked on an unapproved character.
- Download page (vertical and two-column) produced correct PNGs.
- Art quality in ink manga was high and character identity held across all nine panels; the one real story defect (page 3 panel 3 showed Moth, not Oriel, releasing the light) was fixed by the revision flow.
