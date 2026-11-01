# Comex

Turn a story idea into a comic. Pick a style, describe your plot, approve your characters, and Comex draws a consistent comic page by page. Change the plot later and it redraws only what that change touches. Publish it and anyone can read it.

Built for the [DevDay Exchange London Community Hackathon](https://luma.com/dde-ldn-hack), 1 November 2026.

- **Live app:** https://comex-seven.vercel.app
- **Demo video (90 s):** https://seyarabata.com/d/fb332aab4222 · [play on GitHub](docs/demo/comex-demo-90s.mp4)

## What it does

1. **Idea.** Choose a style (clear-line adventure, ink manga or painted storybook) and write a few sentences of plot.
2. **Questions.** Comex asks the questions a writer would ask and suggests answers.
3. **Cast.** It suggests characters. You approve each reference sheet before any panel is drawn, or upload your own reference.
4. **Pages.** Pages are drawn in order. Every panel gets an advisory continuity check.
5. **Revise.** Edit one panel's artwork, or change the story. A preview shows which panels change; earlier panels stay untouched.
6. **Publish.** Published comics appear on the public shelf and can be read without an account.

## Install with a prompt

Paste this into Codex, Claude Code, or any coding agent and it will connect Comex for you:

```text
Connect me to Comex, an AI comic creator, over MCP.
1. Add a Streamable HTTP MCP server named "comex" with URL https://comex-seven.vercel.app/mcp
   (Codex: `codex mcp add comex --url https://comex-seven.vercel.app/mcp`,
    Claude Code: `claude mcp add --transport http comex https://comex-seven.vercel.app/mcp`).
2. Log in with scopes comex:read comex:write comex:generate comex:publish offline_access
   (Codex: `codex mcp login comex --scopes comex:read,comex:write,comex:generate,comex:publish,offline_access`;
    Claude Code: run /mcp and authenticate "comex"), and tell me to approve the consent screen in my browser.
3. List the Comex tools to confirm the connection works, then ask me what comic I want to make.
```

## Connect from Codex (MCP)

Comex exposes a Streamable HTTP MCP endpoint, so you can create comics from Codex or ChatGPT:

```sh
codex mcp add comex --url https://comex-seven.vercel.app/mcp
codex mcp login comex --scopes comex:read,comex:write,comex:generate,comex:publish,offline_access
```

Approve the consent screen in your browser, then ask Codex something like *"Make me a three-page ink-manga comic about a shy lantern repairer and her grumpy cat."* In ChatGPT, add a custom MCP server with the same URL under [Plugins](https://chatgpt.com/plugins). Details: [docs/mcp.md](docs/mcp.md).

> **Status:** the MCP server is merged, but the hosted endpoint still needs its storage and OAuth configured. Until then `/mcp` returns "Comex MCP is not configured." The browser app works today.

## Run locally

Requires Bun 1.4.4 and Node.js 22.13+.

```sh
bun install --frozen-lockfile
bun run dev --hostname 127.0.0.1
```

Real generation needs an OpenAI API key and a provider-call limit. Keep the key in 1Password and inject it at runtime; see [docs/setup.md](docs/setup.md) and `.env.example`.

```sh
bun run typecheck && bun run test && bun run build
```

## Stack

Next.js, TypeScript, Tailwind CSS, Bun, OpenAI (`gpt-6.1-terra` for story and checks, `gpt-image-2.5-flare` for art), deployed on Vercel. The Vercel demo currently routes its API to a local gateway, so drafts and images live on the presenter's machine.

## Credits

Planned and built with OpenAI Codex. One example: Codex reproduced a race that discarded a paid character image when a draft title changed, then added version checks and regression tests. Design reference: [docs/design](docs/design/comex-design-reference.md).
