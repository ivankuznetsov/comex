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
qa_pid=''
cleanup() {
  if [[ -n $qa_pid ]]; then kill "$qa_pid" 2>/dev/null || true; wait "$qa_pid" 2>/dev/null || true; fi
  echo "E2E files and server log retained at $qa_dir"
}
trap cleanup EXIT
env -u OP_SERVICE_ACCOUNT_TOKEN -u VERCEL COMEX_E2E_FAKE_PROVIDER=1 OPENAI_API_KEY=e2e-fake-key COMEX_DB_PATH="$qa_dir/comex.sqlite" \
  COMEX_BUDGET_DB_PATH="$qa_dir/budget.sqlite" COMEX_ASSET_PATH="$qa_dir/assets" COMEX_MAX_PROVIDER_CALLS=200 \
  COMEX_MAX_CONCURRENT_CALLS=1 \
  NODE_OPTIONS="--require=$PWD/e2e/fake-provider.cjs" \
  bun run dev --hostname 127.0.0.1 --port "$qa_port" >"$qa_dir/server.log" 2>&1 &
qa_pid=$!
for ((i=0; i<100; i++)); do
  if curl -fsS "http://127.0.0.1:$qa_port/" >/dev/null 2>&1; then break; fi
  if ! kill -0 "$qa_pid" 2>/dev/null; then cat "$qa_dir/server.log" >&2; exit 1; fi
  sleep 0.2
done
curl -fsS "http://127.0.0.1:$qa_port/" >/dev/null
COMEX_E2E_FAKE_PROVIDER=1 COMEX_TEST_URL="http://127.0.0.1:$qa_port" \
  bun run test:e2e e2e/full-flow.spec.ts --reporter=line
