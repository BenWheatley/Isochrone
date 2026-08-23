# PLAN.md — Isochrone Web App (Revised)

**Goal:** A client-side web app that computes isochrones from a preprocessed
OpenStreetMap graph, loaded as a compact binary. Originally scoped to walking
in Berlin; as delivered it covers sixteen regions, the walk, cycle, drive,
ferry and public-transport modes, and renders isochrone edges on the GPU with
per-endpoint time interpolation, over a preprocessed district-boundary
basemap. The 10 m/pixel raster described in the earlier phases below survives
only as the fallback for browsers without WebGL.

**Status of the transit work.** Phase 11 was written when GTFS/CSA support was
architected but stubbed. It has since shipped: Berlin (VBB) and Adelaide
(Adelaide Metro) both carry timetables, and the Connection Scan runs at query
time in the browser. The individual checkboxes below record what did and did
not land.

**Projection.** Each region declares its own projected EPSG code in
`data_pipeline/regions.json`, and the code is stored in the binary header so
the client knows what it is reading. Berlin uses UTM zone 33N (EPSG:25833),
whose scale factor at the central meridian is 0.9996 — 1 projected metre =
1.0004 m of true surface travel, an error well under 0.1% across the city, and
symmetric in both axes, so N pixels horizontally is N×10 m of surface travel
to sub-pixel accuracy across the whole extent. The same reasoning governs the
choice made for each other region; the projection maths are isolated to a
single module.

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

## 1.3 Configure vanilla JavaScript runtime
Estimated time: 45 min

**Decision:** Use native browser ES modules. No Node.js build toolchain, no bundler, no npm scripts.

### 1.3.1 Set module loading strategy
Estimated time: 15 min

Tasks
- [x] Use `<script type="module" src="./src/app.js">` in `index.html`
- [x] Keep runtime dependencies browser-native (no npm package imports)
- [x] Confirm app boots via static server (`python -m http.server`)

### 1.3.2 Define static-serving workflow
Estimated time: 15 min

Tasks
- [x] Document static serving entrypoint (`/web/index.html`)
- [x] Use direct module files from `/web/src/` without transpilation

### 1.3.3 Create source layout
Estimated time: 15 min

Tasks
- [x] Create `/web/src/` for ES module source files
- [x] Keep `/web/index.html` + `/web/src/` as deployable source (no build output dir required)
- [x] Create stub `src/app.js` with a single `console.log`

---

# Phase 2 — Data Exploration and Schema Design

*Schema is designed after data is understood, not before.*

## 2.1 Explore OSM data for Berlin
Estimated time: 45 min

### 2.1.1 Fetch Berlin OSM extract via Overpass
Estimated time: 15 min

Tasks
- [x] Use `docs/berlin_overpass_routing_query.ql` with `data_pipeline/fetch-data.sh` (superseded by the generalized `docs/overpass_routing_query.sh` + `region-data.py fetch` in Phase 10.6)
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
| 4      | uint8   | version (=2)      |
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

### Edge record (12 bytes, v2)

| Offset | Type   | Field |
|--------|--------|-------|
| 0      | uint32 | target_node_index |
| 4      | uint16 | cost_seconds (walking, uint16 → max ~18 min per edge, sufficient) |
| 6      | uint16 | flags (bit 0 `sidewalk_present`; bits 8..11 carry oneway/roundabout/directional-speed tag-presence markers for later restriction logic) |
| 8      | uint32 | packed metadata: bits 0..7 `mode_mask`, bits 8..15 `road_class_id`, bits 16..31 `maxspeed_kph` |

*Tooling reads both v1 and v2. Writers emit v2.*

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
- [x] Load `/data_pipeline/input/berlin-routing.osm.json`
- [x] Collect all `way` objects with a pedestrian-usable `highway` tag
- [x] Preserve routing constraint tags on each candidate way: `access`, `foot`, `oneway`, `oneway:foot`, `sidewalk`
- [x] Record the set of node IDs referenced by those ways
- [x] Collect connector nodes in a second lightweight pass: `barrier=*`, `highway=crossing`, `railway=level_crossing`, `entrance=*`

### 3.1.2 Load referenced nodes
Estimated time: 20 min

Tasks
- [x] Second pass: collect only `node` elements whose IDs are in the reference set
- [x] Store as dict `{osm_id: (lat, lon)}`

### 3.1.3 Handle missing node references
Estimated time: 20 min

Tasks
- [x] Ways referencing nodes not in the extract (border effects) are silently dropped
- [x] Log count of dropped ways

---

## 3.2 Project coordinates to UTM 33N
Estimated time: 30 min

Tasks
- [x] Use `pyproj.Transformer.from_crs("EPSG:4326", "EPSG:25833")`
- [x] Transform all node (lat, lon) → (easting, northing) in metres
- [x] Compute bounding box; derive `origin_easting`, `origin_northing` as minimum corner
- [x] Compute `grid_width_px = ceil((max_e - min_e) / 10)`, `grid_height_px = ceil((max_n - min_n) / 10)`
- [x] Store per-node as integer `(x_m, y_m)` offsets from origin (i32, max value ~50 000 for Berlin → fits in int32 with large margin)

*For Berlin: bounding box is roughly 45 km × 38 km → grid is ~4 500 × 3 800 px → ~17 megapixels. At 4 bytes/pixel (RGBA), the pixel buffer is ~68 MB — within browser working memory. The canvas element will be this size but only the visible viewport is painted to screen.*

---

## 3.3 Build adjacency list
Estimated time: 1 hour

### 3.3.1 Extract directed edges from ways
Estimated time: 25 min

Tasks
- [x] For each walkable way, iterate consecutive node pairs
- [x] Emit edge (A→B) and (B→A) for each pair (walking is bidirectional by default)
- [x] Exception: `oneway:foot=yes` ways emit only forward edge
- [x] Respect constraints during edge creation: exclude disallowed segments (`access=private/no`, `foot=no`) and keep `sidewalk=*` metadata for later refinements
- [x] Preserve connector-node flags (`crossing`, `level_crossing`, `entrance`, `barrier`) so later routing logic can apply penalties/filters without re-parsing OSM

### 3.3.2 Compute edge walking cost
Estimated time: 20 min

Tasks
- [x] Euclidean distance in projected metres between the two endpoint nodes
- [x] Walking speed: 1.39 m/s (5 km/h); cost = `round(dist_m / 1.39)` seconds
- [x] Cap at uint16 max (65535 s ≈ 18 min); any longer edge is split at midpoint

### 3.3.3 Sort and index adjacency list
Estimated time: 15 min

Tasks
- [x] Sort edges by source node index
- [x] Record `first_edge_index` and `edge_count` per node

---

## 3.4 Graph simplification
Estimated time: 1 hour 30 min

*Simplification reduces node count by ~60–70 %, shrinking the binary graph and speeding up routing.*

### 3.4.1 Tag stop-attachment nodes as non-mergeable
Estimated time: 10 min

Tasks
- [x] Any node within 50 m of a GTFS stop position is flagged `is_stop_attachment`
- [x] These nodes are excluded from merging even if degree-2
- [x] *(Stop positions are not yet loaded in MVP; this flag is set to 0 and the step is a no-op until post-MVP. The code path must exist now so simplification is stop-safe from the start.)*

### 3.4.2 Detect degree-2 nodes eligible for merging
Estimated time: 20 min

Tasks
- [x] Count in-degree and out-degree per node
- [x] A node is a merge candidate if: total degree = 2, not flagged `is_stop_attachment`, not a dead-end

### 3.4.3 Merge linear chains
Estimated time: 30 min

Tasks
- [x] Walk chains of degree-2 nodes; replace with a single edge whose cost is the sum of constituent edge costs
- [x] Accumulate the chain; the merged edge's cost is capped at uint16 max (split chains that would overflow)

### 3.4.4 Reindex nodes and edges
Estimated time: 30 min

Tasks
- [x] Assign new contiguous indices to surviving nodes
- [x] Rebuild adjacency lists with new indices
- [x] Log before/after node and edge counts

---

## 3.5 Validate walking graph
Estimated time: 30 min

Tasks
- [x] Pick 3 known Berlin locations; find nearest nodes; run BFS to confirm reachability
- [x] Assert no edge references an out-of-range node index
- [x] Assert edge costs are all > 0

---

# Phase 4 — Binary Graph Export (MVP: Walking Only)

## 4.1 Assemble and serialise binary graph
Estimated time: 45 min

### 4.1.1 Write header
Estimated time: 15 min

Tasks
- [x] Populate all header fields
- [x] Set `N_stops = 0`, `N_tedges = 0`
- [x] Set `flags` bit 0 = 0 (no transit)

### 4.1.2 Write node and edge tables
Estimated time: 20 min

Tasks
- [x] Iterate nodes in index order; pack each 16-byte record
- [x] Iterate edges in source-node order; pack each 12-byte record

### 4.1.3 Write empty stop and transit tables
Estimated time: 10 min

Tasks
- [x] Write zero bytes for both tables (preserves file format compatibility)

---

## 4.2 Validate binary output
Estimated time: 30 min

Tasks
- [x] Run reader test script from Phase 2.3.2
- [x] Assert magic and version
- [x] Spot-check 5 random nodes: decode coordinates, confirm they fall within Berlin bounding box
- [x] Assert all edge target indices < N_nodes

---

# Phase 5 — Web Client Shell

## 5.1 Create HTML application skeleton
Estimated time: 30 min

Tasks
- [x] `index.html` with: `<canvas id="map">`, time-of-day input (default 08:00), loading overlay `<div id="loading">`
- [x] Link to `src/app.js` via `<script type="module">`
- [x] No inline JS; no inline styles beyond basic layout

---

## 5.2 Implement district-boundary basemap
Estimated time: 1 hour

*Use `data_pipeline/output/berlin-district-boundaries-canvas.json` generated from OSM administrative boundaries. OSM attribution remains required (© OpenStreetMap contributors).*

### 5.2.1 Load and map boundary JSON
Estimated time: 25 min

Tasks
- [x] Fetch `berlin-district-boundaries-canvas.json`
- [x] Parse `coordinate_space` (`x_origin`, `y_origin`, `width`, `height`, axis info) and `features[].paths`
- [x] Convert boundary path coordinates to canvas pixel coordinates

### 5.2.2 Draw boundary basemap
Estimated time: 35 min

Tasks
- [x] Draw district polygons/lines on a dedicated basemap canvas layer (`canvas#boundaries`)
- [x] Style boundaries for readability (subtle fill + stronger stroke)
- [x] Show loading progress: "Loading district boundaries…" in the loading overlay
- [x] After drawing, keep the basemap layer static while isochrone rendering updates separately

---

## 5.3 Implement binary graph loader
Estimated time: 1 hour

### 5.3.1 Fetch binary file with progress
Estimated time: 25 min

Tasks
- [x] `fetch('graph-walk.bin')` with `response.body` stream reader
- [x] Track bytes received vs `Content-Length`
- [x] Update loading overlay: "Loading graph: N MB / M MB (X%)"

### 5.3.2 Parse TypedArrays from ArrayBuffer
Estimated time: 35 min

Tasks
- [x] Parse header fields using `DataView`
- [x] Map node table: `Int32Array` view for coordinates, `Uint32Array` for edge indices
- [x] Map edge table: `Uint32Array` for targets, `Uint16Array` for costs
- [x] Verify magic number; throw readable error if wrong
- [x] After parse: hide loading overlay; enable click interaction

---

# Phase 6 — Pixel Grid and Canvas Rendering

*Berlin at 10 m/pixel: ~4 500 × 3 800 px ≈ 17 Mpx. The raster buffer is an `ImageData` object of this size maintained in JS memory and blitted to canvas on each update.*

## 6.1 Allocate and manage pixel grid
Estimated time: 30 min

Tasks
- [x] Allocate `Uint8ClampedArray` of size `grid_width_px × grid_height_px × 4` (RGBA)
- [x] `clearGrid()`: fill alpha to 0 (fully transparent)
- [x] `setPixel(x_px, y_px, r, g, b, a)`: bounds-checked write

---

## 6.2 Map graph nodes to grid cells
Estimated time: 20 min

Tasks
- [x] For each node: `px_x = floor(node.x_m / 10)`, `px_y = floor(node.y_m / 10)`
- [x] Pre-compute and store as `Uint16Array nodePixelX[N]`, `nodePixelY[N]`
- [x] These are computed once after graph load; not recomputed per routing run

---

## 6.3 Render reachable cells
Estimated time: 45 min

### 6.3.1 Colour mapping
Estimated time: 20 min

Tasks
- [x] Define colour ramp: 0–5 min → green, 5–15 min → yellow, 15–30 min → orange, 30–45 min → red
- [x] `timeToColour(seconds)` returns `[r, g, b]`

### 6.3.2 Paint reachable nodes
Estimated time: 25 min

Tasks
- [x] After routing: for each node with `dist[i] < Infinity`, call `setPixel` with colour mapped from travel time
- [x] `putImageData` to canvas (composited over boundary basemap using a second canvas layer with `globalAlpha`)
- [x] Reachable cells are drawn with alpha ~180 (semi-transparent); unreachable cells are transparent

---

## 6.4 Blit isochrone layer onto basemap
Estimated time: 20 min

Tasks
- [x] Canvas layering: `canvas#boundaries` (bottom) + `canvas#isochrone` (top, `position: absolute`)
- [x] On render: clear isochrone canvas; call `putImageData` for the current pixel grid

---

# Phase 7 — Progress Indication

*Routing on Berlin's full graph takes 0.5–2 s depending on time limit. Progress indication is required for both the initial load and each routing run.*

## 7.1 Loading progress UI
Estimated time: 30 min

Tasks
- [x] Loading overlay (see Phase 5.1) shows two sequential phases: "Loading district boundaries…" and "Loading graph: X%"
- [x] Overlay uses a simple CSS progress bar (`<div style="width: X%">`)
- [x] On completion of both, overlay fades out and click interaction is enabled

---

## 7.2 Routing progress indication
Estimated time: 45 min

### 7.2.1 Incremental pixel grid updates during search
Estimated time: 30 min

Tasks
- [x] The Dijkstra loop is broken into time-sliced chunks: process nodes for up to 8 ms, then `requestAnimationFrame` to yield
- [x] After each chunk: paint currently-settled nodes to the isochrone canvas
- [x] Visual effect: isochrone expands outward in real time as search progresses

### 7.2.2 Routing status text
Estimated time: 15 min

Tasks
- [x] Small status line below canvas: "Calculating… (N nodes settled)" during search
- [x] On completion: "Done — reachable area for 30 min walk"

---

# Phase 8 — Routing Engine

## 8.1 Implement binary min-heap priority queue
Estimated time: 45 min

Tasks
- [x] `MinHeap` class: `push(nodeIndex, cost)`, `pop() → {nodeIndex, cost}`, `decreaseKey(nodeIndex, newCost)`
- [x] Internal storage: `Float64Array` for costs, `Int32Array` for node indices, `Int32Array` for position lookup (required for decreaseKey)
- [x] Unit test: insert 1000 random elements, confirm pop order is non-decreasing

---

## 8.2 Implement walking Dijkstra
Estimated time: 1 hour

### 8.2.1 Initialise search structures
Estimated time: 20 min

Tasks
- [x] `Float32Array dist[N_nodes]` initialised to `Infinity`
- [x] `Uint8Array settled[N_nodes]` initialised to 0
- [x] Find nearest node to click point (Euclidean scan; acceptable for MVP — see Phase 9.2 for spatial index)
- [x] Set `dist[source] = 0`; push source to heap

### 8.2.2 Implement node expansion loop
Estimated time: 25 min

Tasks
- [x] Pop minimum; if settled, skip
- [x] For each outgoing edge: relax if `dist[source] + edge_cost < dist[target]`
- [x] Early termination when popped cost exceeds `time_limit_seconds`

### 8.2.3 Integrate with time-sliced rendering
Estimated time: 15 min

Tasks
- [x] Wrap expansion loop in the 8 ms time-slice scheme from Phase 7.2.1
- [x] Pass settled node batch to pixel painter after each slice

---

## 8.3 Stub transit integration point
Estimated time: 20 min

Tasks
- [x] After walking Dijkstra settles all nodes within walking range of stops, add a clearly-commented stub: `// POST-MVP: run CSA here, then re-run Dijkstra from transit-reached stops`
- [x] The stub reads `N_stops` from header; if 0, skips silently

---

# Phase 9 — Map Interaction

## 9.1 Convert click coordinates to graph nodes
Estimated time: 45 min

### 9.1.1 Map canvas pixel to UTM coordinates
Estimated time: 20 min

Tasks
- [x] Canvas pixel (px, py) → UTM: `easting = origin_easting + px * 10`, `northing = origin_northing + (grid_height - 1 - py) * 10` (y-axis inversion so north remains up on canvas)
- [x] No library needed; pure arithmetic

### 9.1.2 Find nearest graph node
Estimated time: 25 min

Tasks
- [x] MVP: linear scan over all nodes; Berlin graph post-simplification ~300 000–500 000 nodes; scan takes <5 ms — acceptable at click time
- [x] Returns node index; highlight corresponding canvas pixel

---

## 9.2 Wire click to routing engine
Estimated time: 30 min

Tasks
- [x] `canvas.addEventListener('click', ...)` reads pixel coordinates
- [x] Convert to UTM, find nearest node, launch Dijkstra
- [x] On new click during active search: cancel current search (set a `cancelled` flag checked each time-slice), clear pixel grid, start fresh

---

## 9.3 Time control
Estimated time: 20 min

Tasks
- [x] Remove walk-time cap UI for MVP travel-time field mode
- [x] On click: compute full travel-time field across reachable graph nodes (no upper bound)

---

# Phase 10 — Build, Compression, and Deployment

## 10.1 Compress binary graph
Estimated time: 20 min

Tasks
- [x] Gzip the `.bin` file: `gzip -9 berlin_graph.bin` → `berlin_graph.bin.gz`
- [x] Expected compression: ~40–60 % reduction (coordinate deltas and repeated patterns compress well). Observed for Berlin sample: ~25 MB → ~8.6 MB (~65 % reduction).
- [x] Configure web server (or GitHub Pages `_headers` file) to serve with `Content-Encoding: gzip` if available; JS runtime also supports raw `.gz` payloads without this header.
- [x] JS loader fetches the `.gz` file and decompresses before binary parsing.

---

## 10.2 Production static package
Estimated time: 20 min

Tasks
- [x] Verify `index.html` loads `src/app.js` as ES module without bundling
- [x] Confirm static asset paths are relative and deploy-safe

---

## 10.3 Deploy to GitHub Pages
Estimated time: 30 min

Tasks
- [x] Configure GitHub Pages source via Actions workflow that publishes `/web/` static files plus `graph-walk.bin.gz`
- [x] Verify boundary basemap loading, graph loading, and click-to-isochrone in deployed environment

---

## 10.4 Post-MVP: Multimodal Road Schema + Extraction Foundation
Estimated time: 4 hours 30 min

*This phase adds the schema and extraction prerequisites for bike/car mode support and speed-aware routing. It intentionally starts at data/model level before UI and algorithm changes.*

### 10.4.1 Define binary schema v2 for road-mode routing
Estimated time: 45 min

Tasks
- [x] Bump binary format version (`version = 2`) and document backward compatibility policy (v1 read support in tooling; web runtime can require v2 once migrated)
- [x] Extend edge schema to include per-mode access and speed metadata (at minimum: `mode_mask`, `maxspeed_kph`, `road_class_id`)
- [x] Decide and document cost storage strategy:
  - [ ] Option A: store per-mode precomputed edge costs (`walk_s`, `bike_s`, `car_s`)
  - [x] Option B: store speed/access metadata and compute bike/car costs at runtime from edge geometry + metadata (walk stays precomputed in MVP transition)
- [x] Reserve bits/fields for turn/access restrictions that affect car/bike legality (even if enforcement lands in a later phase)

### 10.4.2 Expand OSM extraction tags for mode/speed
Estimated time: 1 hour

Tasks
- [x] Extend extraction tags beyond walking constraints to include bike/car legality and speed tags:
  - [x] `bicycle`, `cycleway`, `oneway:bicycle`
  - [x] `motor_vehicle`, `vehicle`, `oneway`
  - [x] `maxspeed`, `maxspeed:forward`, `maxspeed:backward`
  - [x] `junction`, `access`, `service`, `surface`, `tracktype` (for fallback speed heuristics)
- [x] Persist extracted tags through `WayCandidate` into adjacency/export stages (no silent dropping)
- [x] Add extraction summary counts for tag presence/coverage (e.g. `% edges with explicit maxspeed`)

### 10.4.3 Normalize speed and access semantics
Estimated time: 1 hour 15 min

Tasks
- [x] Implement robust `maxspeed` parser (numeric + unit variants, e.g. `50`, `30 mph`, `walk`)
- [x] Add directional speed selection (`maxspeed:forward`/`backward`) on directed edges
- [x] Define deterministic fallback speed table by highway class + mode when explicit speed tags are absent
- [x] Define deterministic mode-access rules (allow/deny) from combined tags, including conflict resolution order

### 10.4.4 Export and validation updates
Estimated time: 50 min

Tasks
- [x] Update binary writer/reader/validator for v2 edge records and mode metadata
- [x] Add validation checks:
  - [x] `mode_mask != 0` for all exported edges
  - [x] speed bounds sane (e.g. `0 < maxspeed_kph <= 200`)
- [x] Emit export summary metrics for each mode (edge counts and coverage)

### 10.4.5 Runtime read path scaffolding (no UI yet)
Estimated time: 40 min

Tasks
- [x] Extend JS parser TypedArray mapping to read new v2 edge fields
- [x] Keep routing behavior walk-only until mode-selector and mode-aware costing are implemented in follow-up phase
- [x] Fail fast with clear error if runtime receives unsupported schema version

---

## 10.5 Routing Hot-Path Performance Follow-Ups
Estimated time: 2 hours 30 min

Tasks
- [x] Remove heap pop allocation in Dijkstra hot path by adding reusable-entry `MinHeap.popInto(...)` and switching `expandOne()` to reuse a single pop entry object
- [x] Inline edge traversal cost cache access in `expandOne()` (`edgeTraversalCostSeconds[edgeIndex]`) with direct compute-on-NaN fallback to avoid per-edge helper call overhead
- [x] Hoist frequently-used graph TypedArray references and constants out of the innermost routing loop to reduce repeated property lookups
- [x] Evaluate replacing heap decrease-key with duplicate-push + stale-entry skip strategy and keep whichever wins in browser profiling for full-field runs
- [x] Add a nearest-node spatial index for click seeding (mode-aware) to avoid worst-case full-node scans before routing begins

Benchmark note (2026-03-11):
- Decrease-key remained the default after local graph benchmark (5 rounds × 3 full-field runs): `decrease-key` ~132 ms avg vs `duplicate-push` ~136 ms avg.

### 10.5.1 Planned (Not Implemented): Parallel SSSP Direction for Multi-Mode (Item 6)
Estimated time: 5 hours

Tasks
- [ ] Prototype an integer-tick bucket/delta-stepping frontier in Rust/WASM (single-threaded first) to reduce multi-mode expand-loop overhead.
- [ ] Add headless benchmark scenarios focused on multi-mode (`walk+bike`, `walk+car`, `all`) with fixed seeds and publish per-phase timing outputs.
- [ ] Evaluate browser/runtime requirements for a WASM-threads path (Workers + `SharedArrayBuffer` + COOP/COEP) and document deployment implications.
- [ ] Evaluate a WebGPU frontier-relax prototype as an alternative parallel path and compare complexity/perf against WASM threads.
- [ ] Add a decision gate entry with chosen path, expected speedup target, and rollback criteria before implementation.

---

## 10.6 Post-MVP: Multi-Location OSM Fetch Generalization
Estimated time: 3 hours 45 min

*This phase generalizes the current Berlin-specific Overpass fetch flow into a reusable multi-location pipeline stage without changing routing internals yet.*

**Implementation note:** this shipped with a different concrete design than originally planned below — a single `data_pipeline/regions.json` registry (array of region entries) instead of one manifest file per location, and a `region-data.py` CLI (`fetch` / `build` / `all` subcommands) instead of a bare parameterized shell script. The design goals (deterministic selectors, templated queries, tested, non-Berlin fixtures, documented onboarding) are all met; the file layout is just simpler than planned. Tasks below are checked against what actually exists.

### 10.6.1 Add location manifests
Estimated time: 40 min

Tasks
- [x] `data_pipeline/regions.json` holds one array of region entries (not per-file manifests) with fields: `id`, `name`, `localizedNames`, `graphFileName`, `boundaryFileName`, `locationRelation`, `subdivisionAdminLevel`, `subdivisionDiscoveryModes`, `epsg`, `graphBinaryFileName`, `graphSummaryFileName`, `boundaryResolution`, `boundaryUnits`, `coastal`, `coastSource` — parsed and validated by `load_region_specs()` in `region_pipeline.py`
- [x] Berlin is the canonical baseline entry; validation rejects duplicate ids and missing required fields
- [x] Deterministic selection: `--only <id>[,<id>...]` limits processing to specific regions; default (no `--only`) processes every region in the file

### 10.6.2 Add Overpass query templating
Estimated time: 45 min

Tasks
- [x] `docs/overpass_routing_query.sh` and `docs/overpass_boundary_query.sh` are location-agnostic templates parameterized by `--location-label`, `--location-relation`, `--subdivision-admin-level`, `--subdivision-discovery-modes`
- [x] `region_pipeline.render_query()` renders the concrete query text per region before fetching (logged to stderr for reproducibility/debugging, not written to a persisted `.ql` file per location)
- [x] Deterministic selector policy: the region's `locationRelation` selector is used as-is (relation-id-first where the region config specifies one, e.g. Berlin/Athens/London/Portsmouth), with `name`/`wikidata` guard tags where available

### 10.6.3 Replace hardcoded fetch script with parameterized fetch entrypoint
Estimated time: 45 min

Tasks
- [x] `data_pipeline/region-data.py fetch --only <id> --components routing,boundary` replaces the old Berlin-only `fetch-data.sh`; components also accept `way`/`ways`/`boundaries` aliases
- [x] Strict shell behavior (`set -euo pipefail`) preserved in the query templates; `fetch_overpass_json()` fails loudly on non-2xx/empty responses and saves the failed query + response for debugging
- [x] Output paths are resolved from the region id by default (`--input-dir`/`--output-dir` override the base directory, not per-file paths)

### 10.6.4 Standardize per-location artifact layout
Estimated time: 25 min

Tasks
- [x] Actual layout is flat and slug-prefixed, not nested directories: `data_pipeline/input/<id>-routing.osm.json`, `<id>-district-boundaries.osm.json`; outputs as `data_pipeline/output/<id>-graph.bin(.gz)`, `<id>-district-boundaries-canvas.json`, `<id>-graph-summary.json`
- [x] Compatibility aliases: Berlin still uses its original `graph-walk.bin(.gz)` graph filenames (configured via `graphFileName`/`graphBinaryFileName` in its region entry) since that is what the deployed web runtime references by default

### 10.6.5 Add location-aware pipeline wiring
Estimated time: 25 min

Tasks
- [x] `region-data.py fetch|build|all --only <id>` resolves relation selector, `epsg`, admin level, and file paths from `regions.json` — no per-script `--location` flag needed since the CLI itself is the location-aware entrypoint
- [x] `--epsg`/output naming stay explicit per-region-entry (not overridable per-invocation); this matches the deterministic/reproducible-build goal better than ad hoc manual overrides

### 10.6.6 Generalize Overpass survey tooling
Estimated time: 20 min

Tasks
- [x] `osm_json_survey.py`/`overpass_survey.py` operate on whatever input file is passed in, with no hardcoded Berlin relation IDs
- [x] Survey output includes the source file path, which carries the region slug

### 10.6.7 Tests and migration docs
Estimated time: 25 min

Tasks
- [x] `data_pipeline/tests/test_region_pipeline.py` covers manifest (region spec) validation, `test_fetch_queries.py` covers query rendering for both discovery modes, both use Paris/London/Luxembourg fixtures throughout (not Berlin-only)
- [x] Non-Berlin fixtures are the norm across the pipeline test suite, not just one token fixture
- [x] Onboarding steps are documented in `docs/region-data-pipeline.md` (the `docs/locations.md` filename in the original plan didn't end up matching what shipped); legacy Berlin filenames are called out explicitly as a compatibility path, not hidden

**Currently configured regions** (`data_pipeline/regions.json`, 16): berlin, paris, cologne, athens, london, rome, portsmouth, rhode-island, luxembourg-country, singapore, adelaide, nairobi, mexico-city, ottawa, zurich-canton, cyprus. **Deployed** (present in `web/src/data/locations.json`, i.e. actually fetched/built and shipped, 12): berlin, paris, cologne, london, rome, rhode-island, luxembourg-country, singapore, mexico-city, ottawa, zurich-canton, cyprus.

All 16 configured regions are deployed as of 2026-08-20. The last four were resolved as follows:
- `athens` — the routing query had been returning zero elements because the selector filtered on `name="Athens"`/`Q1524`, but `rel(1370736)` carries `name="Δήμος Αθηναίων"`/`Q1224979`. Corrected; the fixed selector returns 73,846 elements. Note the relation is the *municipality* (9 x 10 km), not the Athens urban area.
- `portsmouth` — the earlier boundary failure was a transient Overpass dispatcher timeout and succeeded on retry. Its grid is 206 x 248 km because its ferries reach the Isle of Wight, France and the Channel Islands; the viewport still frames the city, which is what decoupling the viewport from the grid (12.x) was for.
- `adelaide` — rescoped from the CBD council (Q1094063, 4 x 5 km) to metropolitan Adelaide (`rel(11381689)`, Q5112, 38 x 86 km), and built with its CC BY 4.0 GTFS folded in.
- `nairobi` — built; 83,143 nodes over 50 x 32 km.

---

## 10.7 Post-MVP: Basemap Context Layers (Coastal Water, Forest, Inland Water, Waterways, Airports)
Estimated time: 6 hours

*Not in the original plan — added in response to user feedback wanting more visual context on the map. Rendering-only: none of this affects the routing graph, edge costs, or reachability. See the "Note On Public Polygons" section below — polygon context is deliberately not treated as uniformly walkable.*

### 10.7.1 Coastal water polygons (opt-in, external dataset)
Estimated time: 2 hours

Tasks
- [x] `data_pipeline/src/isochrone_pipeline/water_polygons.py`: clip the OSM coastline water-polygon shapefile (osmdata.openstreetmap.de, ~900 MB) to a region's bbox
- [x] Cache the downloaded archive at `data_pipeline/.cache/water-polygons/` (gitignored) so it is fetched once total, not once per region build
- [x] Opt-in `"coastal": true` (+ optional `"coastSource"`) field on `regions.json` entries, threaded through `region_pipeline.py`'s `run_build_pipeline` as `include_coast`/`coast_source` — opt-in specifically because of the external download cost, unlike everything else in this phase
- [x] Clipped sea polygons are written into the boundary canvas JSON as `water_features`; rendered as a filled layer and exported to SVG (`isochrone-sea` group)

### 10.7.2 Forest, inland water, waterway, and airport context (always-on, same Overpass fetch)
Estimated time: 2.5 hours

Tasks
- [x] Extend `docs/overpass_boundary_query.sh` with an unconditional `.naturalArea` binding (independent of subdivision discovery mode) selecting way-tagged `natural=wood`/`landuse=forest`/`natural=water`/`waterway=river|canal|stream`/`aeroway=aerodrome` — always fetched, no per-region flag, since it rides the same Overpass request as admin boundaries rather than an external download
- [x] Extract into `forest_features`, `inland_water_features`, `waterway_features` (with a `navigable` flag derived from the `boat` tag: `yes`/`permissive`/`designated` → navigable, `no` → not, otherwise canals default navigable and rivers/streams default not), and `airport_features` in `boundary_canvas.py`
- [x] Filter polygon features under ~1 hectare (shoelace area via a dedicated metric transformer, independent of `units`/the render transformer, which is `None` in degrees-mode builds) to drop digitizing-noise slivers
- [x] Render as new canvas layers, bottom-to-top: forest → airports → inland water → sea → waterways → admin boundaries; export the same layers (plus the previously-missing sea layer) to SVG

### 10.7.3 Multipolygon relation support for water and airports
Estimated time: 1.5 hours

Tasks
- [x] `_stitch_ways_into_rings` in `boundary_canvas.py`: greedily reassemble a relation's outer/inner member ways (frequently split into dozens of segments — the Thames alone is 31 outer + 58 inner) into closed rings by matching shared endpoints
- [x] Normalize outer/inner ring winding direction so nonzero-winding fill punches holes correctly (e.g. islands within a water body), matching the convention already used for coastal water's multi-ring shapefile features
- [x] Scope relation-typed area scans narrowly to `natural=water` and `aeroway=aerodrome` only, and verified live against London (~7 s round trip) — a *broad* relation-typed area scan (`boundary=administrative`) was previously found too expensive for London specifically (see 10.6's `subdivisionDiscoveryModes` note), so this is a deliberate scope limit, not an oversight
- [x] Deliberately out of scope for now: multipolygon relations for `natural=wood`/`landuse=forest` (ways only) — no evidence yet that forest/wood is commonly relation-mapped enough to need it

Verification note (2026-08-06): confirmed against London — the tidal Thames (previously rendered as a bare, gapped centerline with an unfilled border) is a single 89-member relation and now renders as a continuous filled body with correct island holes; Heathrow (a relation) and 6 smaller airfields (ways) render as a new muted airport context layer. Rolled out to the other deployed regions (berlin, paris, rome, luxembourg-country, cologne, rhode-island) the same day.

**Update:** the "Water" transport mode described as deferred above was subsequently implemented — see 10.8.

---

### 10.8 Water/ferry transport mode
*Implements the routing half of the "Water" mode deferred in 10.7.3 above — the rendering-only waterway/sea layers already existed; this adds an actual connectivity graph and a fourth selectable mode.*

Tasks
- [x] Extract ferry ways (`route=ferry`) as a separate pass alongside the walkable-network extraction, carrying the `duration=` tag through for duration-aware speed costing — `osm_graph_extract.py`.
- [x] Fold ferry ways into the same adjacency graph with a composite mode mask bit (`EDGE_MODE_WATER_BIT`) and duration-aware or fallback speed — `adjacency.py`.
- [x] Add a water-mode branch to both routing kernels (Rust `edge_cost_seconds` and the JS `computeEdgeTraversalCostSeconds` reference) — ferry legs cost at the baked ferry speed regardless of which boarding mode bit matched, since a ferry crossing takes the same time whether you walked, biked, or drove onto it.
- [x] Add "Ferry" as a fourth `#mode-select` option (now a checkbox in the "Transport modes" group, see 12.8) and rebuild every deployed region's graph with ferry edges included.
- [x] Replace the fixed 80km per-way ferry span cutoff with a grid-size budget: ferry candidates are accepted nearest-to-the-core-network first, up to a safety margin below the binary format's actual hard limit (u16 `grid_width_px`/`grid_height_px` header fields cap extent at 65,535 × 10m/pixel ≈ 655km) — the fixed cutoff was too small for regions whose own coastline exceeds 80km (e.g. Cyprus) — `select_ferry_ways_within_grid_budget` in `osm_graph_extract.py`.
- [x] Decouple the default/max-zoom-out viewport from the full routing grid extent, fitting the district boundary (+5% padding) instead — legitimate-but-distant ferry connections (e.g. Singapore's regional ferry routes) were otherwise dragging the default view out to include far-flung endpoints nobody wants to see by default; panning still reaches the wider ferry network at the same zoom level, since panning stays clamped against the full grid — `web/src/core/viewport.js`'s `resolveFitScale`/`createDefaultMapViewport`.

---

# Phase 11 — Post-MVP: Global Public Transit Data Pipeline

*This phase is explicitly deferred from MVP. Goal: support public transport data ingestion and routing for any region, not just Berlin/Germany, by separating source formats from a canonical routing format.*

**Implementation note (Berlin pilot, landed):** the sections below marked `[x]` reflect a deliberately trimmed pass — GTFS **static** only (no GTFS-RT/NeTEx/SIRI), **Berlin only**, and **weekday-recurring calendar patterns** rather than full `calendar_dates.txt` exception fidelity (single-date holiday overrides aren't modeled) — confirmed against user intent ("proceed with Berlin specifically so I can test the result", later extended per user request to cover every date the feed actually supports rather than one locked reference day). See `data_pipeline/src/isochrone_pipeline/gtfs_transit.py`, the `transitFeed` block in `data_pipeline/regions.json`, and `runConnectionScanFromWalkingReachableStops`/`runWalkingIsochroneFromSourceNode` in `web/src/app.js`. Full feed-registry generalization (11.1, 11.7) and realtime/NeTEx adapters (11.2.2, 11.2.3) remain deferred.

## 11.1 Define feed registry and region config
Estimated time: 45 min

Tasks
- [x] Add a feed registry file (`docs/transit_feed_registry.md` or JSON) with per-region metadata: provider, licence URL, update cadence, timezone, and feed format — `docs/transit_feed_registry.md` surveys candidate GTFS sources and expected licences for all 16 configured regions, ranks them, and records the one-feed-per-region structural limit. Entries are unverified leads, explicitly flagged as needing confirmation at fetch time; Berlin's and Adelaide's have been fetched and verified against their publishers.
- [x] Add pipeline config inputs so the same scripts run for any city — done as a per-region optional `transitFeed` block in `regions.json` (`RegionSpec.transit_feed`) plus a `transit`/`gtfs` fetch+build component (`region-data.py fetch|build --components transit`), rather than the originally-sketched `--region`/`--transit-feed`/`--transit-format` CLI flags.
- [ ] Define licence gate rules (allowed for local processing, allowed for redistribution, attribution requirements) and fail export when redistribution is disallowed.

---

## 11.2 Source adapters (raw formats)
Estimated time: 3 hours

### 11.2.1 GTFS static adapter
Estimated time: 1 hour 15 min

Tasks
- [x] Parse `stops.txt`, `trips.txt`, `stop_times.txt`, `calendar.txt`, `calendar_dates.txt`, `routes.txt`, `agency.txt` — `data_pipeline/src/isochrone_pipeline/gtfs_transit.py`.
- [x] Normalize timezone/day rollover semantics (`25:10:00`, etc.) into service-day-relative seconds.
- [x] Keep raw identifiers for traceability while emitting normalized numeric IDs (stop/route ids resolved to compact integer indices for the binary export).

### 11.2.2 GTFS-Realtime adapter (optional overlay)
Estimated time: 45 min

Tasks
- [ ] Parse TripUpdates/VehiclePositions/ServiceAlerts (when available) as a delta layer over static schedules.
- [ ] Store delay/cancellation updates in a separate overlay artifact so static baseline remains cacheable.

### 11.2.3 NeTEx/SIRI adapter scaffold
Estimated time: 1 hour

Tasks
- [ ] Add adapter interface with deterministic output contract identical to GTFS adapter output.
- [ ] Implement minimal NeTEx import path for stop places, routes, journey patterns, and timetables.
- [ ] Implement minimal SIRI realtime mapping to the same delay/cancellation overlay schema as GTFS-RT.

---

## 11.3 Canonical internal transit model (useful processing format)
Estimated time: 2 hours

Tasks
- [x] Define canonical tables independent of source format — `TransitStop`/`TransitConnection` dataclasses in `gtfs_transit.py` (a trimmed subset: `stops` + `connections` derived from `trips`/`stop_times`, not separately-persisted `routes`/`services`/`transfers`/`agencies` tables).
- [x] Define canonical units/types: projected meters (UTM, matching the walking graph's `epsg`) for stop geometry, seconds-since-midnight for times, compact integer indices for stop/route joins. Service-day bitmask field is populated per connection from its real GTFS weekday pattern and consulted at query time (see 11.5's day-mask indexing entry below).
- [x] Define walking-graph linkage: stop → nearest walking-node attachment via a grid-bucketed spatial index (mirrors `findNearestNodeIndexForModeFromSpatialIndex`'s technique), with a 300m attach-radius cutoff and drop-count logging.
- [ ] Persist canonical intermediate artifacts as deterministic JSON/Parquet snapshots for debugging and repeatable builds — not done; the only persisted transit artifact is the final binary graph (stop/tedge tables folded into `graph-walk.bin`), no intermediate canonical-table dump.

---

## 11.4 Validation and quality gates
Estimated time: 1 hour 30 min

Tasks
- [ ] Validate schedule monotonicity (`arrival/departure` non-decreasing along each trip) — not explicitly validated; malformed source rows would surface as CSA scan anomalies rather than a build-time check.
- [x] Validate spatial linkage — stop attachment respects a 300m radius cutoff, with dropped-stop count logged (`dropped_stop_count` in `graph-binary-summary.json`'s `transit` block).
- [ ] Validate referential integrity across all tables (`trip -> route/service`, `connection -> stops/trip`) — not done as a standalone gate; would fail loudly downstream instead.
- [x] Emit per-region QA summary — `graph-binary-summary.json`'s `transit` block reports `parsed_stop_count`, `attached_stop_count`, `dropped_stop_count`, `total_stop_count_in_feed`, `raw_connection_count`, `date_range`, `final_stop_count`, `final_connection_count` (Berlin: 7,670 of 10,688 in-extent stops attached, 42,078 in the full feed, 1,892,441 final connections spanning every weekday-recurring service in the feed's 2026-08-04–2026-12-12 calendar window).

---

## 11.5 Build routing-optimized transit structures
Estimated time: 2 hours

Tasks
- [x] Generate CSA-ready `connections` sorted by departure time — a build-time invariant relied on by `runConnectionScanFromWalkingReachableStops`'s early-exit scan.
- [ ] Materialize transfer edges/penalties for stop-to-stop interchange and stop-to-walk-node transfers — stop-to-walk-node attach cost exists (straight-line distance / walking speed), but there's no dedicated stop-to-stop interchange/transfer-penalty model; CSA implicitly "transfers" by walking back onto the road graph between transit legs.
- [x] Build service-day indexing (day masks) for fast query-time filtering — the build includes every weekday-recurring service across the feed's whole calendar window (not just one day), and `runConnectionScanFromWalkingReachableStops` in `web/src/app.js` filters each connection's `service_day_mask` against the query date's ISO weekday bit. `calendar_dates.txt` single-date exceptions (e.g. holiday schedules) are still out of scope — they can't be expressed as a weekly bitmask and would need a per-date table instead.
- [x] Export deterministic binary transit tables and wire into graph header flags/versioning — `n_stops`/`n_tedges`/`stop_table_offset` header fields, `flags` bit 0 (`has_transit`), 24-byte stop records and 20-byte transit-edge records in `graph_binary.py`/`binary_reader.py`.

---

## 11.6 Runtime integration in web router
Estimated time: 2 hours

Tasks
- [x] Load transit tables in JS alongside existing road graph tables — `parseGraphBinary` parses stop/transit-edge tables into typed-array views, gated on `graph.header.nStops > 0` (zero-cost for every non-Berlin region).
- [x] Implement CSA pass using walking-reachable stops as seeds, then merge back into road Dijkstra via multi-source seeding — `runConnectionScanFromWalkingReachableStops` (pass 1 → CSA scan) feeds a new WASM `compute_travel_time_field_multi_source` export (pass 2, origin + transit-improved stops as seeds) in `runWalkingIsochroneFromSourceNode`.
- [x] Add query controls for departure time/day and transit enable/disable — a single `#departure-datetime` (`type="datetime-local"`) input constrained to the feed's actual calendar window, and a `Public transit` checkbox grouped alongside Walk/Bike/Car/Ferry in the "Transport modes" checkbox group (not a separate control), wired via `getTransitOptionsFromShell`/`updateTransitControlAvailability`.
- [x] Handle missing transit tables gracefully (road-only fallback without console noise) — `nStops === 0` (every non-Berlin region today) short-circuits to the unchanged single-pass walk/bike/car/ferry behavior, and the transit checkbox is hidden rather than shown-and-inert.

---

## 11.7 Multi-region onboarding process
Estimated time: 1 hour

Tasks
- [ ] Document repeatable onboarding steps for a new region: discover feed, validate licence, run adapters, run QA, export artifacts — not written up; today onboarding a second region means adding a `transitFeed` block to `regions.json` and rerunning `fetch|build --components graph,transit` by reading the code, not a doc.
- [x] Add one non-Berlin fixture dataset in tests to ensure region-agnostic behavior — `data_pipeline/tests/test_gtfs_transit.py` builds a small synthetic GTFS fixture (`_write_gtfs_fixture`) covering a normal day, a past-midnight trip, an out-of-extent stop, and a `calendar_dates.txt` exception; none of the pipeline unit tests depend on the real Berlin feed.
- [x] Add per-region attribution templating so required legal text is emitted in UI/export outputs — `#routing-disclaimer-transit` (VBB/CC BY line) is shown/hidden by `updateTransitControlAvailability` alongside the transit checkbox (`graph.header.nStops > 0`), and the SVG export's `copyrightNotice` reads both disclaimer elements' live text, combining them into one line only when the transit line isn't hidden.

---

# Phase 12 — Post-MVP: UX and Sharing Enhancements

*This phase was originally deferred. Based on user feedback, `12.6` (map zoom/pan) is now the next planned UX task; the rest remain lower-priority follow-up items.*

## 12.1 Clarify cyclic legend semantics
Estimated time: 45 min

Tasks
- [x] Update the legend so the final default band is explicitly shown as `45m-60m`, not `45m+`
- [x] Make cycle behavior explicit in UI copy (for example: "colours repeat every N minutes")
- [x] When the cycle duration changes, recompute and display all band endpoints so each range remains explicit within one cycle
- [x] Review and document the UX impact of uneven band widths (0-5, 5-15, 15-30, 30-45, 45-60) during looping and decide whether to keep or replace with even segmentation

Decision note: use equal-width segmentation across the cycle (five 20% bands) for predictable looping behavior and clearer legend interpretation.

## 12.2 Add theme support
Estimated time: 1 hour

Tasks
- [x] Add light mode / dark mode support
- [x] Persist user theme preference locally and restore on load

## 12.3 Export rendered result to SVG
Estimated time: 2 hours

Tasks
- [x] Add SVG export action for current rendered isochrone output
- [x] Ensure exported SVG preserves map extent, legend scale context, and boundary overlay alignment
- [x] Ensure exported SVG background matches current map/canvas background colour

## 12.4 Expose routability counts
Estimated time: 45 min

Tasks
- [ ] Display how many graph points from the dataset are routable for the current mode selection and start point
- [ ] Display both absolute count and percentage of total graph points

## 12.5 Persist last interaction in URL
Estimated time: 1 hour

Tasks
- [x] Write last selected start node ID to URL query parameters (`node=<graphNodeId>`) after successful routing
- [x] On page load, read `node` from URL and restore that start node if valid for current graph
- [x] Keep URL updates deterministic and bookmark/share safe (`history.replaceState`, preserve other params/hash)
- [x] Extend the same pattern to transport modes (`modes=`), colour cycle (`cycle=`), departure date+time (`departure=`), and walk/bike speed (`walkKph=`/`bikeKph=`) — `web/src/core/coords.js`'s `parse*FromLocationSearch`/`persist*ToLocation` pairs, applied on init and on each control's `change` event in `web/src/ui/orchestration.js`.

## 12.6 Add map zoom and pan controls
Estimated time: 4 hours

*Goal: add standard camera controls without conflating camera movement with origin selection. Routing remains world-space; pan/zoom must only change view state.*

### 12.6.1 Define camera model and transform boundaries
Estimated time: 45 min

Tasks
- [ ] Add explicit camera/view state: map center in world coordinates, zoom scale, min/max zoom, and viewport size.
- [x] Centralize screen-to-world and world-to-screen transforms so basemap, graph render, hit-testing, and scale bar use the same math.
- [x] Preserve projection correctness and aspect ratio under zoom; do not stretch the map independently in X/Y.
- [x] Clamp or damp pan/zoom so the user cannot lose the dataset entirely off-screen.

### 12.6.2 Re-separate camera movement from origin selection
Estimated time: 35 min

Tasks
- [ ] Replace map-wide drag-to-reroute behavior with distinct interaction rules: click/tap selects origin; camera gestures pan/zoom.
- [ ] Add a movement threshold so press-drag-release pans, while click/tap without meaningful movement selects a new origin.
- [x] Keep re-routing tied to completed origin selection, not camera movement.
- [ ] Reserve origin-marker drag as an optional later enhancement instead of overloading whole-map drag.

### 12.6.3 Desktop/laptop gesture plan
Estimated time: 55 min

Tasks
- [x] Mouse/trackpad scroll (`wheel`) zooms in/out around the pointer position, so the location under the cursor stays visually anchored.
- [ ] Primary-button drag pans the map; update cursor affordances (`grab`/`grabbing`) to make the mode obvious.
- [x] Single click selects a new origin only if no pan gesture was recognized.
- [ ] Confirm behavior on both physical mouse wheels and laptop trackpads that surface pinch/scroll as wheel events.

### 12.6.4 Mobile/tablet gesture plan
Estimated time: 55 min

Tasks
- [x] Single tap selects a new origin.
- [ ] Two-finger pinch zooms around the gesture centroid.
- [ ] Two-finger drag pans the map without selecting a new origin.
- [x] Lock page scrolling/viewport movement during active map gestures (`touch-action` / pointer-event handling), while leaving top/bottom bars usable.

### 12.6.5 Rendering and UI integration
Estimated time: 30 min

Tasks
- [ ] Apply the camera transform consistently to district boundaries, graph edges/nodes, origin marker, and any future transit overlays.
- [x] Keep UI chrome (top bar, bottom bar, legend, transport controls) in screen space; only the map canvas content moves.
- [x] Recompute distance scale bar from current zoom level so it remains truthful after pan/zoom changes.
- [x] Ensure zoom/pan redraws reuse the current routing snapshot and never trigger a fresh route solve.

### 12.6.6 State persistence, tests, and verification
Estimated time: 20 min

Tasks
- [ ] Add automated tests for camera transforms, click-vs-pan threshold logic, and pinch centroid math.
- [ ] Add manual verification checklist for desktop mouse, desktop trackpad, iPad touch, and mobile Safari/Chrome.
- [ ] Decide whether camera state should also become URL-shareable (`x`, `y`, `z`) after the interaction model is stable; do not bundle that into the first implementation step.

## 12.7 Configurable walk/bike speeds
*Not in the original plan — added from user feedback ("we should probably also add walking/cycling speed options").*
Estimated time: 2 hours

Tasks
- [x] Add walk-speed/bike-speed (km/h) inputs in a collapsed `<details>` sub-section of the options panel, since they're rarely changed — `#speed-settings` in `web/index.html`.
- [x] Thread the configured speeds through both routing kernels — new `walking_speed_m_s`/`bike_cruise_speed_kph` params on the Rust `precompute_edge_costs` export (`wasm/routing-kernel/src/lib.rs`) and the JS reference implementation (`computeEdgeTraversalCostSeconds` in `web/src/core/routing.js`); the walk-mode cost is rescaled by the user's speed relative to the graph's build-time `WALKING_SPEED_M_S` (the speed the data pipeline assumed when it baked `walking_cost_seconds` from real edge geometry), not the other way round — only the walk/bike cost derivations change, ferry/car costs are unaffected.
- [x] Key the per-mode edge-cost cache on `(allowedModeMask, walkingSpeedMps, bikeCruiseSpeedKph)`, not just the mode mask, so a speed change can't silently reuse a stale precomputed cost array for the same mode.
- [x] Apply the configured walk speed to the CSA walk-attach-cost estimate too (`runConnectionScanFromWalkingReachableStops` in `web/src/app.js`), for consistency between the routing kernel and the transit-stop-attachment estimate.
- [x] Persist both values to the URL (see 12.5).

## 12.8 Single departure date+time control, and Public transit grouped with Transport modes
*Not in the original plan — added from user feedback questioning the departure-time UX and asking "is transit as much a movement mode as ferries?".*
Estimated time: 1.5 hours

Tasks
- [x] Merge the separate departure-date and departure-time inputs into one `<input type="datetime-local">` (`#departure-datetime`) — the date input previously had no `change` listener at all, so changing the date silently left the isochrone stale; a single input with one listener fixes that structurally rather than by remembering to wire a second listener.
- [x] Default the input to "now" clamped into the feed's calendar window, but preserve an existing value (e.g. restored from the URL) when it's already in range.
- [x] Convert "Transport modes" from a `<select multiple>` to a checkbox fieldset (Walk/Bike/Car/Ferry), and fold the previously-separate "Public transit" checkbox into the same group as a peer, since a normal user has no reason to think of transit as different in kind from the others.
- [x] Keep Public transit's checked state out of the routing `allowedModeMask` computation (it's a boolean CSA-augmentation flag, not an edge-mode bit) while still including it in the shared URL-persisted checkbox-group state (see 12.5) — `getAllowedModeMaskFromShell`'s mask loop and "nothing selected" fallback in `web/src/ui/orchestration.js` explicitly filter it out.

---

# Architectural Notes

## On Web Workers (point 7)
Web Workers are **not planned** at any phase. The routing loop is time-sliced via `requestAnimationFrame` (Phase 7.2), which gives adequate UI responsiveness without the complexity of cross-thread `ArrayBuffer` transfer, Worker lifecycle management, or the risk of needing `SharedArrayBuffer` (which requires specific COOP/COEP HTTP headers). If profiling after Phase 8 reveals that even 8 ms slices cause dropped frames (unlikely on a modern device for a 30-min isochrone), a Worker can be added then — but there is no basis for scheduling that work now.

## On future region support
The pipeline is parameterised from Phase 3.2 onward: `--epsg`, `--input`, `--output` flags on all pipeline scripts. The binary header stores the EPSG code so the JS client knows which projection was used. As of Phase 10.6, the actual way to add a region is `data_pipeline/regions.json` (one entry: relation selector, EPSG, admin level) plus `./data_pipeline/region-data.py fetch|build --only <id>` — see `docs/region-data-pipeline.md` for the full onboarding walkthrough. Optionally add a transit feed (GTFS static/GTFS-RT first, with NeTEx/SIRI adapters planned in Phase 11). No code changes are needed for regions using any UTM zone or national grid projection supported by `pyproj`.

---

# Total Estimated Development Time (MVP: Phases 1–10)

| Phase | Description | Estimated Time |
|-------|-------------|----------------|
| 1 | Project setup + vanilla JS runtime | 2 h |
| 2 | Data exploration + schema design + writer | 2.5 h |
| 3 | OSM extraction + graph build | 4.5 h |
| 4 | Binary export + validation | 1.25 h |
| 5 | Web client shell + boundary basemap + loader | 2.5 h |
| 6 | Pixel grid + canvas rendering | 1.75 h |
| 7 | Progress indication | 1.25 h |
| 8 | Routing engine | 2.5 h |
| 9 | Map interaction | 1.5 h |
| 10 | Build + deploy | 1.25 h |

**MVP total: ~21 hours for a junior developer**

Post-MVP adds approximately **36–40 hours** of development:
- [x] Phase 10.4 (multimodal road schema + extraction): ~4.5 hours
- [x] Phase 10.5 (routing hot-path performance follow-ups): ~2.5 hours (10.5.1 parallel SSSP sub-item still not implemented)
- [x] Phase 10.6 (multi-location OSM fetch generalization): ~3.75 hours (shipped as `regions.json` + `region-data.py`, different file layout than originally planned — see 10.6 note)
- [x] Phase 10.7 (basemap context layers: coastal water, forest, inland water, waterways, airports): ~6 hours — not in the original plan, added from user feedback
- [x] Phase 10.8 (water/ferry transport mode, incl. the grid-budget ferry filter and boundary-fit viewport): ~4 hours — not in the original plan, added from user feedback
- [x] Phase 11 (global public transit pipeline): ~12.25 hours (11.2.1/11.5/11.6 done for a Berlin-only GTFS-static pilot; 11.1/11.2.2/11.2.3/11.7 and full canonical-model/QA-gate fidelity in 11.3/11.4 stay deferred — see per-section notes)
- [ ] Phase 12 (UX and sharing enhancements): ~13 hours (12.1/12.2/12.3/12.5/12.7/12.8 done; 12.4 and most of 12.6 still open)
- [ ] Plus variable time to obtain/validate feed licences and feed-specific integration constraints.

---

# Expected Outputs

## MVP artifacts
- `berlin_graph.bin.gz` — compressed walking-only binary graph
- `/data_pipeline/input/berlin-routing.osm.json` — Overpass JSON extract for Berlin routing build
- `/data_pipeline/output/berlin-district-boundaries-canvas.json` — simplified boundary basemap JSON
- `/docs/berlin_district_boundaries_query.ql` — Overpass query for Berlin district boundaries (superseded by the generalized `docs/overpass_boundary_query.sh` in Phase 10.6)
- `/web/index.html`
- `/web/src/app.js` — vanilla JS module entrypoint
- `/data_pipeline/` — Python pipeline scripts

## Post-MVP additions
- `berlin_graph.bin.gz` schema v2 with per-edge mode mask + speed metadata (bike/car/walk support)
- Pipeline summaries for speed/access coverage and mode-specific edge counts
- Region registry (`data_pipeline/regions.json`, one array, not per-file manifests) and `region-data.py` CLI (`fetch`/`build`/`all`) that renders location-agnostic Overpass queries per region
- Per-region OSM input/output layout: `data_pipeline/input/<id>-routing.osm.json` / `<id>-district-boundaries.osm.json`, `data_pipeline/output/<id>-graph.bin(.gz)` / `<id>-district-boundaries-canvas.json` (flat, slug-prefixed — not the nested `<slug>/...` directories originally planned); Berlin keeps its legacy `graph-walk.bin(.gz)` filenames as a compatibility alias
- Optional coastal sea-water context (`--include-coast`, opt-in per region because of a ~900 MB external download, cached locally after first use)
- Always-on forest/inland-water/waterway/airport basemap context for every region, including multipolygon-relation support for water bodies and airports (ways-only for forest/wood)
- Canonical transit snapshots (`stops/routes/trips/connections/services/transfers`) independent of source format
- Transit-enabled graph export with populated stop/connection tables
- CSA runtime module and source-adapter pipeline (`GTFS`, `GTFS-RT`, `NeTEx`, `SIRI` scaffold)
- Ferry/water routing: a fourth `Water` edge mode mask bit through the full pipeline (extraction, adjacency, WASM/JS routing kernels), grid-size-budgeted ferry inclusion, and a boundary-fit default viewport decoupled from the full (ferry-widened) routing grid
- User-configurable walk/bike speeds (collapsed sub-menu), a single departure date+time control, and Public transit grouped as a checkbox alongside Walk/Bike/Car/Ferry — all persisted to the URL alongside the pre-existing `node`/`modes`/`cycle` params

---

## Note On Public Polygons
Public polygons (parks, greens, woods, recreation areas) are useful for context and optional future area-aware routing, but movement inside them is neither always free nor always represented by dense internal paths. Densely wooded and otherwise inaccessible sub-areas exist; in other cases only sparse walkable tracks are mapped. The routing model must therefore treat polygon-level walkability as conditional and constrained, not uniformly traversable.

*Realized (partially) in Phase 10.7:* forest and airport polygons are now rendered as basemap context (see 10.7.2). This is rendering-only — the caveat above still holds in full: neither forest interiors nor airport grounds ("mostly, but not entirely, non-reachable") feed into the routing graph or edge costs in any way.

---

## Final Verification (Run At End)
- [ ] Verify `Content-Encoding: gzip` is being served correctly in deployed environment (check DevTools Network tab)
