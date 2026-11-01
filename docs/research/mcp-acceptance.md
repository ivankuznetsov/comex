# MCP creator acceptance

This is the acceptance procedure, not a record of a completed deployment. Use a dedicated test workspace and sample. Never copy access tokens, cookies, provider prompts, or personal draft content into the record.

The creator clarified that MCP must offer the same decisions as the editor. That includes the editor's explicit, version-bound choice to accept a flagged narrative or panel blocker; it supersedes the older plan's restriction on accepting blockers.

## Evidence boundaries

Record local application and protocol tests separately from hosted execution and each client. A local OAuth exchange or MCP Inspector session does not prove a hosted connection. A fake-provider comic does not prove a paid provider call. Complete the hosted and real-client rows only after the environment and any paid budget have been explicitly authorized.

| Check | Result | Evidence |
| --- | --- | --- |
| Local shared-workflow and storage tests | Pending | Commit, commands, result |
| Local OAuth and MCP protocol tests | Pending | Commit, commands, result |
| Hosted execution and restart | Not run | Deployment identifier, environment, operation IDs, observed result |
| Codex | Not run | Client and version, connection and workflow result |
| ChatGPT plugin | Not run | Client and version, connection and workflow result |
| Dot | Not run | Client and version, plugin and workflow result |

## Run for each client

1. Sign in to the intended Comex browser workspace. Connect the client using its own OAuth grant, recording the client, version, granted scopes, and whether the same draft IDs appear in the editor and client. An empty new browser workspace must not acquire a different owner's drafts.
2. Ask the client to create a comic. Compare the saved questions, question IDs, suggested answers, character suggestions, and choices with the editor. Answer some questions in the client and reload the editor; continue from the editor and reload the client. Confirm that neither interface silently answers questions or approves a character or story.
3. Generate a character reference, inspect its image in the client or the authenticated editor, and approve that exact reference. Replace it elsewhere and verify that approval of the old version fails.
4. Inspect the story beats, dialogue, narrative findings, and available choices. Approve the displayed story version. When a flagged finding is eligible for explicit acceptance in the editor, check that the client presents the same choice and binds it to the displayed version.
5. Start a page, disconnect the client, and retry with the same request key. Record the operation ID and confirm the same operation is returned. Reconnect and inspect the resulting panels and findings; do not generate a replacement merely because a response was lost.
6. Preview a story revision and inspect its affected range before applying it. Verify the unaffected prefix is unchanged and later unfinished pages are shown as outdated. Separately request a lighting-only artwork edit and compare neighboring panel hashes.
7. Export a page privately and verify no public edition appears. Publish only after an explicit request, verify that the edition is readable without a draft session, then withdraw it and verify public access is removed.
8. Revoke this client connection and verify its next protected request fails. Confirm the browser and a separately authorized connection still work.

For each run, record sanitized draft, operation, and edition IDs; chosen tool names; approval and image-preview behavior; timestamps; and any failure or unsupported client behavior. If a client cannot show an image, record the authenticated editor review fallback and whether it worked. Never mark an unexecuted client or restart check as passed.
