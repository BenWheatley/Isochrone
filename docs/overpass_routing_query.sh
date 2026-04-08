#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF' >&2
Usage:
  overpass_routing_query.sh \
    --location-label "<human readable place>" \
    --location-relation '<Overpass relation selector>' \
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

/* Deterministic place selector */
${location_relation}->.placeRel;
.placeRel map_to_area->.searchArea;

(
  /* Core transport geometry */
  way(area.searchArea)${bbox_clause}["highway"];

  /* Connector nodes used by pedestrian routing logic */
  node(area.searchArea)${bbox_clause}["barrier"];
  node(area.searchArea)${bbox_clause}["highway"="crossing"];
  node(area.searchArea)${bbox_clause}["railway"="level_crossing"];
  node(area.searchArea)${bbox_clause}["entrance"];

  /* Water public transport (do not treat as walkable edges) */
  way(area.searchArea)${bbox_clause}["route"="ferry"];
  relation(area.searchArea)${bbox_clause}["type"="route"]["route"="ferry"];
  node(area.searchArea)${bbox_clause}["amenity"="ferry_terminal"];
  node(area.searchArea)${bbox_clause}["public_transport"="stop_position"]["ferry"="yes"];
  node(area.searchArea)${bbox_clause}["public_transport"="platform"]["ferry"="yes"];
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
