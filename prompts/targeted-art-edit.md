# Targeted artwork edit · v1

Evidence: `api-tested` in one local sample; see `docs/research/live-test-2026-11-01.md` for limitations. Inputs: `change_request`, `preserve_constraints`, `reference_manifest`. Images: image 1 is the target panel to edit; subsequent numbered inputs are approved character/style references and optional adjacent panel, explicitly labelled by role. Output: one replacement target-panel asset. Preservation is an instruction, not a pixel-identity guarantee.

## Template

Edit image 1 only. Requested artwork change: {{change_request}}. Edit mode: {{edit_mode}}. Intended panel and preservation constraints: {{preserve_constraints}}. In restoration mode, the intended storyboard facts take precedence over conflicting details in the target image; correct the requested discrepancy while preserving other intended facts. In cosmetic mode preserve the intended action, character identities, outfits, prop ownership, scene state, composition, and crop. Use the remaining inputs only as reference according to this manifest: {{reference_manifest}}. No lettering, speech balloons, logos, watermark, or additional panels. A request that changes the intended story must be routed for story revision before this template is called.
