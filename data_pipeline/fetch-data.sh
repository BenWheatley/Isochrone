#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-${REPO_ROOT}/.venv/bin/python}"
if [[ ! -x "${PYTHON_BIN}" ]]; then
  PYTHON_BIN="${PYTHON:-python3}"
fi

args=(fetch)
if [[ -n "${INPUT_DIR:-}" ]]; then
  args+=(--input-dir "${INPUT_DIR}")
fi
if [[ -n "${OVERPASS_URL:-}" ]]; then
  args+=(--overpass-url "${OVERPASS_URL}")
fi
if [[ -n "${MAX_TIME_SECONDS:-}" ]]; then
  args+=(--max-time-seconds "${MAX_TIME_SECONDS}")
fi

exec "${PYTHON_BIN}" "${REPO_ROOT}/data_pipeline/region-data.py" "${args[@]}" "$@"
