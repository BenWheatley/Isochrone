# PLAN.md — Berlin Isochrone Web App (Revised)

**Goal:** A client-side web app that computes walking isochrones for Berlin using a preprocessed OpenStreetMap walking graph. All data loads as a compact binary graph. Rendering uses a 10 m/pixel raster painted onto an HTML canvas, overlaid on tiled OpenStreetMap basemap tiles.

Transit (GTFS/CSA) support is fully architected and stubbed, but real schedule data is deferred to post-MVP phases. The system is designed to accept any GTFS feed for any region, not just Berlin or Germany.

The coordinate projection used throughout is **UTM zone 33N (EPSG:25833)**. This projection is conformal and preserves local angles; for Berlin's latitude (~52.5 °N), the scale factor at the central meridian is 0.9996, meaning 1 projected meter = 1.0004 m of true surface travel — an error well under 0.1 % across the city. Crucially, the scale distortion is symmetric in both axes within the city extent, so N pixels horizontally ≈ N×10 m of surface travel, and likewise vertically, with sub-pixel error across the entire Berlin bounding box. For any future region whose extent crosses a UTM zone boundary, the pipeline script will accept a user-specified EPSG code; the projection maths are isolated to a single module.

Estimates assume a **junior developer familiar with JavaScript and basic GIS concepts**.

---

# Phase 1 — Project Setup

## 1.1 Create repository structure
Estimated time: 30 min

Tasks
- [x] Create repository
- [x] Create folders: `/data_pipeline`, `/web`, `/docs`
- [x] Add placeholder files: `PLAN.md`, `README.md`

---

## 1.2 Create Python development environment
Estimated time: 45 min

Tasks
- [x] Install Python 3.11+
- [x] Create virtual environment (`python -m venv .venv`)
- [x] Install and pin: `requests`, `pyproj`, `numpy`, `struct` (stdlib)
- [x] Write `requirements.txt`

---

## 1.3 Configure JavaScript bundler
Estimated time: 45 min

**Decision:** Use **esbuild**. It is a single binary with no configuration file required for basic usage, bundles ES modules, outputs a single minified file, and runs in under 100 ms on this codebase. No webpack, no Rollup, no Vite — esbuild is the minimal-complexity choice.

### 1.3.1 Install esbuild
Estimated time: 15 min

Tasks
- [x] `npm init -y` in `/web`
- [x] `npm install --save-dev esbuild`
- [x] Confirm `npx esbuild --version`

### 1.3.2 Write build script
Estimated time: 15 min

Tasks
- [x] Add `build` script to `package.json`: `esbuild src/app.js --bundle --minify --outfile=dist/app.js`
- [x] Add `dev` script with `--watch` flag and `--sourcemap`

### 1.3.3 Create source layout
Estimated time: 15 min

Tasks
- [x] Create `/web/src/` for ES module source files
- [x] Create `/web/dist/` as build output (git-ignored in dev, committed for Pages deploy)
- [x] Create stub `src/app.js` with a single `console.log`

---

# Phase 2 — Data Exploration and Schema Design

*Schema is designed after data is understood, not before.*

## 2.1 Explore OSM data for Berlin
Estimated time: 45 min

### 2.1.1 Fetch Berlin OSM extract via Overpass
Estimated time: 15 min

Tasks
- [x] Use `docs/berlin_overpass_routing_query.ql` with `data_pipeline/fetch-data.sh`
- [x] Store output as `/data_pipeline/input/berlin-routing.osm.json`

### 2.1.2 Survey walkable way tags
Estimated time: 30 min

Tasks
- [x] Write a short script to count `highway=*` values present in the Overpass JSON extract
- [x] Record which values are usable for pedestrian routing
- [x] Note typical node density per km of way

---

## 2.2 Design binary graph schema
Estimated time: 45 min

*Informed by exploration above.*

### File layout

```
[ Header: 64 bytes ]
[ Node table: N_nodes × 16 bytes ]
[ Edge table: N_edges × 12 bytes ]
[ Stop table: N_stops × 24 bytes ]        ← zeroed in MVP; populated post-MVP
[ Transit edge table: N_tedges × 20 bytes ] ← zeroed in MVP; populated post-MVP
```

### Header (64 bytes)

| Offset | Type    | Field             |
|--------|---------|-------------------|
| 0      | uint32  | magic `0x49534F43` ("ISOC") |
| 4      | uint8   | version (=1)      |
| 5      | uint8   | flags (bit 0 = has_transit) |
| 6      | uint16  | reserved          |
| 8      | uint32  | N_nodes           |
| 12     | uint32  | N_edges           |
| 16     | uint32  | N_stops           |
| 20     | uint32  | N_tedges          |
| 24     | float64 | origin_easting (m, UTM) |
| 32     | float64 | origin_northing (m, UTM) |
| 40     | uint16  | epsg_code (e.g. 25833) |
| 42     | uint16  | grid_width_px     |
| 44     | uint16  | grid_height_px    |
| 46     | uint16  | reserved          |
| 48     | float32 | pixel_size_m (= 10.0) |
| 52     | uint32  | node_table_offset |
| 56     | uint32  | edge_table_offset |
| 60     | uint32  | stop_table_offset |
| (ext)  | uint32  | tedge_table_offset (at byte 60 in v1 header extension) |

*64 bytes total (padded to 64 for alignment).*

### Node record (16 bytes)

| Offset | Type   | Field |
|--------|--------|-------|
| 0      | int32  | x_m (easting offset from origin, metres, signed) |
| 4      | int32  | y_m (northing offset from origin, metres, signed) |
| 8      | uint32 | first_edge_index (index into edge table) |
| 12     | uint16 | edge_count |
| 14     | uint16 | flags (bit 0 = is_stop_attachment) |

### Edge record (12 bytes)

| Offset | Type   | Field |
|--------|--------|-------|
| 0      | uint32 | target_node_index |
| 4      | uint16 | cost_seconds (walking, uint16 → max ~18 min per edge, sufficient) |
| 6      | uint16 | flags |
| 8      | uint32 | reserved |

### Stop record (24 bytes, post-MVP)

| Offset | Type   | Field |
|--------|--------|-------|
| 0      | int32  | x_m |
| 4      | int32  | y_m |
| 8      | uint32 | nearest_node_index |
| 12     | uint32 | first_tedge_index |
| 16     | uint16 | tedge_count |
| 18     | uint8  | transport_type (0=bus,1=tram,2=subway,3=rail) |
| 19     | uint8  | reserved |
| 20     | uint32 | name_offset (into string table, post-MVP extension) |

### Transit edge record (20 bytes, post-MVP)

| Offset | Type   | Field |
|--------|--------|-------|
| 0      | uint32 | from_stop_index |
| 4      | uint32 | to_stop_index |
| 8      | uint32 | departure_seconds_from_midnight |
| 12     | uint16 | travel_seconds |
| 14     | uint16 | route_id (internal index) |
| 16     | uint32 | service_day_mask (bitmask: bit 0=Mon … bit 6=Sun) |

*Transit edges are sorted by `departure_seconds_from_midnight` to enable CSA (see post-MVP phases).*

---

## 2.3 Implement binary writer utilities
Estimated time: 45 min

### 2.3.1 Write Python binary writer module
Estimated time: 25 min

Tasks
- [x] `BinaryWriter` class wrapping `bytearray`
- [x] Methods: `write_u8`, `write_u16`, `write_u32`, `write_i32`, `write_f32`, `write_f64`
- [x] Method: `pad_to(alignment)` — fills to next multiple of alignment

### 2.3.2 Write reader test script
Estimated time: 20 min

Tasks
- [x] Parse magic, version, counts from header
- [x] Print node 0 and edge 0
- [x] Assert offsets are consistent with header-declared positions

---

# Phase 3 — OSM Walking Graph Extraction

## 3.1 Parse Overpass JSON extract and filter walkable ways
Estimated time: 1 hour

### 3.1.1 Load Overpass JSON and iterate ways
Estimated time: 20 min

Tasks
- Load `/data_pipeline/input/berlin-routing.osm.json`
- Collect all `way` objects with a pedestrian-usable `highway` tag
- Preserve routing constraint tags on each candidate way: `access`, `foot`, `oneway`, `oneway:foot`, `sidewalk`
- Record the set of node IDs referenced by those ways
- Collect connector nodes in a second lightweight pass: `barrier=*`, `highway=crossing`, `railway=level_crossing`, `entrance=*`

### 3.1.2 Load referenced nodes
Estimated time: 20 min

Tasks
- Second pass: collect only `node` elements whose IDs are in the reference set
- Store as dict `{osm_id: (lat, lon)}`

### 3.1.3 Handle missing node references
Estimated time: 20 min

Tasks
- Ways referencing nodes not in the extract (border effects) are silently dropped
- Log count of dropped ways

---

## 3.2 Project coordinates to UTM 33N
Estimated time: 30 min

Tasks
- Use `pyproj.Transformer.from_crs("EPSG:4326", "EPSG:25833")`
- Transform all node (lat, lon) → (easting, northing) in metres
- Compute bounding box; derive `origin_easting`, `origin_northing` as minimum corner
- Compute `grid_width_px = ceil((max_e - min_e) / 10)`, `grid_height_px = ceil((max_n - min_n) / 10)`
- Store per-node as integer `(x_m, y_m)` offsets from origin (i32, max value ~50 000 for Berlin → fits in int32 with large margin)

*For Berlin: bounding box is roughly 45 km × 38 km → grid is ~4 500 × 3 800 px → ~17 megapixels. At 4 bytes/pixel (RGBA), the pixel buffer is ~68 MB — within browser working memory. The canvas element will be this size but only the visible viewport is painted to screen.*

---

## 3.3 Build adjacency list
Estimated time: 1 hour

### 3.3.1 Extract directed edges from ways
Estimated time: 25 min

Tasks
- For each walkable way, iterate consecutive node pairs
- Emit edge (A→B) and (B→A) for each pair (walking is bidirectional by default)
- Exception: `oneway:foot=yes` ways emit only forward edge
- Respect constraints during edge creation: exclude disallowed segments (`access=private/no`, `foot=no`) and keep `sidewalk=*` metadata for later refinements
- Preserve connector-node flags (`crossing`, `level_crossing`, `entrance`, `barrier`) so later routing logic can apply penalties/filters without re-parsing OSM

### 3.3.2 Compute edge walking cost
Estimated time: 20 min

Tasks
- Euclidean distance in projected metres between the two endpoint nodes
- Walking speed: 1.39 m/s (5 km/h); cost = `round(dist_m / 1.39)` seconds
- Cap at uint16 max (65535 s ≈ 18 min); any longer edge is split at midpoint

### 3.3.3 Sort and index adjacency list
Estimated time: 15 min

Tasks
- Sort edges by source node index
- Record `first_edge_index` and `edge_count` per node

---

## 3.4 Graph simplification
Estimated time: 1 hour 30 min

*Simplification reduces node count by ~60–70 %, shrinking the binary graph and speeding up routing.*

### 3.4.1 Tag stop-attachment nodes as non-mergeable
Estimated time: 10 min

Tasks
- Any node within 50 m of a GTFS stop position is flagged `is_stop_attachment`
- These nodes are excluded from merging even if degree-2
- *(Stop positions are not yet loaded in MVP; this flag is set to 0 and the step is a no-op until post-MVP. The code path must exist now so simplification is stop-safe from the start.)*

### 3.4.2 Detect degree-2 nodes eligible for merging
Estimated time: 20 min

Tasks
- Count in-degree and out-degree per node
- A node is a merge candidate if: total degree = 2, not flagged `is_stop_attachment`, not a dead-end

### 3.4.3 Merge linear chains
Estimated time: 30 min

Tasks
- Walk chains of degree-2 nodes; replace with a single edge whose cost is the sum of constituent edge costs
- Accumulate the chain; the merged edge's cost is capped at uint16 max (split chains that would overflow)

### 3.4.4 Reindex nodes and edges
Estimated time: 30 min

Tasks
- Assign new contiguous indices to surviving nodes
- Rebuild adjacency lists with new indices
- Log before/after node and edge counts

---

## 3.5 Validate walking graph
Estimated time: 30 min

Tasks
- Pick 3 known Berlin locations; find nearest nodes; run BFS to confirm reachability
- Assert no edge references an out-of-range node index
- Assert edge costs are all > 0

---

# Phase 4 — Binary Graph Export (MVP: Walking Only)

## 4.1 Assemble and serialise binary graph
Estimated time: 45 min

### 4.1.1 Write header
Estimated time: 15 min

Tasks
- Populate all header fields
- Set `N_stops = 0`, `N_tedges = 0`
- Set `flags` bit 0 = 0 (no transit)

### 4.1.2 Write node and edge tables
Estimated time: 20 min

Tasks
- Iterate nodes in index order; pack each 16-byte record
- Iterate edges in source-node order; pack each 12-byte record

### 4.1.3 Write empty stop and transit tables
Estimated time: 10 min

Tasks
- Write zero bytes for both tables (preserves file format compatibility)

---

## 4.2 Validate binary output
Estimated time: 30 min

Tasks
- Run reader test script from Phase 2.3.2
- Assert magic and version
- Spot-check 5 random nodes: decode coordinates, confirm they fall within Berlin bounding box
- Assert all edge target indices < N_nodes

---

# Phase 5 — Web Client Shell

## 5.1 Create HTML application skeleton
Estimated time: 30 min

Tasks
- `index.html` with: `<canvas id="map">`, time-of-day input (default 08:00), loading overlay `<div id="loading">`
- Link to `dist/app.js`
- No inline JS; no inline styles beyond basic layout

---

## 5.2 Implement OSM tile basemap
Estimated time: 1 hour

*Replaces the static Berlin image. OSM tiles are free to use with attribution (© OpenStreetMap contributors). Tile URL: `https://tile.openstreetmap.org/{z}/{x}/{y}.png`.*

### 5.2.1 Implement tile coordinate maths
Estimated time: 25 min

Tasks
- Given a UTM 33N bounding box, compute the enclosing tile range at zoom 13 (roughly 10 m/pixel native tile resolution — a natural match)
- Functions: `lonLatToTile(lon, lat, z)`, `tileToBBox(x, y, z)` (returns lon/lat bbox)
- Derive pixel offset of each tile's top-left corner relative to canvas origin

### 5.2.2 Fetch and draw tiles
Estimated time: 35 min

Tasks
- On page load, compute required tile set for Berlin bounding box at zoom 13
- Fetch each tile as `Image`; draw onto an offscreen canvas at correct pixel offset
- Show loading progress: "Loading map tiles: N / M" in the loading overlay
- After all tiles drawn, copy offscreen canvas to main canvas background layer

---

## 5.3 Implement binary graph loader
Estimated time: 1 hour

### 5.3.1 Fetch binary file with progress
Estimated time: 25 min

Tasks
- `fetch('berlin_graph.bin')` with `response.body` stream reader
- Track bytes received vs `Content-Length`
- Update loading overlay: "Loading graph: N MB / M MB (X%)"

### 5.3.2 Parse TypedArrays from ArrayBuffer
Estimated time: 35 min

Tasks
- Parse header fields using `DataView`
- Map node table: `Int32Array` view for coordinates, `Uint32Array` for edge indices
- Map edge table: `Uint32Array` for targets, `Uint16Array` for costs
- Verify magic number; throw readable error if wrong
- After parse: hide loading overlay; enable click interaction

---

# Phase 6 — Pixel Grid and Canvas Rendering

*Berlin at 10 m/pixel: ~4 500 × 3 800 px ≈ 17 Mpx. The raster buffer is an `ImageData` object of this size maintained in JS memory and blitted to canvas on each update.*

## 6.1 Allocate and manage pixel grid
Estimated time: 30 min

Tasks
- Allocate `Uint8ClampedArray` of size `grid_width_px × grid_height_px × 4` (RGBA)
- `clearGrid()`: fill alpha to 0 (fully transparent)
- `setPixel(x_px, y_px, r, g, b, a)`: bounds-checked write

---

## 6.2 Map graph nodes to grid cells
Estimated time: 20 min

Tasks
- For each node: `px_x = floor(node.x_m / 10)`, `px_y = floor(node.y_m / 10)`
- Pre-compute and store as `Uint16Array nodePixelX[N]`, `nodePixelY[N]`
- These are computed once after graph load; not recomputed per routing run

---

## 6.3 Render reachable cells
Estimated time: 45 min

### 6.3.1 Colour mapping
Estimated time: 20 min

Tasks
- Define colour ramp: 0–5 min → green, 5–15 min → yellow, 15–30 min → orange, 30–45 min → red
- `timeToColour(seconds)` returns `[r, g, b]`

### 6.3.2 Paint reachable nodes
Estimated time: 25 min

Tasks
- After routing: for each node with `dist[i] < Infinity`, call `setPixel` with colour mapped from travel time
- `putImageData` to canvas (composited over tile basemap using a second canvas layer with `globalAlpha`)
- Reachable cells are drawn with alpha ~180 (semi-transparent); unreachable cells are transparent

---

## 6.4 Blit isochrone layer onto basemap
Estimated time: 20 min

Tasks
- Canvas layering: `canvas#tiles` (bottom) + `canvas#isochrone` (top, `position: absolute`)
- On render: clear isochrone canvas; call `putImageData` for the current pixel grid

---

# Phase 7 — Progress Indication

*Routing on Berlin's full graph takes 0.5–2 s depending on time limit. Progress indication is required for both the initial load and each routing run.*

## 7.1 Loading progress UI
Estimated time: 30 min

Tasks
- Loading overlay (see Phase 5.1) shows two sequential phases: "Loading map tiles: N/M" and "Loading graph: X%"
- Overlay uses a simple CSS progress bar (`<div style="width: X%">`)
- On completion of both, overlay fades out and click interaction is enabled

---

## 7.2 Routing progress indication
Estimated time: 45 min

### 7.2.1 Incremental pixel grid updates during search
Estimated time: 30 min

Tasks
- The Dijkstra loop is broken into time-sliced chunks: process nodes for up to 8 ms, then `requestAnimationFrame` to yield
- After each chunk: paint currently-settled nodes to the isochrone canvas
- Visual effect: isochrone expands outward in real time as search progresses

### 7.2.2 Routing status text
Estimated time: 15 min

Tasks
- Small status line below canvas: "Calculating… (N nodes settled)" during search
- On completion: "Done — reachable area for 30 min walk"

---

# Phase 8 — Routing Engine

## 8.1 Implement binary min-heap priority queue
Estimated time: 45 min

Tasks
- `MinHeap` class: `push(nodeIndex, cost)`, `pop() → {nodeIndex, cost}`, `decreaseKey(nodeIndex, newCost)`
- Internal storage: `Float64Array` for costs, `Int32Array` for node indices, `Int32Array` for position lookup (required for decreaseKey)
- Unit test: insert 1000 random elements, confirm pop order is non-decreasing

---

## 8.2 Implement walking Dijkstra
Estimated time: 1 hour

### 8.2.1 Initialise search structures
Estimated time: 20 min

Tasks
- `Float32Array dist[N_nodes]` initialised to `Infinity`
- `Uint8Array settled[N_nodes]` initialised to 0
- Find nearest node to click point (Euclidean scan; acceptable for MVP — see Phase 9.2 for spatial index)
- Set `dist[source] = 0`; push source to heap

### 8.2.2 Implement node expansion loop
Estimated time: 25 min

Tasks
- Pop minimum; if settled, skip
- For each outgoing edge: relax if `dist[source] + edge_cost < dist[target]`
- Early termination when popped cost exceeds `time_limit_seconds`

### 8.2.3 Integrate with time-sliced rendering
Estimated time: 15 min

Tasks
- Wrap expansion loop in the 8 ms time-slice scheme from Phase 7.2.1
- Pass settled node batch to pixel painter after each slice

---

## 8.3 Stub transit integration point
Estimated time: 20 min

Tasks
- After walking Dijkstra settles all nodes within walking range of stops, add a clearly-commented stub: `// POST-MVP: run CSA here, then re-run Dijkstra from transit-reached stops`
- The stub reads `N_stops` from header; if 0, skips silently

---

# Phase 9 — Map Interaction

## 9.1 Convert click coordinates to graph nodes
Estimated time: 45 min

### 9.1.1 Map canvas pixel to UTM coordinates
Estimated time: 20 min

Tasks
- Canvas pixel (px, py) → UTM: `easting = origin_easting + px * 10`, `northing = origin_northing + (grid_height - py) * 10` (y-axis inversion: canvas y increases downward, northing increases upward)
- No library needed; pure arithmetic

### 9.1.2 Find nearest graph node
Estimated time: 25 min

Tasks
- MVP: linear scan over all nodes; Berlin graph post-simplification ~300 000–500 000 nodes; scan takes <5 ms — acceptable at click time
- Returns node index; highlight corresponding canvas pixel

---

## 9.2 Wire click to routing engine
Estimated time: 30 min

Tasks
- `canvas.addEventListener('click', ...)` reads pixel coordinates
- Convert to UTM, find nearest node, launch Dijkstra
- On new click during active search: cancel current search (set a `cancelled` flag checked each time-slice), clear pixel grid, start fresh

---

## 9.3 Time control
Estimated time: 20 min

Tasks
- `<input type="range" min="5" max="90" step="5">` for time limit in minutes, with numeric label
- On change: re-run routing from last clicked node (debounced 200 ms)

---

# Phase 10 — Build, Compression, and Deployment

## 10.1 Compress binary graph
Estimated time: 20 min

Tasks
- Gzip the `.bin` file: `gzip -9 berlin_graph.bin` → `berlin_graph.bin.gz`
- Expected compression: ~40–60 % reduction (coordinate deltas and repeated patterns compress well)
- Configure web server (or GitHub Pages `_headers` file) to serve with `Content-Encoding: gzip`
- JS loader fetches the `.gz` file; browser decompresses transparently

---

## 10.2 Production build
Estimated time: 20 min

Tasks
- Run esbuild build script (from Phase 1.3): outputs minified `dist/app.js`
- Confirm total JS payload < 50 kB (expected ~20 kB)

---

## 10.3 Deploy to GitHub Pages
Estimated time: 30 min

Tasks
- Push `/web/dist/` and `berlin_graph.bin.gz` to `gh-pages` branch (or configure Pages source)
- Verify tile loading, graph loading, and click-to-isochrone in deployed environment
- Verify `Content-Encoding: gzip` is being served correctly (check DevTools Network tab)

---

# Phase 11 — Post-MVP: GTFS Transit Integration

*This phase is explicitly deferred from MVP. The binary format, routing stubs, and stop-attachment flags in the graph are designed to accept transit data without schema changes. The system is designed for any GTFS feed, for any region.*

## 11.1 Obtain GTFS feed
Estimated time: variable (not included in total)

Tasks
- Register at feed provider (e.g. BVG OpenData for Berlin, or any GTFS-publishing agency)
- Verify licence permits redistribution in a compiled binary (if not, the graph must be served from an authenticated endpoint rather than a public repo)
- Download and unzip GTFS bundle (`.zip` containing `stops.txt`, `trips.txt`, `stop_times.txt`, `calendar.txt`, `calendar_dates.txt`, `routes.txt`)

---

## 11.2 Parse and filter GTFS stops
Estimated time: 45 min

### 11.2.1 Load stops.txt
Estimated time: 20 min

Tasks
- Parse CSV; project stop (lat, lon) → UTM using same projection as walking graph
- Discard stops outside the walking graph bounding box

### 11.2.2 Link stops to nearest walking nodes
Estimated time: 25 min

Tasks
- Build k-d tree over walking nodes (use `scipy.spatial.KDTree` in Python pipeline)
- For each stop: find nearest walking node within 200 m; flag it `is_stop_attachment`
- Discard stops with no walking node within 200 m

---

## 11.3 Parse GTFS schedules
Estimated time: 1 hour 30 min

### 11.3.1 Load calendar and calendar_dates
Estimated time: 30 min

Tasks
- Parse `calendar.txt` → service_id → day-of-week bitmask
- Parse `calendar_dates.txt` → apply additions/removals to each service
- Output: `service_day_mask[service_id]` (uint8, bits 0–6 = Mon–Sun)

### 11.3.2 Load trips and routes
Estimated time: 20 min

Tasks
- Parse `trips.txt` → `trip_id → {route_id, service_id}`
- Parse `routes.txt` → `route_id → transport_type`

### 11.3.3 Parse stop_times and build connection list
Estimated time: 40 min

Tasks
- Parse `stop_times.txt` → for each trip, sorted stop sequence with departure times
- Emit one transit edge per consecutive stop pair per trip: `{from_stop, to_stop, departure_seconds, travel_seconds, route_id, service_day_mask}`
- Sort all transit edges by `departure_seconds` (required for CSA)

---

## 11.4 Export augmented binary graph
Estimated time: 30 min

Tasks
- Re-run Phase 4 export with `N_stops > 0`, `N_tedges > 0`, `flags` bit 0 = 1
- Verify graph file size (expect 50–150 MB uncompressed for Berlin BVG+DB; compress to ~30–70 MB)

---

## 11.5 Implement CSA transit routing
Estimated time: 2 hours 30 min

### 11.5.1 Load transit tables in JS
Estimated time: 20 min

Tasks
- Map stop and transit edge TypedArrays (already specified in Phase 5.3.2; they just return empty views in MVP)

### 11.5.2 Implement Connection Scan Algorithm
Estimated time: 1 hour

Tasks
- Input: earliest arrival time at each stop reachable by walking (from Phase 8.2 output)
- Scan transit edges in departure-time order; for each edge, if `T_arrival_at_from_stop + transfer_penalty ≤ departure_time`, update `T_arrival[to_stop]`
- Transfer penalty: 3 min (180 s) default, configurable
- Output: `T_arrival[stop_index]` for all reachable stops

### 11.5.3 Multi-source Dijkstra from transit-reached stops
Estimated time: 30 min

Tasks
- Seed Dijkstra with all stops where `T_arrival[stop] < Infinity`; initial cost = `T_arrival[stop]`
- Re-run walking Dijkstra; merge with existing walking-only distances (take minimum)

### 11.5.4 Integrate day-of-week filtering
Estimated time: 40 min

Tasks
- Time-of-day input (Phase 9.3) is extended to include a day-of-week selector
- Filter transit edges to those whose `service_day_mask` includes the selected day

---

# Architectural Notes

## On Web Workers (point 7)
Web Workers are **not planned** at any phase. The routing loop is time-sliced via `requestAnimationFrame` (Phase 7.2), which gives adequate UI responsiveness without the complexity of cross-thread `ArrayBuffer` transfer, Worker lifecycle management, or the risk of needing `SharedArrayBuffer` (which requires specific COOP/COEP HTTP headers). If profiling after Phase 8 reveals that even 8 ms slices cause dropped frames (unlikely on a modern device for a 30-min isochrone), a Worker can be added then — but there is no basis for scheduling that work now.

## On future region support
The pipeline is parameterised from Phase 3.2 onward: `--epsg`, `--input`, `--output` flags on all pipeline scripts. The binary header stores the EPSG code so the JS client knows which projection was used. To build a graph for any other city, the operator provides an Overpass query (or equivalent OSM JSON extract) and optionally a GTFS `.zip`, then runs the pipeline. No code changes are needed for regions using any UTM zone or national grid projection supported by `pyproj`.

---

# Total Estimated Development Time (MVP: Phases 1–10)

| Phase | Description | Estimated Time |
|-------|-------------|----------------|
| 1 | Project setup + bundler | 2 h |
| 2 | Data exploration + schema design + writer | 2.5 h |
| 3 | OSM extraction + graph build | 4.5 h |
| 4 | Binary export + validation | 1.25 h |
| 5 | Web client shell + tiles + loader | 2.5 h |
| 6 | Pixel grid + canvas rendering | 1.75 h |
| 7 | Progress indication | 1.25 h |
| 8 | Routing engine | 2.5 h |
| 9 | Map interaction | 1.5 h |
| 10 | Build + deploy | 1.25 h |

**MVP total: ~21 hours for a junior developer**

Post-MVP (Phase 11, GTFS transit) adds approximately **7–9 hours** of development, plus the variable time to obtain and verify the GTFS licence.

---

# Expected Outputs

## MVP artifacts
- `berlin_graph.bin.gz` — compressed walking-only binary graph
- `/data_pipeline/input/berlin-routing.osm.json` — Overpass JSON extract for Berlin routing build
- `/web/dist/index.html`
- `/web/dist/app.js` — minified bundle
- `/data_pipeline/` — Python pipeline scripts

## Post-MVP additions
- Augmented `berlin_graph.bin.gz` with transit tables populated
- `/web/src/csa.js` — Connection Scan Algorithm module

---

## Note On Public Polygons
Public polygons (parks, greens, woods, recreation areas) are useful for context and optional future area-aware routing, but movement inside them is neither always free nor always represented by dense internal paths. Densely wooded and otherwise inaccessible sub-areas exist; in other cases only sparse walkable tracks are mapped. The routing model must therefore treat polygon-level walkability as conditional and constrained, not uniformly traversable.
