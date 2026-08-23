#!/usr/bin/env bash
#
# Fetch raw OSM data for the four regions that are configured in regions.json
# but have never been built: athens, portsmouth, adelaide, nairobi.
#
# Downloads only. Nothing here builds artifacts or touches the deployed
# locations manifest, so it is safe to re-run: each region's fetch overwrites
# its own inputs under data_pipeline/input/ and nothing else.
#
# Usage:
#   ./data_pipeline/fetch-missing-regions.sh              # all four
#   ./data_pipeline/fetch-missing-regions.sh athens       # just one or more
#
# Overpass allows only 2 concurrent slots per IP and sheds load aggressively.
# See "Overpass etiquette" in docs/agentic-coding-guidelines.md - this script
# paces itself and retries transient refusals rather than treating them as
# real failures, because they are the normal case under load, not the
# exception.

set -u -o pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REGION_DATA="${REPO_ROOT}/data_pipeline/region-data.py"
INPUT_DIR="${REPO_ROOT}/data_pipeline/input"

# Overpass publishes the per-IP quota at /api/status. Two slots is the usual
# allowance, so a gap between regions keeps us clear of it even when a
# previous run has just used them.
GAP_SECONDS="${GAP_SECONDS:-45}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-4}"
RETRY_BASE_SECONDS="${RETRY_BASE_SECONDS:-60}"

ALL_REGIONS=(athens portsmouth adelaide nairobi)
REGIONS=("${@:-}")
if [ -z "${REGIONS[0]:-}" ]; then
  REGIONS=("${ALL_REGIONS[@]}")
fi

echo "Repo:    ${REPO_ROOT}"
echo "Input:   ${INPUT_DIR}"
echo "Regions: ${REGIONS[*]}"
echo "Pacing:  ${GAP_SECONDS}s between regions, up to ${MAX_ATTEMPTS} attempts each"
echo

cat <<'NOTE'
------------------------------------------------------------------------
Before you run this, two things worth knowing:

  adelaide  The configured relation (Q1094063, "Adelaide City Council") is
            the CBD only - about 4 x 5 km. That is almost certainly not the
            Adelaide you want, and it would waste the metro-wide GTFS feed.
            There is no single "Greater Adelaide" administrative relation;
            metro Adelaide is split across many councils. Decide the scope
            before building, or accept a CBD-only region.

  athens    The relation selector was wrong until 2026-08-17 (it filtered on
            name="Athens"/Q1524, but rel(1370736) actually carries
            name="Dimos Athinaion" and wikidata=Q1224979), which is why an
            earlier routing fetch returned zero elements. Fixed, and the
            corrected selector has since fetched 73,846 elements.
------------------------------------------------------------------------
NOTE
echo

# Overpass reports "the server is busy" and "you have used your quota" as
# runtime errors in the response *body*, with an ordinary HTTP status. They
# mean "come back shortly", unlike a malformed query or a selector that
# matches nothing, which will fail identically no matter how often we retry.
is_transient_failure() {
  local region="$1"
  local marker
  for marker in "${INPUT_DIR}/${region}"-*.failed-response-body.txt; do
    [ -f "${marker}" ] || continue
    if grep -qiE "rate_limited|Dispatcher_Client::request_read_and_idx::timeout|too busy|quota" "${marker}"; then
      return 0
    fi
  done
  return 1
}

report_overpass_quota() {
  local status
  status="$(curl -fsS --max-time 20 https://overpass-api.de/api/status 2>/dev/null || true)"
  if [ -n "${status}" ]; then
    echo "${status}" | grep -iE "rate limit|slots available|slot available" | sed 's/^/    /'
  fi
}

failed=()
first=1
for region in "${REGIONS[@]}"; do
  if [ "${first}" -eq 0 ]; then
    echo "--- pausing ${GAP_SECONDS}s before the next region (Overpass quota) ---"
    sleep "${GAP_SECONDS}"
    echo
  fi
  first=0

  attempt=1
  while :; do
    echo "==> ${region}: fetching routing + boundary extracts (attempt ${attempt}/${MAX_ATTEMPTS})"
    if "${REGION_DATA}" fetch --only "${region}"; then
      echo "==> ${region}: OK"
      break
    fi

    if [ "${attempt}" -ge "${MAX_ATTEMPTS}" ]; then
      echo "==> ${region}: FAILED after ${attempt} attempts (see ${INPUT_DIR}/${region}-*.failed-*)" >&2
      failed+=("${region}")
      break
    fi

    if is_transient_failure "${region}"; then
      backoff=$(( RETRY_BASE_SECONDS * attempt ))
      echo "==> ${region}: Overpass refused (busy or rate-limited), not a query error."
      report_overpass_quota
      echo "==> ${region}: retrying in ${backoff}s"
      sleep "${backoff}"
      attempt=$(( attempt + 1 ))
      continue
    fi

    # Anything else - a malformed query, a selector matching nothing, a
    # network error - will fail the same way next time. Stop rather than
    # spend the quota re-asking a question that has already been answered.
    echo "==> ${region}: FAILED with a non-transient error; not retrying." >&2
    echo "    See ${INPUT_DIR}/${region}-*.failed-response-body.txt" >&2
    failed+=("${region}")
    break
  done
  echo
done

if [ "${#failed[@]}" -gt 0 ]; then
  echo "Failed regions: ${failed[*]}" >&2
  exit 1
fi

echo "All requested regions fetched into ${INPUT_DIR}"
