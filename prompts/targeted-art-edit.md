# Targeted artwork edit · v1

Evidence: `api-tested` in one local sample; see `docs/research/live-test-2026-11-01.md` for limitations. Inputs: `change_request`, `preserve_constraints`, `reference_manifest`. Images: image 1 is the target panel to edit; subsequent numbered inputs are approved character/style references and optional adjacent panel, explicitly labelled by role. Output: one replacement target-panel asset. Preservation is an instruction, not a pixel-identity guarantee.

## Template

Edit image 1 only. Requested artwork change: {{change_request}}. Keep these unchanged unless explicitly targeted: {{preserve_constraints}}. Preserve the panel's action, character identities, outfits, prop ownership, scene state, composition, and crop. Use the remaining inputs only as reference according to this manifest: {{reference_manifest}}. No lettering, speech balloons, logos, watermark, or additional panels. If the requested change alters a story fact, do not treat it as an artwork-only operation; route it for story revision before calling this template.
