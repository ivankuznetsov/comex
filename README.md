# Comex

Turn a short idea into a comic with consistent characters and an editable story.

Comex is being built for the DevDay Exchange London Community Hackathon on 1 November 2026. Submission closes at 17:00 London time.

## Current state

Planning only. There is no runnable application yet, and no API access, generated comic, or deployment has been verified.

Read the [implementation and verification plan](docs/plans/2026-11-01-1240-feat-comex-hackathon-plan.md).

## Planned stack

- Next.js App Router, TypeScript, Tailwind CSS, and Bun
- OpenAI for story refinement, image generation/editing, and narrative/visual checks
- Vercel hosting and durable workflows
- Managed Postgres for story state and private Blob storage for images
- 1Password as the secret source, integrated with trusted GitHub Actions

## Planned experience

Choose a style and describe a plot, answer tailored questions, approve characters, and generate the comic page by page. Regenerate a panel or page, or revise the plot and update its affected continuation. Creators publish completed comics; readers browse the public gallery and read without signing in. Comic forking is future scope.

The entire interface follows an eighties comic-book direction. See the [Terra design reference](docs/design/comex-design-reference.md).

## Setup

Application setup instructions will be added with the implementation. Do not place API keys, service-account tokens, or deployment credentials in this repository. Actual credentials belong in 1Password; committed configuration will contain secret references or empty examples only.

## Verification

The plan combines exact software checks with calibrated LLM judges for story, character, and style continuity. It requires honest reporting of mocked tests, live API evidence, unresolved findings, and model limitations.

## Credits

Planning and research were assisted by OpenAI Codex. No existing application template, third-party artwork, or generated image asset has been included yet. The design reference includes an original SVG layout study and linked historical references. Implementation dependencies and asset credits will be recorded as they are added.

[Event](https://luma.com/dde-ldn-hack) · [OpenAI documentation](https://developers.openai.com/api/docs) · [Codex](https://developers.openai.com/codex)
