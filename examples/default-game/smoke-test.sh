#!/usr/bin/env bash
# smoke-test.sh — start `relay serve` on this folder and curl the canonical
# Nuna endpoints. Exits non-zero on any failure. Suitable for CI and local
# pre-commit checks.
#
# Requires: relay (npm i -g @nuna/relay), curl, jq.

set -euo pipefail

PORT="${PORT:-3001}"
HOST="${HOST:-127.0.0.1}"
BASE="http://${HOST}:${PORT}"
HERE="$(cd "$(dirname "$0")" && pwd)"

cleanup() {
  if [[ -n "${RELAY_PID:-}" ]] && kill -0 "$RELAY_PID" 2>/dev/null; then
    kill "$RELAY_PID" 2>/dev/null || true
    wait "$RELAY_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

cd "$HERE"

echo ">> starting relay serve on ${BASE}"
relay serve --host "$HOST" --port "$PORT" >/tmp/relay.log 2>&1 &
RELAY_PID=$!

for _ in $(seq 1 40); do
  if curl -sf "${BASE}/health" >/dev/null; then break; fi
  sleep 0.25
done

if ! curl -sf "${BASE}/health" >/dev/null; then
  echo "!! relay never became healthy"
  cat /tmp/relay.log
  exit 1
fi

echo ">> /health"
curl -fsS "${BASE}/health"
echo

echo ">> /discover.json"
curl -fsS "${BASE}/discover.json" | tee /tmp/discover.json
echo

echo ">> /games/default/v-dev/manifest.json"
curl -fsS "${BASE}/games/default/v-dev/manifest.json" \
  | jq -e '.version == 1 and (.files | length) > 0' >/dev/null

echo ">> /games/default/v-dev/runtime.xml"
curl -fsS "${BASE}/games/default/v-dev/runtime.xml" | head -1 | grep -q '<?xml'

echo "OK"