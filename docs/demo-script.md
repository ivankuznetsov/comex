# Comex demo video — scenario v2 (≤ 90 s)

Angle: everybody loves comics; Comex turns you into a creator. Two doors in: ask Codex over MCP, or use the
browser. Either way you get a consistent, revisable, publishable comic, and you can even put yourself in it.
Screen recording at 1280×800, cut hard, voice-over from `tmp/demo-voiceover/`. Nothing generates live on
camera; one honest caption says so. Public URL: the Vercel deployment (https://comex-seven.vercel.app). MCP endpoint: `https://comex-seven.vercel.app/mcp` once the merge lands.

## Shot list

| t | On screen | Voice-over (cue) | Prep |
|---|---|---|---|
| 0–6 s | Fast montage: the gallery covers, a reader page, a panel close-up. Title card "COMEX". | 1. "Everybody loves comics. So why not make one?" | Gallery already has two published comics. |
| 6–19 s | Codex window. Type `codex mcp add comex https://comex-seven.vercel.app/mcp`, then the prompt: "Make me a three-page ink-manga comic about Moth, a shy lantern repairer in a floating night market." Show Comex tool calls scrolling (create draft, answer questions, suggest characters). | 2. "Comex speaks MCP. Connect it to Codex, and just ask for a comic." | If the MCP merge is not live at record time, pre-record this clip against the dev branch and keep the caption "MCP: merging today". |
| 19–31 s | Browser `/create`: pick a style card, paste the plot, Start creating. Cut to the editor's questions with answers filling in. | 3. "Or open the browser. Pick a style, type your idea, and write your characters. Or let Codex write them for you." | Paste, don't type. Throwaway email. |
| 31–43 s | Section 02: suggested cast cards with reference sheets, click Approve. Then the upload form: drop in a photo, a reference sheet of that person appears next to Moth and Biscuit. | 4. "Comex designs the cast. Approve every face. Or upload a photo and put yourself in the story." | Pre-generate the self-portrait reference on a draft before recording. Verify the upload form is on the build you record. |
| 43–57 s | Click Page 1, Page 2, Page 3 of *Moth and the Night Market*. Linger on the rope climb and the finale. Flash the inspector's continuity findings on one panel. | 5. "Then it draws, page by page. Same characters, same world, every panel checked for continuity." | Already rendered at `/comics/5c014b7d-c8a6-4163-816f-5074a2d25fb8`. Reload before showing. |
| 57–69 s | Type into Change the story, click Preview, cut to the Before/After dialog ("Changes start at page 3, panel 3. Earlier panels stay unchanged."), click Apply, cut to the redrawn panel. | 6. "Change the plot, and Comex redraws only what that touches." | Preview ~30 s, redraw ~45 s: cut both. Or use the existing before/after editions of page 3. |
| 69–81 s | Republish → Publish comic. Incognito window: gallery, Read comic, Next, Next, "THE END. FOR NOW." | 7. "Publish, and anyone can read it. No account. No app." | Incognito so it is visibly another session. |
| 81–87 s | Credits card: gpt-6.1-terra + gpt-image-2.5-flare, "planned and written with Codex", one concrete Codex contribution. | 8. "Built today with OpenAI and Codex." | Static card. |
| 87–90 s | End card: public URL, repo, `/mcp`. | 9. "Your story starts here." | Fill URLs last. |

## Rules for the take
- Reload the editor after any generation or edit before showing it, or the last panel says "checking".
- Never press Regenerate page, Plan story or Add character on camera: paid call, long wait.
- Keep Moth on Vertical stack for the video.
- One caption during 43–69 s: "Generation times cut; everything shown is real output."
- Sign-in is not configured: never click "Sign in / save drafts".

## Prep (10 min)
1. Switch *Moth* back to Vertical stack, republish.
2. On a spare draft, upload a photo as a character and let the reference draw, so shot 4 is ready.
3. Record the Codex/MCP clip separately (or against the merging branch).
4. Two windows at 1280×800: creator (normal), reader (incognito).
5. Static cards: title, credits, end. Bangers font, yellow `#ffd83d`, ink `#171717`.
