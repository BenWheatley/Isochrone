// Delaunay triangulation of the graph's nodes.
//
// An isochrone is computed on the road network, so the routing result is times
// at points, not an area. Turning that into fillable regions needs some
// construction, and the two candidates are a raster or a triangulation.
//
// A raster costs a cell size - an arbitrary length that has to be re-chosen
// for every output resolution, and that makes the drawing resolution-dependent
// for something that should be vector all the way. A triangulation costs
// nothing of the sort: the nodes are the vertices, and the result is the same
// polygons whether they are drawn 300 pixels wide or 5000.
//
// Delaunay specifically, rather than any triangulation, because it maximises
// the minimum angle. That is what makes "this triangle spans a gap rather than
// covering ground" a judgement worth making: a river, a railway or the edge of
// the network shows up as a long thin triangle, and a city block does not.
//
// The algorithm is the standard sweep-hull: seed from a small triangle, sort by
// distance from its circumcentre, and add points one at a time, walking the
// convex hull and legalising by edge flip.

const EPSILON = 2 ** -52;
const EDGE_STACK = new Uint32Array(512);

function orient2d(ax, ay, bx, by, cx, cy) {
  return (ay - cy) * (bx - cx) - (ax - cx) * (by - cy);
}

function inCircle(ax, ay, bx, by, cx, cy, px, py) {
  const dx = ax - px;
  const dy = ay - py;
  const ex = bx - px;
  const ey = by - py;
  const fx = cx - px;
  const fy = cy - py;
  const ap = dx * dx + dy * dy;
  const bp = ex * ex + ey * ey;
  const cp = fx * fx + fy * fy;
  return (
    dx * (ey * cp - bp * fy)
    - dy * (ex * cp - bp * fx)
    + ap * (ex * fy - ey * fx)
  ) < 0;
}

function circumradiusSquared(ax, ay, bx, by, cx, cy) {
  const dx = bx - ax;
  const dy = by - ay;
  const ex = cx - ax;
  const ey = cy - ay;
  const bl = dx * dx + dy * dy;
  const cl = ex * ex + ey * ey;
  const d = 0.5 / (dx * ey - dy * ex);
  const x = (ey * bl - dy * cl) * d;
  const y = (dx * cl - ex * bl) * d;
  return x * x + y * y;
}

function circumcentre(ax, ay, bx, by, cx, cy) {
  const dx = bx - ax;
  const dy = by - ay;
  const ex = cx - ax;
  const ey = cy - ay;
  const bl = dx * dx + dy * dy;
  const cl = ex * ex + ey * ey;
  const d = 0.5 / (dx * ey - dy * ex);
  return [ax + (ey * bl - dy * cl) * d, ay + (dx * cl - ex * bl) * d];
}

function quicksort(ids, dists, left, right) {
  if (right - left <= 20) {
    for (let i = left + 1; i <= right; i += 1) {
      const temp = ids[i];
      const tempDist = dists[temp];
      let j = i - 1;
      while (j >= left && dists[ids[j]] > tempDist) {
        ids[j + 1] = ids[j];
        j -= 1;
      }
      ids[j + 1] = temp;
    }
    return;
  }
  const median = (left + right) >> 1;
  let i = left + 1;
  let j = right;
  swap(ids, median, i);
  if (dists[ids[left]] > dists[ids[right]]) swap(ids, left, right);
  if (dists[ids[i]] > dists[ids[right]]) swap(ids, i, right);
  if (dists[ids[left]] > dists[ids[i]]) swap(ids, left, i);

  const temp = ids[i];
  const tempDist = dists[temp];
  for (;;) {
    do { i += 1; } while (dists[ids[i]] < tempDist);
    do { j -= 1; } while (dists[ids[j]] > tempDist);
    if (j < i) break;
    swap(ids, i, j);
  }
  ids[left + 1] = ids[j];
  ids[j] = temp;

  if (right - i + 1 >= j - left) {
    quicksort(ids, dists, i, right);
    quicksort(ids, dists, left, j - 1);
  } else {
    quicksort(ids, dists, left, j - 1);
    quicksort(ids, dists, i, right);
  }
}

function swap(array, i, j) {
  const temp = array[i];
  array[i] = array[j];
  array[j] = temp;
}

/**
 * Triangulates the points given as a flat [x0, y0, x1, y1, ...] array.
 *
 * Returns `triangles` - three point indices per triangle - and `halfedges`,
 * where halfedges[e] is the opposing half-edge of e, or -1 on the hull. That
 * adjacency is what later lets same-band triangles be merged by dropping
 * shared edges, with no geometry involved at all.
 */
export function triangulate(coords) {
  const n = coords.length >> 1;
  if (n < 3) {
    return { triangles: new Uint32Array(0), halfedges: new Int32Array(0), coords };
  }

  const maxTriangles = Math.max(2 * n - 5, 0);
  const triangles = new Uint32Array(maxTriangles * 3);
  const halfedges = new Int32Array(maxTriangles * 3);
  const hashSize = Math.ceil(Math.sqrt(n));
  const hullPrev = new Uint32Array(n);
  const hullNext = new Uint32Array(n);
  const hullTri = new Uint32Array(n);
  const hullHash = new Int32Array(hashSize).fill(-1);
  const ids = new Uint32Array(n);
  const dists = new Float64Array(n);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i += 1) {
    const x = coords[2 * i];
    const y = coords[2 * i + 1];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    ids[i] = i;
  }
  const centreX = (minX + maxX) / 2;
  const centreY = (minY + maxY) / 2;

  // Seed: the point nearest the centre, its nearest neighbour, and whichever
  // third point gives the smallest circumcircle.
  let i0 = 0;
  let minDist = Infinity;
  for (let i = 0; i < n; i += 1) {
    const d = (centreX - coords[2 * i]) ** 2 + (centreY - coords[2 * i + 1]) ** 2;
    if (d < minDist) { i0 = i; minDist = d; }
  }
  const i0x = coords[2 * i0];
  const i0y = coords[2 * i0 + 1];

  let i1 = 0;
  minDist = Infinity;
  for (let i = 0; i < n; i += 1) {
    if (i === i0) continue;
    const d = (i0x - coords[2 * i]) ** 2 + (i0y - coords[2 * i + 1]) ** 2;
    if (d < minDist && d > 0) { i1 = i; minDist = d; }
  }
  let i1x = coords[2 * i1];
  let i1y = coords[2 * i1 + 1];

  let i2 = 0;
  let minRadius = Infinity;
  for (let i = 0; i < n; i += 1) {
    if (i === i0 || i === i1) continue;
    const r = circumradiusSquared(i0x, i0y, i1x, i1y, coords[2 * i], coords[2 * i + 1]);
    if (r < minRadius) { i2 = i; minRadius = r; }
  }
  let i2x = coords[2 * i2];
  let i2y = coords[2 * i2 + 1];

  if (minRadius === Infinity) {
    // Every point is collinear, so there is no area to triangulate.
    return { triangles: new Uint32Array(0), halfedges: new Int32Array(0), coords };
  }

  if (orient2d(i0x, i0y, i1x, i1y, i2x, i2y) < 0) {
    const i = i1;
    const x = i1x;
    const y = i1y;
    i1 = i2;
    i1x = i2x;
    i1y = i2y;
    i2 = i;
    i2x = x;
    i2y = y;
  }

  const [cx, cy] = circumcentre(i0x, i0y, i1x, i1y, i2x, i2y);
  for (let i = 0; i < n; i += 1) {
    dists[i] = (coords[2 * i] - cx) ** 2 + (coords[2 * i + 1] - cy) ** 2;
  }
  quicksort(ids, dists, 0, n - 1);

  let hullStart = i0;
  let hullSize = 3;
  hullNext[i0] = i1; hullPrev[i2] = i1;
  hullNext[i1] = i2; hullPrev[i0] = i2;
  hullNext[i2] = i0; hullPrev[i1] = i0;
  hullTri[i0] = 0;
  hullTri[i1] = 1;
  hullTri[i2] = 2;
  hullHash.fill(-1);

  const hashKey = (x, y) => {
    const dx = x - cx;
    const dy = y - cy;
    const p = 1 - dx / (Math.abs(dx) + Math.abs(dy));
    const angle = (dy > 0 ? 3 - p : 1 + p) / 4;
    return Math.floor(hashSize * angle) % hashSize;
  };
  hullHash[hashKey(i0x, i0y)] = i0;
  hullHash[hashKey(i1x, i1y)] = i1;
  hullHash[hashKey(i2x, i2y)] = i2;

  let trianglesLen = 0;
  const link = (a, b) => {
    halfedges[a] = b;
    if (b !== -1) halfedges[b] = a;
  };
  const addTriangle = (i, j, k, a, b, c) => {
    const t = trianglesLen;
    triangles[t] = i;
    triangles[t + 1] = j;
    triangles[t + 2] = k;
    link(t, a);
    link(t + 1, b);
    link(t + 2, c);
    trianglesLen += 3;
    return t;
  };
  const legalize = (startEdge) => {
    let i = 0;
    let a = startEdge;
    let ar = 0;
    for (;;) {
      const b = halfedges[a];
      const a0 = a - (a % 3);
      ar = a0 + ((a + 2) % 3);
      if (b === -1) {
        if (i === 0) break;
        i -= 1;
        a = EDGE_STACK[i];
        continue;
      }
      const b0 = b - (b % 3);
      const al = a0 + ((a + 1) % 3);
      const bl = b0 + ((b + 2) % 3);
      const p0 = triangles[ar];
      const pr = triangles[a];
      const pl = triangles[al];
      const p1 = triangles[bl];
      const illegal = inCircle(
        coords[2 * p0], coords[2 * p0 + 1],
        coords[2 * pr], coords[2 * pr + 1],
        coords[2 * pl], coords[2 * pl + 1],
        coords[2 * p1], coords[2 * p1 + 1],
      );
      if (illegal) {
        triangles[a] = p1;
        triangles[b] = p0;
        const hbl = halfedges[bl];
        if (hbl === -1) {
          let e = hullStart;
          do {
            if (hullTri[e] === bl) { hullTri[e] = a; break; }
            e = hullPrev[e];
          } while (e !== hullStart);
        }
        link(a, hbl);
        link(b, halfedges[ar]);
        link(ar, bl);
        const br = b0 + ((b + 1) % 3);
        if (i < EDGE_STACK.length) { EDGE_STACK[i] = br; i += 1; }
      } else {
        if (i === 0) break;
        i -= 1;
        a = EDGE_STACK[i];
      }
    }
    return ar;
  };

  addTriangle(i0, i1, i2, -1, -1, -1);

  let xp = 0;
  let yp = 0;
  for (let k = 0; k < ids.length; k += 1) {
    const i = ids[k];
    const x = coords[2 * i];
    const y = coords[2 * i + 1];
    if (k > 0 && Math.abs(x - xp) <= EPSILON && Math.abs(y - yp) <= EPSILON) continue;
    xp = x;
    yp = y;
    if (i === i0 || i === i1 || i === i2) continue;

    let start = 0;
    const key = hashKey(x, y);
    for (let j = 0; j < hashSize; j += 1) {
      start = hullHash[(key + j) % hashSize];
      if (start !== -1 && start !== hullNext[start]) break;
    }
    start = hullPrev[start];
    let e = start;
    let q = hullNext[e];
    while (orient2d(x, y, coords[2 * e], coords[2 * e + 1], coords[2 * q], coords[2 * q + 1]) >= 0) {
      e = q;
      if (e === start) { e = -1; break; }
      q = hullNext[e];
    }
    if (e === -1) continue;

    let t = addTriangle(e, i, hullNext[e], -1, -1, hullTri[e]);
    hullTri[i] = legalize(t + 2);
    hullTri[e] = t;
    hullSize += 1;

    let next = hullNext[e];
    q = hullNext[next];
    while (orient2d(x, y, coords[2 * next], coords[2 * next + 1], coords[2 * q], coords[2 * q + 1]) < 0) {
      t = addTriangle(next, i, q, hullTri[i], -1, hullTri[next]);
      hullTri[i] = legalize(t + 2);
      hullNext[next] = next;
      hullSize -= 1;
      next = q;
      q = hullNext[next];
    }
    if (e === start) {
      q = hullPrev[e];
      while (orient2d(x, y, coords[2 * q], coords[2 * q + 1], coords[2 * e], coords[2 * e + 1]) < 0) {
        t = addTriangle(q, i, e, -1, hullTri[e], hullTri[q]);
        legalize(t + 2);
        hullTri[q] = t;
        hullNext[e] = e;
        hullSize -= 1;
        e = q;
        q = hullPrev[e];
      }
    }

    hullStart = e;
    hullPrev[i] = e;
    hullNext[e] = i;
    hullPrev[next] = i;
    hullNext[i] = next;

    hullHash[hashKey(x, y)] = i;
    hullHash[hashKey(coords[2 * e], coords[2 * e + 1])] = e;
  }

  return {
    triangles: triangles.subarray(0, trianglesLen),
    halfedges: halfedges.subarray(0, trianglesLen),
    coords,
  };
}
