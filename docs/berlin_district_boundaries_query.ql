[out:json][timeout:600];

/*
Deterministic Berlin selector:
- Berlin administrative relation id = 62422
- Bezirke (districts) are admin_level=9 relations inside Berlin
*/

rel(62422)->.berlin;
.berlin map_to_area->.berlinArea;

rel(area.berlinArea)
  ["boundary"="administrative"]
  ["type"="boundary"]
  ["admin_level"="9"]->.districts;

(.districts;>;);
out body geom qt;
