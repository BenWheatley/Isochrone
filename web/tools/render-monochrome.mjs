// Renders a region's monochrome isochrone to SVG, for looking at.
//
// Monochrome has no UI yet, so this is the only way to see it - and "look at
// the real output" has already proven to be not optional here. Inspecting the
// SVG in a browser pane that downscales to a thumbnail hid a pattern that was
// never drawn at all, ferry routes masquerading as roads, and a coastline
// kilometres away from the roads it describes. Rasterise what this writes and
// look at it at 1:1:
//
//   node web/tools/render-monochrome.mjs portsmouth 48 10 2 144 out.svg 17 1.4
//   rsvg-convert -w 1500 -b white out.svg -o out.png
//
// Arguments: region, cycleMinutes, dilatePasses, patternCount, maxMinutes,
// outputPath, labelFontSize, patternScale. RUNGS=0,1 picks ladder rungs
// explicitly; OUT_W sets the raster width.
//
// The projection and the edge rasteriser are the production ones on purpose.
// The Dijkstra below is not: the real one needs the WASM kernel and a DOM, so
// this stands in for it, and is the one piece here that is not the code the
// browser runs.

import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
const ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const R = `${ROOT}/web/src`;
const { parseGraphBinary } = await import(`${R}/core/graph-binary.js`);
const { computeEdgeTraversalCostSeconds } = await import(`${R}/core/routing.js`);
const { createTravelTimeGrid, clearTravelTimeGrid, setTravelTimePixelMin } =
  await import(`${R}/render/pixel-grid.js`);
const { paintAllReachableEdgeInterpolationsToTravelTimeGrid } =
  await import(`${R}/render/edge-painting.js`);
const { extractContourRings } = await import(`${R}/render/contour.js`);
const { HATCH_PATTERN_LADDER, selectHatchPatterns, timeToFillPattern } = await import(`${R}/render/hatch.js`);
const { EDGE_MODE_WATER_BIT } = await import(`${R}/config/constants.js`);
const { projectBoundaryBasemapToGraphPaths } = await import(`${R}/core/boundary-basemap.js`);
const { buildMonochromeIsochroneSvg } = await import(`${R}/export/monochrome-svg.js`);
const { EDGE_MODE_WALK_BIT } = await import(`${R}/config/constants.js`);

const region = process.argv[2] ?? 'portsmouth';
const file = region === 'berlin' ? 'graph-walk.bin.gz' : `${region}-graph.bin.gz`;
const buf = gunzipSync(readFileSync(`${ROOT}/data_pipeline/output/${file}`));
const g = parseGraphBinary(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const h = g.header;
console.log(`${region}: ${h.nNodes} nodes, ${h.nEdges} edges`);

const walkSpeed = 4 / 3.6;
const cost = new Float32Array(h.nEdges);
for (let e = 0; e < h.nEdges; e += 1) {
  cost[e] = computeEdgeTraversalCostSeconds(g, e, EDGE_MODE_WALK_BIT, { walkingSpeedMps: walkSpeed });
}

// Fit the graph into the output raster.
let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
for (let i = 0; i < h.nNodes; i += 1) {
  const x = g.nodeI32[i * 4], y = g.nodeI32[i * 4 + 1];
  if (x < minX) minX = x; if (x > maxX) maxX = x;
  if (y < minY) minY = y; if (y > maxY) maxY = y;
}
const OUT_W = Number(process.env.OUT_W ?? 1100);
const scale = OUT_W / (maxX - minX);
const OUT_H = Math.round((maxY - minY) * scale);
// The raster is a transient rendering intermediate sized to the output, then
// thrown away - never a persistent graph-sized buffer.
const nodePixelX = new Uint16Array(h.nNodes);
const nodePixelY = new Uint16Array(h.nNodes);
for (let i = 0; i < h.nNodes; i += 1) {
  nodePixelX[i] = Math.round((g.nodeI32[i * 4] - minX) * scale);
  // Northings increase upward; raster rows increase downward.
  nodePixelY[i] = Math.round((maxY - g.nodeI32[i * 4 + 1]) * scale);
}
console.log(`raster ${OUT_W}x${OUT_H}`);

// The nearest node to the centre of the extent is not a safe origin: for a
// harbour city that centre is water, and the nearest node to it sits on an
// isolated fragment. OSM leaves plenty of those - Portsmouth's largest
// forward-reachable set is 61% of its nodes, Berlin's 84%. So find the big
// component first, then take the node in it nearest the centre.
const cX = (minX + maxX) / 2, cY = (minY + maxY) / 2;
function floodFrom(seed) {
  const seen = new Uint8Array(h.nNodes);
  const stack = [seed];
  seen[seed] = 1;
  const members = [];
  while (stack.length) {
    const u = stack.pop();
    members.push(u);
    const first = g.nodeU32[u * 4 + 2], count = g.nodeU16[u * 8 + 6];
    for (let e = first; e < first + count; e += 1) {
      const v = g.edgeU32[e * 3];
      if (!seen[v] && Number.isFinite(cost[e]) && cost[e] > 0) { seen[v] = 1; stack.push(v); }
    }
  }
  return members;
}
let component = [];
for (let seed = 0; seed < h.nNodes && component.length < h.nNodes * 0.4; seed += Math.max(1, (h.nNodes / 200) | 0)) {
  const members = floodFrom(seed);
  if (members.length > component.length) component = members;
}
console.log(`largest component ${component.length}/${h.nNodes} nodes`);
const candidates = component
  .sort((a, b) =>
    Math.hypot(g.nodeI32[a*4]-cX, g.nodeI32[a*4+1]-cY) - Math.hypot(g.nodeI32[b*4]-cX, g.nodeI32[b*4+1]-cY))
  .slice(0, 5);

function dijkstra(source) {
  // Float64, not Float32: the heap holds full-precision keys, so a Float32
  // distance array rounds on store and the `d > dist[u]` staleness check then
  // rejects almost every node the moment it is popped.
  const dist = new Float64Array(h.nNodes).fill(Infinity);
  const heap = [];
  const push = (n, d) => { heap.push([d, n]); let i = heap.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0]; const last = heap.pop();
    if (heap.length) { heap[0] = last; let i = 0;
      for (;;) { const l = 2*i+1, r = l+1; let s = i;
        if (l < heap.length && heap[l][0] < heap[s][0]) s = l;
        if (r < heap.length && heap[r][0] < heap[s][0]) s = r;
        if (s === i) break; [heap[s], heap[i]] = [heap[i], heap[s]]; i = s; } }
    return top; };
  dist[source] = 0; push(source, 0);
  while (heap.length) {
    const [d, u] = pop();
    if (d > dist[u]) continue;
    const first = g.nodeU32[u * 4 + 2], count = g.nodeU16[u * 8 + 6];
    for (let e = first; e < first + count; e += 1) {
      const c = cost[e];
      if (!Number.isFinite(c) || c <= 0) continue;
      const v = g.edgeU32[e * 3], nd = d + c;
      if (nd < dist[v]) { dist[v] = nd; push(v, nd); }
    }
  }
  return dist;
}
let origin = candidates[0];
let distSeconds = null;
for (const candidate of candidates) {
  const attempt = dijkstra(candidate);
  let finite = 0;
  for (let i = 0; i < attempt.length; i += 1) if (Number.isFinite(attempt[i])) finite += 1;
  if (finite > component.length * 0.5) { origin = candidate; distSeconds = attempt;
    console.log(`origin node ${candidate}, reaches ${finite}/${h.nNodes} nodes`); break; }
}
if (distSeconds === null) throw new Error('no candidate origin reached a usable share of the graph');

const grid = createTravelTimeGrid(OUT_W, OUT_H);
clearTravelTimeGrid(grid);
const painted = paintAllReachableEdgeInterpolationsToTravelTimeGrid(
  grid, g, { nodePixelX, nodePixelY }, distSeconds, EDGE_MODE_WALK_BIT,
  { edgeTraversalCostSeconds: cost, stepStride: 1 },
);
console.log(`painted ${painted} edges`);

// The grid marks "no data" as -1, which would read as a very low travel time.
const field = new Float32Array(OUT_W * OUT_H);
let reached = 0;
for (let i = 0; i < field.length; i += 1) {
  const s = grid.seconds[i];
  field[i] = s < 0 ? Number.POSITIVE_INFINITY : (reached += 1, s);
}
console.log(`${reached} reachable cells (${(100*reached/field.length).toFixed(1)}%)`);

// Dilate slightly: the painted edges are one cell wide, so contouring them raw
// traces every individual road rather than the region they enclose.
const DILATE = Number(process.argv[4] ?? 6);
const smooth = Float32Array.from(field);
for (let pass = 0; pass < DILATE; pass += 1) {
  const src = Float32Array.from(smooth);
  for (let y = 1; y < OUT_H - 1; y += 1) {
    for (let x = 1; x < OUT_W - 1; x += 1) {
      const i = y * OUT_W + x;
      let best = src[i];
      for (const j of [i-1, i+1, i-OUT_W, i+OUT_W]) if (src[j] < best) best = src[j];
      smooth[i] = best;
    }
  }
}

const cycleMinutes = Number(process.argv[3] ?? 30);
const patternCount = Number(process.argv[5] ?? 5);
const patterns = process.env.RUNGS
  ? process.env.RUNGS.split(',').map((index) => HATCH_PATTERN_LADDER[Number(index)])
  : selectHatchPatterns(patternCount);
const bandMinutes = cycleMinutes / patternCount;
const maxMinutes = Number(process.argv[6] ?? 120);
const thresholds = [];
for (let m = bandMinutes; m <= maxMinutes + 1e-9; m += bandMinutes) thresholds.push(m * 60);

const t0 = performance.now();
const contours = extractContourRings(smooth, { width: OUT_W, height: OUT_H, thresholds });
console.log(`contours: ${(performance.now()-t0).toFixed(0)} ms, rings per band:`,
  contours.map(c => c.rings.length).join(','));

const fmt = (minutes) => minutes < 60
  ? `${Math.round(minutes)} min`
  : (minutes % 60 === 0 ? `${minutes/60} h` : `${Math.floor(minutes/60)} h ${Math.round(minutes%60)}`);
const bands = contours.map((c, i) => ({
  threshold: c.threshold,
  rings: c.rings,
  label: fmt(c.threshold / 60),
  pattern: timeToFillPattern(Math.max(0, c.threshold - 1), { cycleMinutes, patterns }),
  isLimit: i === contours.length - 1,
}));

// Roads: every graph edge, once, as a segment in raster coordinates. This is
// what tells the reader where they are.
const seenEdge = new Set();
const roadList = [];
for (let u = 0; u < h.nNodes; u += 1) {
  const first = g.nodeU32[u * 4 + 2], count = g.nodeU16[u * 8 + 6];
  for (let e = first; e < first + count; e += 1) {
    const v = g.edgeU32[e * 3];
    if (v >= h.nNodes) continue;
    // Ferries are not roads. Drawn as one they are long straight lines
    // striking out across the sea and off the sheet - Portsmouth's run to the
    // Isle of Wight - which is worse than useless as orientation.
    if ((g.edgeModeMask[e] & EDGE_MODE_WATER_BIT) !== 0) continue;
    const key = u < v ? u * 1e7 + v : v * 1e7 + u;
    if (seenEdge.has(key)) continue;
    seenEdge.add(key);
    roadList.push(nodePixelX[u], nodePixelY[u], nodePixelX[v], nodePixelY[v]);
  }
}
console.log(`roads: ${roadList.length / 4} segments`);

// Coastline and inland water, in the same raster coordinates as everything
// else. The boundary payload is in its own canvas space, so it is rescaled by
// the ratio of the two extents rather than assumed to match.
let waterFeatures = [];
try {
  const boundaryName = region === 'berlin' ? 'berlin' : region;
  const payload = JSON.parse(readFileSync(
    `${ROOT}/data_pipeline/output/${boundaryName}-district-boundaries-canvas.json`, 'utf8'));
  // Through the app's own projection, not an ad-hoc rescale. The boundary
  // payload carries its own projected origin and extent, which are not the
  // graph's: for Portsmouth the two origins differ by 2.4 km east and 14.2 km
  // north, and the extents by a factor of 1.23. Stretching one onto the other
  // puts the coastline kilometres from the roads it is supposed to describe.
  const projected = projectBoundaryBasemapToGraphPaths(payload, h);
  // Graph pixels back to the metre offsets the node coordinates use, so the
  // basemap and the isochrone go through one and the same raster transform.
  const maxYPx = h.gridHeightPx - 1;
  const toGraphMetres = (features) => (features ?? []).map((f) => ({
    paths: f.paths.map((path) => path.map(([xPx, yPx]) =>
      [xPx * h.pixelSizeM, (maxYPx - yPx) * h.pixelSizeM])),
  }));
  waterFeatures = [
    ...toGraphMetres(projected.waterFeatures),
    ...toGraphMetres(projected.inlandWaterFeatures),
  ];
  console.log(`water features: ${waterFeatures.length}`);
} catch (error) {
  console.log('no boundary payload:', error.message);
}

// The single graph-metres -> raster transform. Nodes are converted eagerly
// (the painter needs integer pixels); the basemap goes through the same
// mapping at draw time.
const graphMetresToRaster = (xM, yM) => [(xM - minX) * scale, (maxY - yM) * scale];

const svg = buildMonochromeIsochroneSvg({
  widthPx: OUT_W, heightPx: OUT_H, bands,
  labelFontSize: Number(process.argv[8] ?? 12),
  contourStrokeWidth: 0.9,
  patternScale: Number(process.argv[9] ?? 1),
  legendCaption: `${region} on foot, patterns repeat every ${cycleMinutes} min`,
  roadStrokeWidth: Number(process.env.ROAD_WIDTH ?? 0.35),
  basemap: {
    waterFeatures: waterFeatures.map((f) => ({
      paths: f.paths.map((path) => path.map(([xM, yM]) => graphMetresToRaster(xM, yM))),
    })),
    roadSegments: Float64Array.from(roadList),
  },
});
const out = process.argv[7] ?? `/private/tmp/claude-501/-Users-benwheatley-Documents-Code-Isochrone/d73a6e13-0a21-42b9-a6cb-708f1fe14608/scratchpad/monochrome-${region}.svg`;
writeFileSync(out, svg);
console.log(`wrote ${out} (${(svg.length/1024).toFixed(0)} KB)`);
console.log('bands:', bands.map(b => `${b.label}=${b.pattern.id.replace('mono-','')}`).join(' '));
