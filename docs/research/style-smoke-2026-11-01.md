# Style reference smoke test — 1 November 2026

Two live, isolated character-reference generations used `gpt-image-2.5-flare`, the version-1 `character-reference` prompt and version-1 style rules. Both used the same synthetic character: a lighthouse keeper with a dark braid, round glasses, a red coat and black boots. There were no image-reference inputs and no retries. API image size and quality used the application defaults. Exact billed cost and the model snapshot were not measured.

| Preset | Time | Inspected result | SHA-256 of local output |
| --- | --- | --- | --- |
| Ink manga | 14.467 s | Two recognizable full-body views with black-and-white lines, a braid, glasses, coat and boots. | `38ccd99dc80aee4e36476466ca38eec35e5ff5f4773123a59ae323688a1f0185` |
| Painted storybook | 24.332 s | Two recognizable full-body views with warm painted texture, a braid, glasses, red coat and boots. | `d5d8f130dbc0699287012ef6487d47bb20db49db2fe755754b6549ab55d0bf9e` |

Both PNGs were 1312 × 1199 pixels and are local test artifacts, not committed assets. These two samples show the character-reference prompts executed and were visually inspected. They do not test multi-panel consistency, narrative correctness, editing, lettering, or judge calibration, and do not establish that every generation in either style will be consistent.
