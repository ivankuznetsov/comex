# Continuity calibration rubric · v1

Status: proposed, not calibrated. These expected labels are evaluation metadata and must never be supplied to the judge. Use each panel's actual approved story, scene ledger, reference manifest, and (for vision) independently labeled full-resolution images as inputs.

- A critical narrative contradiction needs the first invalid panel and concrete expected versus observed state; a deterministic impossible transfer independently blocks rendering.
- An observable identity, prop, or style contradiction needs the relevant panel and approved reference; never score an occluded trait as a mismatch.
- An explicitly recorded outfit change and a monochrome equivalent of a colored identifying trait must not cause blockers.
- Missing essential image, refusal, malformed output, or timeout is inconclusive, not pass. The judge cannot update the bible to excuse a bad result.
- A result passes the initial automation gate only if every seeded critical failure is detected and approved baseline/legitimate-change controls get no blocker. Repeat baseline and hardest failure; after tuning, use unseen valid and invalid holdouts. Record false positives, false negatives, abstentions, model, prompt and asset hashes, settings, usage and latency per case.
- Keep findings advisory. The comparison does not authorize automatic repairs; story defects use the existing story-revision flow.

A small corpus cannot establish statistical reliability. Human-review the fixture labels and final demonstration.

The Decisions comparison is evaluation only: no score or threshold in this rubric enables automatic regeneration or bypasses creator review. The included synthetic candidates remain unreviewed until inspected by a person; offline replay does not measure model performance.
