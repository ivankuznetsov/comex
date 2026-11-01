# Comex

Turn a story idea into a comic, with original characters, editable pages, and a public reading shelf. Comex is being built for the DevDay Exchange London Community Hackathon on 1 November 2026.

The current build runs locally. The user interface follows an eighties comic-book direction; see the [design reference](docs/design/comex-design-reference.md). The [implementation plan](docs/plans/2026-11-01-1240-feat-comex-hackathon-plan.md) describes the complete intended journey.

[Watch the 43-second demo](docs/demo/comex-demo-simulated.mp4). It uses simulated AI and email providers with example artwork; it does not demonstrate live email delivery.

## Local setup

Install Bun 1.4.4 and Node.js 22.13 or later. In this checkout:

```sh
bun install --frozen-lockfile
bun run dev --hostname 127.0.0.1
```

Open the local address printed by Next.js. Drafts and images are stored in the ignored `data/` directory. New creators can start a draft with an email address; email-code sign-in saves those drafts to an account. Real code delivery requires the sender and secrets described in [local setup](docs/setup.md).

Real story and image generation needs an OpenAI API key and access to the configured models. Keep the key in 1Password and inject it into the local process; never commit it. See [local setup](docs/setup.md) and `.env.example`. A local three-page test has been generated; see the [live test findings](docs/research/live-test-2026-11-01.md). Actual monetary cost has not been measured.

```sh
bun run typecheck
bun run test
# With Chromium installed, run the isolated fake-provider browser suite:
./e2e/run-full-flow.sh
bun run build
```

## Scope and status

The local build includes draft creation, character cards, continuity checks and publication machinery. It automatically asks story questions and suggests editable character cards; selecting and adding a card starts its reference image. Questions, suggestions, and images each use provider calls. One live story produced appropriate character suggestions, but the prompts and checks are not broadly calibrated. Reviews run in the background and their findings are advisory. Later pages affected by a story revision are marked outdated and must currently be generated individually. Forking comics is future scope.

SQLite and local asset storage are for local development only. Deployment, hosted storage, durable jobs, and 1Password-to-GitHub-to-Vercel secret synchronization remain unverified. No production deployment has been made.

## Credits

Planning, research, and implementation were assisted by OpenAI Codex. For example, Codex reproduced a race that discarded a paid character image when a draft title changed, then added version checks and regression coverage so unrelated changes no longer discard it. Interface inspiration is credited in the [design reference](docs/design/comex-design-reference.md); the included layout study is original. Dependencies are recorded in `package.json` and `bun.lock`.

[Event](https://luma.com/dde-ldn-hack) · [OpenAI documentation](https://developers.openai.com/api/docs) · [Codex](https://developers.openai.com/codex)
