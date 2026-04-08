#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF' >&2
Usage:
  overpass_boundary_query.sh \
    --location-label "<human readable place>" \
    --location-relation '<Overpass relation selector>' \
    --subdivision-admin-level '<osm admin_level integer>'

Example:
  overpass_boundary_query.sh \
    --location-label "Berlin" \
    --location-relation 'rel(62422)["name"="Berlin"]["wikidata"="Q64"]' \
    --subdivision-admin-level 9
EOF
  exit 1
}

location_label=""
location_relation=""
subdivision_admin_level=""

while (($# > 0)); do
  case "$1" in
    --location-label)
      [[ $# -ge 2 ]] || usage
      location_label="$2"
      shift 2
      ;;
    --location-relation)
      [[ $# -ge 2 ]] || usage
      location_relation="$2"
      shift 2
      ;;
    --subdivision-admin-level)
      [[ $# -ge 2 ]] || usage
      subdivision_admin_level="$2"
      shift 2
      ;;
    *)
      usage
      ;;
  esac
done

[[ -n "${location_label}" ]] || usage
[[ -n "${location_relation}" ]] || usage
[[ -n "${subdivision_admin_level}" ]] || usage

cat <<EOF
[out:json][timeout:600];

/*
${location_label} subdivision boundaries

This query is location-agnostic. It renders administrative subdivision boundaries
for the relation selector and admin level you pass in.

Output: JSON with relation members, way node refs, and referenced node coordinates.
The build step reconstructs boundary polylines from those refs, which is smaller
and more robust across regions than relying on inline way geometry.
*/

${location_relation}->.placeRel;
.placeRel map_to_area->.placeArea;

rel(area.placeArea)
  ["boundary"="administrative"]
  ["type"="boundary"]
  ["admin_level"="${subdivision_admin_level}"]->.subdivisions;

(.subdivisions;>;);
out body qt;
>;
out skel qt;
EOF
