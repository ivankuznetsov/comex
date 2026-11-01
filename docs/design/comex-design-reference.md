# Comex — design reference for Terra

## Approved direction

The user selected **[Secret Wars #1 (1984)](https://www.marvel.com/comics/issue/10580/session_trace/aggregate)** as the primary reference for the **entire interface**. Use its newsstand-cover energy: large emphatic lettering, red/yellow/blue color blocking, heavy ink outlines, rectangular panels, and small caption boxes. This is a design interpretation of the reference, not a recreation of its artwork or logo.

Reference lookup: 1 November 2026. [Cover image listing](https://www.mycomicshop.com/search?ItemID=60585296). Marvel credits Michael Zeck as the cover artist. Keep external artwork as linked research, not bundled product assets. Use original Comex lettering and original/demo-generated comic art.

The proposed [layout sheet](comex-layout-reference.svg) translates this direction into gallery, editor, and reader screens. It is a static design artifact with illustrative content, not a working application, approved generated artwork, or proof of browser behavior. Its display type uses system fallbacks; the typography below governs implementation.

## Visual hierarchy

Make the product feel like picking up a comic from a newsstand, then opening it at a drawing desk. A large **COMEX** wordmark anchors the gallery. Use a compact version in the editor and reader so the work has room. The reader has fewer decorative accents, but retains the same paper, ink, lettering, and navigation language.

The interface theme stays fixed even when the creator chooses manga, painted storybook, or another generated-art style. Do not recolor generated art or force it into superhero imagery.

## Tailwind tokens

Implement these as shared theme variables, not repeated arbitrary values. Values are proposed design choices; check contrast in the built app.

| Token | Value | Use |
| --- | --- | --- |
| paper | `#FFF8E8` | Main background, light warm print stock |
| panel | `#FFFEF8` | Forms, speech balloons, reading surface |
| ink | `#171717` | Body text, outlines, hard shadows |
| yellow | `#FFD83D` | Caption strips, primary action, selected items |
| red | `#CF302B` | Wordmark fill, urgent emphasis, danger borders |
| blue | `#1849A9` | Navigation accents and focused areas |
| muted | `#56514A` | Supporting text on paper |
| border-panel | `3px solid ink` | Panels and cards |
| border-control | `2px solid ink` | Inputs and buttons |
| shadow-print | `4px 4px 0 ink` | Buttons, cover cards, dialogs |
| radius | `0–3px` | Mostly square corners |

Use ink text on yellow/paper. White text may appear on blue; verify actual contrast. For errors use ink text on pale paper with a red border and explicit wording. Never make color the only status signal.

## Type, spacing, and decoration

- Display: [Bangers](https://fonts.google.com/specimen/Bangers), locally bundled with its license after verification. Use for wordmark and short headlines only. Fallback: Impact, sans-serif. Wordmark uses red fill, ink outline, yellow offset backing; create an original shape, not the reference logo.
- Controls: bold system sans-serif; body/form text: system sans-serif, 16px minimum and 1.5 line height. Long text and guidance use sentence case. Reserve capitals for short display headlines.
- Gallery headline 48–72px desktop / 36–44px mobile; section heading 28–36px. Controls 14–16px with at least 44px hit targets. Grid spacing 24px; panel padding 24px desktop / 16px mobile.
- Max content width 1200px. Keep text/form measures around 60 characters. Use real page gutters and strong alignment, not randomly rotated cards.
- Small halftone fields at 5–10% ink opacity belong in decorative margins and banner corners. Keep form text and artwork clear. Implement with CSS/SVG rather than a texture download.
- One burst-shaped accent can mark the gallery's Create action; ordinary controls remain recognizable buttons. Speech balloons can hold short guidance, with readable rectangular fallbacks on narrow screens.
- Hover moves a hard-shadow button by 1px; press reduces its shadow. Focus gets a clear 3px ring with paper separation. Honor reduced motion; no flashing, page-turn animation, or moving halftone.

## Screen contract

| Surface | Layout and behavior |
| --- | --- |
| Gallery `/` | Masthead, Browse / My drafts / Create navigation; short headline; published cover grid. Each cover has title, display name, page count, and Read comic. Newest publications first. Desktop 3 columns, tablet 2, phone 1. Only real published records appear; no fabricated counts or testimonials. |
| Empty gallery | One framed empty panel: “The first issue is yours to make.” Create a comic action. No pretend published samples. |
| Creator setup `/create` | One focused form panel: plot → questions → characters → story beats. Numbered caption strip shows progress. Provide Back without losing inputs. Style choices show original reference thumbnails when available. |
| Character approval | Card shows image, name, role, identity traits, outfit, Edit and Approve. Approval is explicit; failure retains the card. Character selection remains visible and keyboard usable. |
| Editor `/comics/[id]` | Compact masthead. Left page rail, large page canvas, right story/continuity inspector on desktop. Selected panel has a yellow outer frame outside its art. Show Edit artwork and Change story as separate labeled actions. Top actions: Preview, Publish or Republish. My drafts is session-owned, not a public creator profile. |
| Mobile editor | One column: page selector, canvas, selected-panel actions, inspector accordion. No squeezed three-column layout. Show the affected page range immediately before a story revision is applied. |
| Publishing | Dialog previews title, optional creator display name, cover, and page count. Explain “This edition will be public. Later edits stay private until you republish.” Show unresolved accepted findings before confirmation. Public URL and View published comic appear after success. |
| Reader `/read/[id]` | Compact masthead, Back to comics, title/byline, published page canvas, Previous / Page N of M / Next, copy link. Page assets fit width; allow zoom/full-resolution inspection. Last page offers Back to comics and Create your own. No edit or fork controls for readers. |

For the demo, explain in creator setup: “Your drafts are saved for this browser. Keep this session to edit them.” Display names are pseudonyms, never ownership credentials. Publishing remains optional.

## States and exact action language

| State | Presentation |
| --- | --- |
| Generating | Caption “Drawing page 2 — panel 1 of 3.” Show completed panels; no invented percentage or countdown. |
| Checking | Caption “Checking characters and story…” with static progress markers. |
| Needs review | “Check this panel” plus localized finding, Regenerate, and Accept and continue. Acceptance retains the uncertainty. |
| Outdated | “Story changed — this page needs updating.” Keep historical art visible with a distinct frame and label. Prevent publishing it as current. |
| Unknown outcome | “We couldn't confirm this generation finished.” Show recovery status; no auto-paid retry disguised as Retry. |
| Failure | Plain description, preserved inputs/output, and the applicable recovery action. Use no joke that hides the failure. |
| Public edition | “Published” in creator controls; separately show “Unpublished changes” when the draft differs. |
| Withdrawn/missing | Public reader says the comic is unavailable and links to the gallery. Do not disclose private title, thumbnails, or draft metadata. |

## Verification for Terra

Build the shared tokens and shell first. Capture gallery, setup, character approval, editor with findings, publish preview, and reader at 1440px and 390px. Compare screenshots with this brief and the layout sheet using a vision judge; request concrete element-level findings for typography, palette, spacing, comic identity, and readable state labels. A judge checks the interface, not the generated art style.

Use browser assertions for route behavior, keyboard focus, dialog dismissal, 44px controls, overflow, owner/reader separation, publication state, and page order. Run contrast checks on actual text/background pairs. Do not allow a visual judge's approval to override failing interaction or privacy checks. A brief human check settles visual hierarchy and reading comfort.

## Implementation boundaries

No profiles, likes, comments, search infrastructure, comic forks, novelty cursors, or decorative sound. Do not add unbuilt features to mockups as active controls. Use the existing generation/continuity plan; this document defines presentation, not a second application architecture.

The selected reference is Secret Wars #1. Other researched sources, [2000 AD production art](https://secretoranges.substack.com/p/classic-2000-ad-covers) and [Watchmen](https://www.dc.com/graphic-novels/watchmen-1986/watchmen), are research context only and do not override the chosen direction.
