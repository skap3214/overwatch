#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "== protocol:check =="
npm run protocol:check

echo "== daemon:build =="
npm run daemon:build

echo "== npm test =="
npm test

echo "== ruff =="
(cd pipecat && uv run ruff check .)

echo "== pytest =="
(cd pipecat && uv run pytest -q)

echo "redeploy-ready"
