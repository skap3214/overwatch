#!/usr/bin/env bash
# AUTO-GENERATED PROTOCOL TYPES — PYTHON GENERATOR
#
# Reads /protocol/schema/*.schema.json and emits pydantic v2 models at
# pipecat/overwatch_pipeline/protocol/generated/.
#
# Requires `datamodel-code-generator` on PATH. Install via:
#   uv tool install datamodel-code-generator
#
# Run via: npm run protocol:gen:py

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCHEMA_DIR="$REPO_ROOT/protocol/schema"
OUT_DIR="$REPO_ROOT/pipecat/overwatch_pipeline/protocol/generated"

if ! command -v datamodel-codegen >/dev/null 2>&1; then
  echo "error: datamodel-codegen not found on PATH" >&2
  echo "install with: uv tool install datamodel-code-generator" >&2
  exit 1
fi

# Clean and recreate the output directory so removed schemas leave no stale files.
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

datamodel-codegen \
  --input "$SCHEMA_DIR" \
  --input-file-type jsonschema \
  --output "$OUT_DIR" \
  --output-model-type pydantic_v2.BaseModel \
  --use-standard-collections \
  --use-union-operator \
  --use-schema-description \
  --target-python-version 3.12 \
  --use-double-quotes \
  --formatters black isort

# Ensure the generated package is importable.
INIT="$OUT_DIR/__init__.py"
if [ ! -f "$INIT" ]; then
  touch "$INIT"
fi

echo "Wrote $OUT_DIR"
