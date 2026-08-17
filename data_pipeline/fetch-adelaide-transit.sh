#!/usr/bin/env bash
#
# Fetch the Adelaide Metro static GTFS feed.
#
# LICENCE (confirmed against the publisher on 2026-08-17, not assumed):
#   data.sa.gov.au's CKAN API reports, for dataset "Adelaide Metro General
#   Transit Feed" (id https-gtfs-adelaidemetro-com-au):
#       license_id    = cc-by
#       license_title = Creative Commons Attribution
#       license_url   = http://creativecommons.org/licenses/by/4.0
#       organization  = Department for Infrastructure and Transport
#   So: CC BY 4.0, same family as Berlin's VBB feed, and the existing
#   attribution machinery takes it without change.
#
#   Attribution to carry in the UI and exports:
#       Public transit data (c) Adelaide Metro - Department for
#       Infrastructure and Transport, South Australia, available under the
#       Creative Commons Attribution 4.0 licence (CC BY 4.0)
#
#   Re-confirm before shipping if significant time has passed:
#     curl -s "https://data.sa.gov.au/data/api/3/action/package_show?id=https-gtfs-adelaidemetro-com-au" \
#       | python3 -c 'import json,sys; r=json.load(sys.stdin)["result"]; print(r["license_id"], r["license_url"])'
#
# FEED URL: taken from Adelaide Metro's own OpenAPI spec
# (https://gtfs.adelaidemetro.com.au/gtfsr-feed-v1-swagger-apigateway.yaml,
# host gtfs.adelaidemetro.com.au, basePath /v1), which documents
# /static/latest/google_transit.zip. Verified live on 2026-08-17: HTTP 200,
# 19,286,189 bytes, Last-Modified Fri 14 Aug 2026. Guessed paths such as
# /v1/static/latest.zip return 403, so use the documented one.
#
# Usage: ./data_pipeline/fetch-adelaide-transit.sh

set -eu -o pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INPUT_DIR="${REPO_ROOT}/data_pipeline/input"
# Matches RegionSpec.transit_input_dir_name: "<id>-transit-gtfs".
TRANSIT_DIR="${INPUT_DIR}/adelaide-transit-gtfs"
ZIP_PATH="${INPUT_DIR}/adelaide-transit-gtfs.zip"

FEED_URL="https://gtfs.adelaidemetro.com.au/v1/static/latest/google_transit.zip"
VERSION_URL="https://gtfs.adelaidemetro.com.au/v1/static/latest/version.txt"

# The build reads these as <name>.txt - see GTFS_TRANSIT_FILE_NAMES in
# region_pipeline.py. transfers.txt is optional in GTFS and some feeds omit it.
REQUIRED_FILES=(agency calendar calendar_dates routes stops trips stop_times)
OPTIONAL_FILES=(transfers)

mkdir -p "${INPUT_DIR}"

echo "Feed version: $(curl -fsSL --max-time 60 "${VERSION_URL}" || echo '(unavailable)')"
echo "Downloading ${FEED_URL}"
echo "         -> ${ZIP_PATH}"
curl -fSL --max-time 900 "${FEED_URL}" -o "${ZIP_PATH}"

echo
echo "Extracting into ${TRANSIT_DIR}"
rm -rf "${TRANSIT_DIR}"
mkdir -p "${TRANSIT_DIR}"
unzip -o -q "${ZIP_PATH}" -d "${TRANSIT_DIR}"

# Adelaide ships one .zip; the Berlin mirror serves loose .csv files, which is
# all the pipeline's own transit fetcher knows how to do (it downloads
# {base_url}/{name}.csv). Hence this standalone script rather than a
# regions.json transitFeed entry - wiring Adelaide in properly needs
# fetch_gtfs_transit_files to learn about zip feeds first.
echo
missing=()
for name in "${REQUIRED_FILES[@]}"; do
  if [ -f "${TRANSIT_DIR}/${name}.txt" ]; then
    printf '  %-16s %s bytes\n' "${name}.txt" "$(wc -c < "${TRANSIT_DIR}/${name}.txt" | tr -d ' ')"
  else
    missing+=("${name}.txt")
  fi
done
for name in "${OPTIONAL_FILES[@]}"; do
  if [ -f "${TRANSIT_DIR}/${name}.txt" ]; then
    printf '  %-16s %s bytes (optional)\n' "${name}.txt" "$(wc -c < "${TRANSIT_DIR}/${name}.txt" | tr -d ' ')"
  else
    printf '  %-16s absent (optional)\n' "${name}.txt"
  fi
done

if [ "${#missing[@]}" -gt 0 ]; then
  echo
  echo "ERROR: feed is missing required files: ${missing[*]}" >&2
  echo "Contents of the zip:" >&2
  ls -1 "${TRANSIT_DIR}" >&2
  exit 1
fi

echo
echo "Done. GTFS in ${TRANSIT_DIR}"
echo
echo "NOT yet wired into the build. To use it, adelaide needs a transitFeed"
echo "entry in regions.json AND fetch_gtfs_transit_files taught to handle a"
echo "zip feed - see the comment above. Until then this is just the data on"
echo "disk, ready to inspect."
