# Comex prompt pack

Version 1; selected prompt components have been API-tested in one local sample; see [the live test](../docs/research/live-test-2026-11-01.md) for failures and scope. Other components and style presets remain proposed. API-tested is not a quality guarantee. Place user values into the named placeholders as data and use the specified response schema. Validate response structure and business rules before acting; handle refusals, missing inputs and malformed outputs as inconclusive. Apply the numeric question/page/panel limits as supplied application configuration rather than fixed product limits.

Image input order must match the explicit role manifest. Never send secrets to a model. The application owns reference approval, version checks, edit routing, repair limits, and output storage; no prompt can guarantee those properties. See `docs/research/prompt-evidence.md` and `evals/rubrics/continuity.md` for evidence and calibration policy.

Edit routing uses the current panel and approved character references with the intended storyboard. A restoration follows intended scene facts; story changes and questions return to the creator for a separate decision. These routes have not been calibrated by a live evaluation.
