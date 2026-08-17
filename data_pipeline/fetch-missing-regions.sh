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
# Overpass is rate-limited and regularly times out under load - that is what
# stopped portsmouth last time. Failures are reported per region and do not
# stop the rest; re-run the script for whichever regions failed.

set -u -o pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REGION_DATA="${REPO_ROOT}/data_pipeline/region-data.py"
INPUT_DIR="${REPO_ROOT}/data_pipeline/input"

ALL_REGIONS=(athens portsmouth adelaide nairobi)
REGIONS=("${@:-}")
if [ -z "${REGIONS[0]:-}" ]; then
  REGIONS=("${ALL_REGIONS[@]}")
fi

echo "Repo:   ${REPO_ROOT}"
echo "Input:  ${INPUT_DIR}"
echo "Region: ${REGIONS[*]}"
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
            name="Dimos Athinaion" and wikidata=Q1224979), which is why the
            previous routing fetch returned zero elements. Fixed in
            regions.json; this run is the first real test of it.
------------------------------------------------------------------------
NOTE
echo

failed=()
for region in "${REGIONS[@]}"; do
  echo "==> ${region}: fetching routing + boundary extracts"
  if "${REGION_DATA}" fetch --only "${region}"; then
    echo "==> ${region}: OK"
  else
    echo "==> ${region}: FAILED (see ${INPUT_DIR}/${region}-*.failed-* for the response)" >&2
    failed+=("${region}")
  fi
  echo
done

if [ "${#failed[@]}" -gt 0 ]; then
  echo "Failed regions: ${failed[*]}" >&2
  echo "Overpass timeouts are usually transient - just re-run those." >&2
  exit 1
fi

echo "All requested regions fetched into ${INPUT_DIR}"
