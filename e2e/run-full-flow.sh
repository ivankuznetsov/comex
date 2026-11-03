#!/usr/bin/env bash
# Isolated, deterministic E2E run: never loads the developer's .env.local or API credentials.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -e .env.local ]]; then
  echo 'Run this script in a worktree without .env.local; do not move or remove user secrets.' >&2
  exit 1
fi
qa_dir=$(mktemp -d "${TMPDIR:-/tmp}/comex-e2e.XXXXXXXX")
qa_port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
qa_hosted_port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
while [[ $qa_hosted_port == "$qa_port" ]]; do
  qa_hosted_port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
done
qa_pid=''
qa_mcp_secret='e2e-mcp-auth-secret-of-at-least-32-characters'
mkdir "$qa_dir/mailbox"
stop_server() {
  if [[ -n $qa_pid ]]; then kill "$qa_pid" 2>/dev/null || true; wait "$qa_pid" 2>/dev/null || true; fi
  qa_pid=''
}
cleanup() {
  stop_server
  echo "E2E files and server log retained at $qa_dir"
}
trap cleanup EXIT

# The OAuth consent tests exercise Better Auth against this isolated SQLite database.
env -u DATABASE_URL -u VERCEL -u OP_SERVICE_ACCOUNT_TOKEN -u NODE_OPTIONS \
  COMEX_DB_PATH="$qa_dir/comex.sqlite" COMEX_APP_URL="http://127.0.0.1:$qa_port" \
  COMEX_MCP_AUTH_SECRET="$qa_mcp_secret" bun run mcp:auth:migrate

start_server() {
  local mode=$1 port=$2 database=$3 log=$4
  env -u DATABASE_URL -u OP_SERVICE_ACCOUNT_TOKEN -u VERCEL -u BLOB_READ_WRITE_TOKEN \
    COMEX_RUNTIME="$mode" COMEX_E2E_FAKE_PROVIDER=1 OPENAI_API_KEY=e2e-fake-key COMEX_DB_PATH="$database" \
    COMEX_BUDGET_DB_PATH="$qa_dir/budget.sqlite" COMEX_ASSET_PATH="$qa_dir/assets" COMEX_MAX_PROVIDER_CALLS=200 \
    COMEX_MAX_CONCURRENT_CALLS=1 COMEX_APP_URL="http://127.0.0.1:$port" COMEX_MCP_AUTH_SECRET="$qa_mcp_secret" \
    COMEX_EMAIL_FROM='Comex <test@example.test>' RESEND_API_KEY=e2e-fake-resend-key COMEX_AUTH_SECRET=e2e-auth-secret-of-at-least-32-characters COMEX_E2E_MAILBOX="$qa_dir/mailbox" \
    NODE_OPTIONS="--require=$PWD/e2e/fake-provider.cjs" \
    node ./node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port "$port" >"$log" 2>&1 &
  qa_pid=$!
  for ((i=0; i<200; i++)); do
    if curl -fsS "http://127.0.0.1:$port/" >/dev/null 2>&1; then return; fi
    if ! kill -0 "$qa_pid" 2>/dev/null; then cat "$log" >&2; exit 1; fi
    sleep 0.2
  done
  cat "$log" >&2; exit 1
}

start_server local "$qa_port" "$qa_dir/comex.sqlite" "$qa_dir/server.log"
env -u DATABASE_URL -u VERCEL -u OP_SERVICE_ACCOUNT_TOKEN -u BLOB_READ_WRITE_TOKEN -u OPENAI_API_KEY -u RESEND_API_KEY -u NODE_OPTIONS \
  COMEX_E2E_MODE=local COMEX_E2E_FAKE_PROVIDER=1 COMEX_E2E_MAILBOX="$qa_dir/mailbox" COMEX_E2E_BUDGET_DB="$qa_dir/budget.sqlite" COMEX_DB_PATH="$qa_dir/comex.sqlite" COMEX_TEST_URL="http://127.0.0.1:$qa_port" \
  COMEX_EXPECTED_CANONICAL="http://127.0.0.1:$qa_port/" \
  bun run test:e2e --workers=1 --reporter=line "$@"
stop_server

# These tests mock hosted APIs; they need the hosted page mode but no live backend.
start_server hosted "$qa_hosted_port" "$qa_dir/hosted.sqlite" "$qa_dir/hosted-server.log"
env -u DATABASE_URL -u VERCEL -u OP_SERVICE_ACCOUNT_TOKEN -u BLOB_READ_WRITE_TOKEN -u OPENAI_API_KEY -u RESEND_API_KEY -u NODE_OPTIONS \
  COMEX_E2E_MODE=hosted COMEX_TEST_URL="http://127.0.0.1:$qa_hosted_port" \
  bun run test:e2e e2e/hosted-operations.spec.ts e2e/editor-shared-state.spec.ts --workers=1 --reporter=line
