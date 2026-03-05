/*
Berlin routing-focused OSM extraction (no polygons)

Includes:
- all highway ways/relations (roads, footpaths, cycleways, etc.)
- full way/relation tags for routing (maxspeed, access, foot, vehicle, oneway, sidewalk, etc.)
- connector nodes for graph stitching/penalties: barrier, crossings, level crossings, entrances
- ferry transit routes and ferry stop/terminal nodes (for later transit integration)

Output: JSON with geometry and full tags.
*/

[out:json][timeout:300];

/* Deterministic Berlin selector: relation 62422 (Berlin, Germany / Q64) */
rel(62422)["name"="Berlin"]["wikidata"="Q64"]->.berlinRel;
map_to_area .berlinRel->.searchArea;

(
  /* Core transport geometry */
  way(area.searchArea)["highway"];
  relation(area.searchArea)["highway"];

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

/* Return full tags + geometry; qt for faster server-side ordering */
out geom qt;
