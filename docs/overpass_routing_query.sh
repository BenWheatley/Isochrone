#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF' >&2
Usage:
  overpass_routing_query.sh \
    --location-label "<human readable place>" \
    --location-relation '<Overpass relation selector>' \
    [--scope 'area|bbox'] \
    [--bbox 'south,west,north,east']

Example:
  overpass_routing_query.sh \
    --location-label "Berlin" \
    --location-relation 'rel(62422)["name"="Berlin"]["wikidata"="Q64"]'
EOF
  exit 1
}

location_label=""
location_relation=""
routing_scope="area"
bbox_clause=""

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
    --scope)
      [[ $# -ge 2 ]] || usage
      routing_scope="$2"
      shift 2
      ;;
    --bbox)
      [[ $# -ge 2 ]] || usage
      bbox_clause="($2)"
      shift 2
      ;;
    *)
      usage
      ;;
  esac
done

[[ -n "${location_label}" ]] || usage
[[ -n "${location_relation}" ]] || usage

case "${routing_scope}" in
  area|bbox)
    ;;
  *)
    usage
    ;;
esac

if [[ "${routing_scope}" == "bbox" && -z "${bbox_clause}" ]]; then
  usage
fi

selector_preamble=""
way_selector="way(area.searchArea)${bbox_clause}"
node_selector="node(area.searchArea)${bbox_clause}"
relation_selector="relation(area.searchArea)${bbox_clause}"
if [[ "${routing_scope}" == "area" ]]; then
  selector_preamble=$(cat <<EOF
/* Deterministic place selector */
${location_relation}->.placeRel;
.placeRel map_to_area->.searchArea;
EOF
)
else
  way_selector="way${bbox_clause}"
  node_selector="node${bbox_clause}"
  relation_selector="relation${bbox_clause}"
fi

cat <<EOF
/*
${location_label} routing-focused OSM extraction (no polygons)

This query is location-agnostic. It renders a routing extract for the relation
selector you pass in, optionally constrained to a bbox tile for large regions.

Includes:
- all highway ways (roads, footpaths, cycleways, etc.)
- full way tags for routing (maxspeed, access, foot, vehicle, oneway, sidewalk, etc.)
- connector nodes for graph stitching/penalties: barrier, crossings, level crossings, entrances
- ferry transit routes and ferry stop/terminal nodes (for later transit integration)

Output: JSON with tags + node references + referenced node coordinates (no duplicated inline geometry).
*/

[out:json][timeout:300];

${selector_preamble}

(
  /* Core transport geometry */
  ${way_selector}["highway"];

  /* Connector nodes used by pedestrian routing logic */
  ${node_selector}["barrier"];
  ${node_selector}["highway"="crossing"];
  ${node_selector}["railway"="level_crossing"];
  ${node_selector}["entrance"];

  /* Water public transport (do not treat as walkable edges) */
  ${way_selector}["route"="ferry"];
  ${relation_selector}["type"="route"]["route"="ferry"];
  ${node_selector}["amenity"="ferry_terminal"];
  ${node_selector}["public_transport"="stop_position"]["ferry"="yes"];
  ${node_selector}["public_transport"="platform"]["ferry"="yes"];
);

/* Download-friendly output:
   1) body: tags + way node refs
   2) recurse: fetch all referenced members (especially nodes)
   3) skel: output node coordinates once, without tag duplication
*/
out body qt;
>;
out skel qt;
EOF
