#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF' >&2
Usage:
  overpass_boundary_query.sh \
    --location-label "<human readable place>" \
    --location-relation '<Overpass relation selector>' \
    --subdivision-admin-level '<osm admin_level integer>' \
    --subdivision-discovery-modes 'area,subarea'

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
subdivision_discovery_modes="area,subarea"

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
    --subdivision-discovery-modes)
      [[ $# -ge 2 ]] || usage
      subdivision_discovery_modes="$2"
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
[[ -n "${subdivision_discovery_modes}" ]] || usage

use_area=0
use_subarea=0
IFS=',' read -r -a discovery_mode_items <<< "${subdivision_discovery_modes}"
for raw_mode in "${discovery_mode_items[@]}"; do
  mode="${raw_mode//[[:space:]]/}"
  case "${mode}" in
    area)
      use_area=1
      ;;
    subarea)
      use_subarea=1
      ;;
    "")
      ;;
    *)
      printf 'Unsupported subdivision discovery mode: %s\n' "${mode}" >&2
      exit 1
      ;;
  esac
done

if [[ "${use_area}" -eq 0 && "${use_subarea}" -eq 0 ]]; then
  printf 'At least one subdivision discovery mode is required\n' >&2
  exit 1
fi

place_area_line=""
if [[ "${use_area}" -eq 1 ]]; then
  place_area_line='.placeRel map_to_area->.placeArea;'
fi

subdivision_query_branches=""
if [[ "${use_area}" -eq 1 ]]; then
  subdivision_query_branches+='  rel(area.placeArea)
    ["boundary"="administrative"]
    ["admin_level"="'${subdivision_admin_level}'"];
'
fi
if [[ "${use_subarea}" -eq 1 ]]; then
  subdivision_query_branches+='  rel(r.placeRel:"subarea")
    ["boundary"="administrative"]
    ["admin_level"="'${subdivision_admin_level}'"];
'
fi

cat <<EOF
[out:json][timeout:600];

/*
${location_label} subdivision boundaries

This query is location-agnostic. It renders administrative subdivision boundaries
for the relation selector and admin level you pass in.

Output: JSON with relation members, way node refs, and referenced node coordinates.
The build step reconstructs boundary polylines from those refs, which is smaller
and more robust across regions than relying on inline way geometry.

Subdivision discovery modes: ${subdivision_discovery_modes}
*/

${location_relation}->.placeRel;
${place_area_line}

(
${subdivision_query_branches}
)->.subdivisions;

(
  .placeRel;
  .subdivisions;
)->.exportRelations;

(.exportRelations;>;);
out body qt;
>;
out skel qt;
EOF
