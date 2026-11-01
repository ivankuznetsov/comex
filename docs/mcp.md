# Connect Comex to an assistant

On the Comex home page, click **Copy prompt** under **Connect your agent** and paste it into your assistant. The prompt includes the MCP endpoint and setup instructions for the agent. No connection dashboard or permission settings are needed. Complete the browser sign-in when your client opens it, then describe your comic.

Once Comex is deployed and its hosted storage, OAuth, and generation worker are configured, use its HTTPS `/mcp` endpoint to connect an assistant. Sign in to the Comex browser workspace containing your drafts before approving the connection. A new browser session can represent a different workspace; connecting it does not automatically transfer drafts from a local installation.

## Codex

Replace the example URL with your deployment's canonical endpoint:

```sh
codex mcp add comex --url https://comex.example/mcp
codex mcp login comex --scopes comex:read,comex:write,comex:generate,comex:publish,offline_access
```

Complete the consent screen in your browser. The ChatGPT desktop app and IDE extension can also add a **Streamable HTTP** server in their MCP settings. Their local Codex configuration is shared on the same host. See [OpenAI's MCP setup guide](https://learn.chatgpt.com/docs/extend/mcp).

## ChatGPT and Dot

In [ChatGPT Plugins](https://chatgpt.com/plugins), choose the plus button, **Add custom MCP server**, and enter the deployed HTTPS `/mcp` URL. Configure authentication, create and install the plugin, and connect it to your Comex workspace. In a new chat, select the plugin with `@`. See [OpenAI's connection steps](https://developers.openai.com/plugins/build/app-quickstart#connect-your-mcp-server-in-chatgpt).

Dot can use supported plugins installed and enabled for your account, subject to their permissions and execution environment. Install and connect the Comex plugin first; see [Dot app connections](https://learn.chatgpt.com/docs/dots/computers-and-apps#connect-apps).

## Create and review

Ask the assistant to start or continue a comic. It should use the same saved questions, suggested answers, character cards, story, and review choices as the Comex editor. The questions are generated for the draft and are not automatically answered. Review references, story beats, and panel findings before explicitly approving or accepting the displayed version. A refreshed draft may require a new approval.

The local editor runs reviews in the background; a hosted generation operation currently waits for its review before completing. Review findings are advisory and do not prevent drawing later pages or publishing complete artwork.

Generation may continue after a conversation disconnects. Resume by checking the existing operation instead of requesting a replacement. Export is private; publishing or withdrawing an edition is a separate explicit action. The editor remains available for reviewing an image if your client cannot display it.

## Authentication and verification

The connection grants selected read, write, generation, and publication capabilities. Review the requested permissions during consent. The app has no connection-management screen. The underlying authenticated revocation API remains available for operators and clients; removing a grant does not delete drafts. Legacy `/connections` links redirect to the home-page prompt.

The [acceptance procedure](research/mcp-acceptance.md) records local tests and hosted Codex, ChatGPT, and Dot checks separately. Until the hosted checks have been performed, client availability, image display, OAuth interoperability, and restart recovery remain unverified for that deployment.
