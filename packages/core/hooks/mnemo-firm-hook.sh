#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/../../.." && pwd)"
ENV_FILE="${MNEMO_HOOK_ENV_FILE:-$REPO_ROOT/.mnemo-hook.env}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

if [[ -z "${MNEMO_PROJECT_ALIASES_FILE:-}" && -f "$REPO_ROOT/.mnemo-project-aliases.json" ]]; then
  export MNEMO_PROJECT_ALIASES_FILE="$REPO_ROOT/.mnemo-project-aliases.json"
fi

exec node "$SCRIPT_DIR/firm-runtime-hook.js" "$@"
