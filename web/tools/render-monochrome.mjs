// Renders a region's monochrome isochrone to SVG, for looking at.
//
// This calls buildMonochromeScreenSvg - the same function the app calls - so
// what comes out is what the browser draws, at whatever size is asked for.
// An earlier version of this tool had its own copy of the pipeline and its own
// idea of how to place the coastline, and put the sea kilometres from the
// roads. One implementation, exercised two ways, is the point.
//
// Rasterise the output and look at it at 1:1. Reviewing SVG in a viewport that
// downscales it has hidden, in turn, a pattern that was never drawn, ferries
// masquerading as roads, and a basemap in the wrong place:
//
//   node web/tools/render-monochrome.mjs portsmouth 48 2 out.svg 1500
//   rsvg-convert -w 1500 -b white out.svg -o out.png
//
// Arguments: region, cycleMinutes, patternCount, outputPath, widthPx.
// RUNGS=0,1 picks ladder rungs explicitly; SPAN sets the triangle span limit
// in metres.
//
// The routing here is a stand-in: the real one needs the WASM kernel and a
// DOM. Everything downstream of the travel times is the code the browser runs.

import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const R = `${ROOT}/web/src`;
const { parseGraphBinary } = await import(`${R}/core/graph-binary.js`);
const { computeEdgeTraversalCostSeconds } = await import(`${R}/core/routing.js`);
const { projectBoundaryBasemapToGraphPaths } = await import(`${R}/core/boundary-basemap.js`);
const { buildMonochromeScreenSvg } = await import(`${R}/render/monochrome-screen.js`);
const { HATCH_PATTERN_LADDER, selectHatchPatterns } = await import(`${R}/render/hatch.js`);
const { EDGE_MODE_WALK_BIT } = await import(`${R}/config/constants.js`);

const region = process.argv[2] ?? 'portsmouth';
const cycleMinutes = Number(process.argv[3] ?? 48);
const patternCount = Number(process.argv[4] ?? 2);
const outputPath = process.argv[5] ?? `${ROOT}/monochrome-${region}.svg`;
const widthPx = Number(process.argv[6] ?? 1500);

const graphFile = region === 'berlin' ? 'graph-walk.bin.gz' : `${region}-graph.bin.gz`;
const buffer = gunzipSync(readFileSync(`${ROOT}/data_pipeline/output/${graphFile}`));
const graph = parseGraphBinary(
  buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
);
const header = graph.header;
console.log(`${region}: ${header.nNodes} nodes, ${header.nEdges} edges`);

const walkingSpeedMps = 4 / 3.6;
const edgeCost = new Float32Array(header.nEdges);
for (let edgeIndex = 0; edgeIndex < header.nEdges; edgeIndex += 1) {
  edgeCost[edgeIndex] = computeEdgeTraversalCostSeconds(
    graph, edgeIndex, EDGE_MODE_WALK_BIT, { walkingSpeedMps },
  );
}

// Node pixels exactly as the app builds them: graph metres over the pixel size.
const nodePixelX = new Uint16Array(header.nNodes);
const nodePixelY = new Uint16Array(header.nNodes);
const maxYPx = header.gridHeightPx - 1;
for (let index = 0; index < header.nNodes; index += 1) {
  nodePixelX[index] = Math.round(graph.nodeI32[index * 4] / header.pixelSizeM);
  nodePixelY[index] = Math.round(maxYPx - graph.nodeI32[index * 4 + 1] / header.pixelSizeM);
}

function dijkstra(source) {
  // Float64: the heap holds full-precision keys, so a Float32 distance array
  // rounds on store and the staleness check then rejects almost every node.
  const dist = new Float64Array(header.nNodes).fill(Infinity);
  const heap = [];
  const push = (node, d) => {
    heap.push([d, node]);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heap[parent][0] <= heap[i][0]) break;
      [heap[parent], heap[i]] = [heap[i], heap[parent]];
      i = parent;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let smallest = i;
        if (l < heap.length && heap[l][0] < heap[smallest][0]) smallest = l;
        if (r < heap.length && heap[r][0] < heap[smallest][0]) smallest = r;
        if (smallest === i) break;
        [heap[smallest], heap[i]] = [heap[i], heap[smallest]];
        i = smallest;
      }
    }
    return top;
  };
  dist[source] = 0;
  push(source, 0);
  while (heap.length) {
    const [d, u] = pop();
    if (d > dist[u]) continue;
    const first = graph.nodeU32[u * 4 + 2];
    const count = graph.nodeU16[u * 8 + 6];
    for (let e = first; e < first + count; e += 1) {
      const cost = edgeCost[e];
      if (!Number.isFinite(cost) || cost <= 0) continue;
      const v = graph.edgeU32[e * 3];
      const next = d + cost;
      if (next < dist[v]) { dist[v] = next; push(v, next); }
    }
  }
  return dist;
}

// The nearest node to the centre is not a safe origin: for a harbour city that
// is water, and the nearest node to it sits on an isolated fragment. Flood
// first, then take the node in the big component nearest the middle.
const flood = (seed) => {
  const seen = new Uint8Array(header.nNodes);
  const stack = [seed];
  seen[seed] = 1;
  const members = [];
  while (stack.length) {
    const u = stack.pop();
    members.push(u);
    const first = graph.nodeU32[u * 4 + 2];
    const count = graph.nodeU16[u * 8 + 6];
    for (let e = first; e < first + count; e += 1) {
      const v = graph.edgeU32[e * 3];
      if (!seen[v] && Number.isFinite(edgeCost[e]) && edgeCost[e] > 0) { seen[v] = 1; stack.push(v); }
    }
  }
  return members;
};
let component = [];
const stride = Math.max(1, (header.nNodes / 200) | 0);
for (let seed = 0; seed < header.nNodes && component.length < header.nNodes * 0.4; seed += stride) {
  const members = flood(seed);
  if (members.length > component.length) component = members;
}
const midX = header.gridWidthPx / 2;
const midY = header.gridHeightPx / 2;
component.sort((a, b) =>
  Math.hypot(nodePixelX[a] - midX, nodePixelY[a] - midY)
  - Math.hypot(nodePixelX[b] - midX, nodePixelY[b] - midY));
const origin = component[0];
const distSeconds = dijkstra(origin);
console.log(`origin node ${origin}, component ${component.length}/${header.nNodes} nodes`);

let projectedBoundary = null;
try {
  const payload = JSON.parse(readFileSync(
    `${ROOT}/data_pipeline/output/${region}-district-boundaries-canvas.json`, 'utf8'));
  projectedBoundary = projectBoundaryBasemapToGraphPaths(payload, header);
} catch (error) {
  console.log('no boundary payload:', error.message);
}

const heightPx = Math.round(widthPx * (header.gridHeightPx / header.gridWidthPx));
// Left undefined unless asked for, so the tool renders with whatever the app
// itself would choose rather than a second opinion about it.
const patterns = process.env.RUNGS
  ? process.env.RUNGS.split(',').map((index) => HATCH_PATTERN_LADDER[Number(index)])
  : (patternCount === 2 ? undefined : selectHatchPatterns(patternCount));

const startedMs = performance.now();
const svg = buildMonochromeScreenSvg(
  { graph, nodePixels: { nodePixelX, nodePixelY }, projectedBoundary },
  { distSeconds },
  {
    widthPx,
    heightPx,
    allowedModeMask: EDGE_MODE_WALK_BIT,
    cycleMinutes,
    patterns,
    projectedBoundary,
    labelFontSize: Math.max(11, Math.round(widthPx / 110)),
    maxTriangleSpanM: Number(process.env.SPAN ?? 300),
  },
);
console.log(`rendered ${widthPx}x${heightPx} in ${(performance.now() - startedMs).toFixed(0)} ms`);
if (svg === null) {
  console.log('nothing reachable to draw');
} else {
  writeFileSync(outputPath, svg);
  console.log(`wrote ${outputPath} (${(svg.length / 1024).toFixed(0)} KB)`);
}
