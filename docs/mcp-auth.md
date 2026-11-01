# MCP authentication and import handoff

Comex uses the existing browser guest or email session to authorize each client. A connection has its own internal OAuth session and can be revoked through the authenticated `/api/mcp-auth/comex/connections` API without signing out the browser or changing another connection. A browser with no session creates a new empty workspace on consent. A legacy browser cookie is converted to a separate owner after its holder approves the connection.

Set `COMEX_APP_URL` to the exact canonical origin and set a separate, random `COMEX_MCP_AUTH_SECRET` of at least 32 characters in the secret manager. HTTPS is required except on a loopback development origin. Local SQLite needs an explicit one-time library migration:

```sh
bun run mcp:auth:migrate
```

For Postgres, apply the normal versioned storage migrations using `bun scripts/hosted-storage.ts migrate` with `DATABASE_URL` provided securely. This also installs the Better Auth 1.7.15 schema. Never run either migration implicitly against production data. Configure managed Postgres before enabling hosted authentication; the runtime refuses to use local SQLite on Vercel.

Clients use the canonical `/mcp` resource and discover OAuth endpoints through the protected-resource metadata. Authorization uses PKCE S256. `comex:read`, `comex:write`, `comex:generate`, and `comex:publish` are independent scopes; generating requires write plus generate, and publishing requires write plus publish. DCR is available for client compatibility; CIMD uses the library's Node transport, which resolves once, rejects non-public addresses, pins the approved address and refuses redirects. The server's bearer boundary checks the signature, issuer, audience, expiry, client, subject, anonymous session, grant and required scopes. Revocation invalidates refresh records before removing that grant's session.

The connection session lasts up to 30 days and is checked even when a refresh token remains valid. Reconnect after it expires. Clients may request a narrower set of scopes.

## Imported local drafts

The import and its handoff are explicit operator actions. They do not happen on startup. Imported drafts remain hidden until claimed. After a trusted SQLite-to-Postgres import, register the imported owners from the recorded batch on the destination:

```sh
bun run mcp:register-import -- <batch-id>
```

Use `DATABASE_URL` for the destination. The command derives the source owners from the imported batch; it does not take an owner identifier or a cookie as input. Provision the same `COMEX_IMPORT_HANDOFF_SECRET` (a separate random secret of at least 32 characters) only to the trusted original local installation and the destination. Set `COMEX_IMPORT_DESTINATION_URL` on the local installation to the exact destination origin. Do not give that secret to other local servers.

In `/import-drafts` on the authenticated destination, create a challenge for the batch. In the original local browser, open `/import-drafts`, paste the challenge and verify the browser. Paste the resulting one-time proof into the destination page within ten minutes. The proof is bound to the batch, destination origin and destination owner. The local cookie is checked locally and is never sent to the hosted origin or placed in a URL. Redemption moves the imported drafts and completed operation history together, and replay or a different destination session is rejected. Active or unresolved operations prevent the claim until they are resolved. Source-origin connections are retained as revoked history and must be connected again on the destination.

Local protocol tests and isolated browser tests do not establish a hosted deployment or a successful Codex, ChatGPT or Dot connection. Those checks require a separately authorized environment and real client acceptance.
