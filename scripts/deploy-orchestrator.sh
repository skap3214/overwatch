#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

"$ROOT/scripts/predeploy.sh"

cd "$ROOT/pipecat"
exec pcc deploy --yes --force
