# Continuity calibration rubric · v1

Status: proposed, not calibrated. These expected labels are evaluation metadata and must never be supplied to the judge. Use each panel's actual approved story, scene ledger, reference manifest, and (for vision) independently labeled full-resolution images as inputs.

- A critical narrative contradiction needs the first invalid panel and concrete expected versus observed state; a deterministic impossible transfer independently blocks rendering.
- An observable identity, prop, or style contradiction needs the relevant panel and approved reference; never score an occluded trait as a mismatch.
- An explicitly recorded outfit change and a monochrome equivalent of a colored identifying trait must not cause blockers.
- Missing essential image, refusal, malformed output, or timeout is inconclusive, not pass. The judge cannot update the bible to excuse a bad result.
- A result passes the initial automation gate only if every seeded critical failure is detected and approved baseline/legitimate-change controls get no blocker. Repeat baseline and hardest failure; after tuning, use unseen valid and invalid holdouts. Record false positives, false negatives, abstentions, model, prompt and asset hashes, settings, usage and latency per case.
- If the gate fails, keep findings advisory, disable automatic repairs, and require recorded creator acceptance. If calibrated, permit at most one local image repair per panel and two per comic; recheck repairs and transitions. Story defects use plot revision. Ambiguous blocking judgments may be escalated once to a separately accessible model; disagreement remains uncertain.

A small corpus cannot establish statistical reliability. Human-review the fixture labels and final demonstration.
