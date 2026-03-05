/*
Berlin routing-focused OSM extraction (no polygons)

Includes:
- all highway ways/relations (roads, footpaths, cycleways, etc.)
- full way/relation tags for routing (maxspeed, access, foot, vehicle, oneway, sidewalk, etc.)
- connector nodes for graph stitching/penalties: barrier, crossings, level crossings, entrances

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
);

/* Return full tags + geometry; qt for faster server-side ordering */
out geom qt;
