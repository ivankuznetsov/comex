# Comex

Turn a story idea into a comic, with original characters, editable pages, and a public reading shelf. Comex is being built for the DevDay Exchange London Community Hackathon on 1 November 2026.

The current build runs locally. The user interface follows an eighties comic-book direction; see the [design reference](docs/design/comex-design-reference.md). The [implementation plan](docs/plans/2026-11-01-1240-feat-comex-hackathon-plan.md) describes the complete intended journey.

## Local setup

Install Bun 1.4.4 and Node.js 22.13 or later. In this checkout:

```sh
bun install --frozen-lockfile
bun run dev --hostname 127.0.0.1
```

Open the local address printed by Next.js. Drafts and images are stored in the ignored `data/` directory. Your browser session owns your drafts; keep the session if you want to edit them later.

Real story and image generation needs an OpenAI API key and access to the configured models. Keep the key in 1Password and inject it into the local process; never commit it. See [local setup](docs/setup.md) and `.env.example`. A local three-page test has been generated; see the [live test findings](docs/research/live-test-2026-11-01.md). Actual monetary cost has not been measured.

```sh
bun run typecheck
bun run test
# With the app running on 127.0.0.1:3100 and Chromium installed:
bun run test:e2e
bun run build
```

## Scope and status

The local build includes draft creation, character cards, continuity checks and publication machinery. Some generation and edit paths may remain incomplete; consult the verification results before relying on them. LLM findings are advisory until calibrated against real examples. Forking comics is future scope.

SQLite and local asset storage are for local development only. Deployment, hosted storage, durable jobs, and 1Password-to-GitHub-to-Vercel secret synchronization remain unverified. No production deployment has been made.

## Credits

Planning, research, and implementation were assisted by OpenAI Codex. Interface inspiration is credited in the [design reference](docs/design/comex-design-reference.md); the included layout study is original. Dependencies are recorded in `package.json` and `bun.lock`.

[Event](https://luma.com/dde-ldn-hack) · [OpenAI documentation](https://developers.openai.com/api/docs) · [Codex](https://developers.openai.com/codex)
