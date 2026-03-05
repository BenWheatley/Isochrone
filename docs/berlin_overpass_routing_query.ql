/*
Berlin routing-focused OSM extraction (no polygons)

Includes:
- all highway ways (roads, footpaths, cycleways, etc.)
- full way tags for routing (maxspeed, access, foot, vehicle, oneway, sidewalk, etc.)
- connector nodes for graph stitching/penalties: barrier, crossings, level crossings, entrances
- ferry transit routes and ferry stop/terminal nodes (for later transit integration)

Output: JSON with tags + node references + referenced node coordinates (no duplicated inline geometry).
*/

[out:json][timeout:300];

/* Deterministic Berlin selector: relation 62422 (Berlin, Germany / Q64) */
rel(62422)["name"="Berlin"]["wikidata"="Q64"]->.berlinRel;
.berlinRel map_to_area->.searchArea;

(
  /* Core transport geometry */
  way(area.searchArea)["highway"];

  /* Connector nodes used by pedestrian routing logic */
  node(area.searchArea)["barrier"];
  node(area.searchArea)["highway"="crossing"];
  node(area.searchArea)["railway"="level_crossing"];
  node(area.searchArea)["entrance"];

  /* Water public transport (do not treat as walkable edges) */
  way(area.searchArea)["route"="ferry"];
  relation(area.searchArea)["type"="route"]["route"="ferry"];
  node(area.searchArea)["amenity"="ferry_terminal"];
  node(area.searchArea)["public_transport"="stop_position"]["ferry"="yes"];
  node(area.searchArea)["public_transport"="platform"]["ferry"="yes"];
);

/* Download-friendly output:
   1) body: tags + way node refs
   2) recurse: fetch all referenced members (especially nodes)
   3) skel: output node coordinates once, without tag duplication
*/
out body qt;
>;
out skel qt;
