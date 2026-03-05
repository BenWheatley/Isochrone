#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

QUERY_FILE="${REPO_ROOT}/docs/berlin_overpass_routing_query.ql"
OUTPUT_FILE="${REPO_ROOT}/data_pipeline/input/berlin-routing.osm.json"
OVERPASS_URL="${OVERPASS_URL:-https://overpass-api.de/api/interpreter}"
MAX_TIME_SECONDS="${MAX_TIME_SECONDS:-600}"

if [[ ! -f "${QUERY_FILE}" ]]; then
  echo "Query file not found: ${QUERY_FILE}" >&2
  exit 1
fi

mkdir -p "$(dirname "${OUTPUT_FILE}")"

curl --show-error --fail --max-time "${MAX_TIME_SECONDS}" \
  --data-urlencode "data@${QUERY_FILE}" \
  "${OVERPASS_URL}" \
  -o "${OUTPUT_FILE}"

echo "Wrote ${OUTPUT_FILE}"
