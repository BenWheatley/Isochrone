/*
Berlin routing-focused OSM extraction

Includes:
- all highway ways/relations (roads, footpaths, cycleways, etc.)
- routing constraints on ways: access/foot/oneway/oneway:foot/sidewalk
- connector nodes for graph stitching/penalties: barrier, crossings, entrances
- walkable public-space polygons (parks/green areas), with access filters

Output: JSON with geometry for ways/relations and node positions.
*/

[out:json][timeout:300];
area["name"="Berlin"]["boundary"="administrative"]["admin_level"="4"]->.searchArea;

(
  /* 1) Core transport geometry */
  way(area.searchArea)["highway"];
  relation(area.searchArea)["highway"];

  /* 2) Connector nodes used by pedestrian routing logic */
  node(area.searchArea)["barrier"];
  node(area.searchArea)["highway"="crossing"];
  node(area.searchArea)["railway"="level_crossing"];
  node(area.searchArea)["entrance"];

  /* 3) Public, potentially walkable polygons (ways + multipolygons) */
  way(area.searchArea)
    ["area"!="no"]["access"!="private"]["foot"!="no"]
    ["leisure"~"^(park|garden|playground|common|recreation_ground)$"];
  relation(area.searchArea)
    ["type"="multipolygon"]["access"!="private"]["foot"!="no"]
    ["leisure"~"^(park|garden|playground|common|recreation_ground)$"];

  way(area.searchArea)
    ["area"!="no"]["access"!="private"]["foot"!="no"]
    ["landuse"~"^(recreation_ground|village_green|grass)$"];
  relation(area.searchArea)
    ["type"="multipolygon"]["access"!="private"]["foot"!="no"]
    ["landuse"~"^(recreation_ground|village_green|grass)$"];

  way(area.searchArea)
    ["area"!="no"]["access"!="private"]["foot"!="no"]
    ["natural"~"^(wood|heath|scrub)$"];
  relation(area.searchArea)
    ["type"="multipolygon"]["access"!="private"]["foot"!="no"]
    ["natural"~"^(wood|heath|scrub)$"];
);

/* Return full tags + geometry; qt for faster server-side ordering */
out geom qt;
