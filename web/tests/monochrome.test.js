import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_HATCH_PATTERN_COUNT,
  MINIMUM_PATTERN_STROKE_WIDTH,
  WATER_HATCH_PATTERN,
  HATCH_PATTERN_LADDER,
  MAX_HATCH_PATTERN_COUNT,
  MIN_HATCH_PATTERN_COUNT,
  patternCoverageRatio,
  selectHatchPatterns,
  timeToFillPattern,
} from '../src/render/hatch.js';
import {
  buildHatchPatternDefs,
  buildMonochromeIsochroneSvg,
  placeContourLabel,
  placeContourLabels,
} from '../src/export/monochrome-svg.js';
import { buildMonochromeScene } from '../src/render/monochrome-screen.js';

// How far apart two hatches must sit in ink coverage to stay apart once the
// greys are gone. The colour palette this replaces shipped with two bands
// three levels out of 255 apart, which is the failure this number exists to
// prevent recurring.
//
// Expressed as a fraction of the ladder's own range as well as an absolute
// floor: lightening every rung - as was done to stop the hatch swamping the
// roads - shrinks the gaps in proportion without making any pair harder to
// tell apart, and a fixed number alone would call that a regression.
const MINIMUM_COVERAGE_SEPARATION = 0.08;
const MINIMUM_SEPARATION_AS_RANGE_FRACTION = 0.15;

test('the hatch ladder climbs, and never reaches solid', () => {
  const coverage = HATCH_PATTERN_LADDER.map((pattern) => patternCoverageRatio(pattern, 120));
  assert.equal(coverage[0], 0, 'the lightest rung must be bare paper');
  for (let index = 1; index < coverage.length; index += 1) {
    assert.ok(
      coverage[index] > coverage[index - 1],
      `rung ${index} (${coverage[index]}) is not darker than rung ${index - 1}`,
    );
  }
  // A band dark enough to read as flat grey has stopped being a texture, and
  // would bury the basemap and any label crossing it.
  assert.ok(coverage[coverage.length - 1] < 0.75, 'the darkest rung is too close to solid');
});

test('every supported pattern count keeps its bands distinguishable', () => {
  for (let count = MIN_HATCH_PATTERN_COUNT; count <= MAX_HATCH_PATTERN_COUNT; count += 1) {
    const coverage = selectHatchPatterns(count).map((pattern) => patternCoverageRatio(pattern, 120));
    const range = coverage[coverage.length - 1] - coverage[0];
    for (let index = 1; index < coverage.length; index += 1) {
      const separation = coverage[index] - coverage[index - 1];
      assert.ok(
        separation >= MINIMUM_COVERAGE_SEPARATION,
        `at n=${count}, bands ${index - 1} and ${index} differ by only ${separation.toFixed(3)}`,
      );
      assert.ok(
        separation / range >= MINIMUM_SEPARATION_AS_RANGE_FRACTION,
        `at n=${count}, bands ${index - 1} and ${index} take only `
        + `${(100 * separation / range).toFixed(0)}% of the ladder's range`,
      );
    }
  }
});

test('selectHatchPatterns spends the whole ladder however many are asked for', () => {
  const two = selectHatchPatterns(2);
  assert.equal(two[0], HATCH_PATTERN_LADDER[0]);
  assert.equal(two[1], HATCH_PATTERN_LADDER[HATCH_PATTERN_LADDER.length - 1]);

  assert.equal(selectHatchPatterns(MAX_HATCH_PATTERN_COUNT).length, HATCH_PATTERN_LADDER.length);
  assert.throws(() => selectHatchPatterns(1), /at least/);
  assert.throws(() => selectHatchPatterns(MAX_HATCH_PATTERN_COUNT + 1), /at most/);
});

test('timeToFillPattern repeats every cycle, as the colour palette does', () => {
  const options = { cycleMinutes: 60, patternCount: DEFAULT_HATCH_PATTERN_COUNT };
  const first = timeToFillPattern(5 * 60, options);
  assert.equal(first.id, HATCH_PATTERN_LADDER[0].id);
  assert.equal(timeToFillPattern(20 * 60, options).id, HATCH_PATTERN_LADDER[1].id);
  assert.equal(timeToFillPattern(59 * 60, options).id, HATCH_PATTERN_LADDER[4].id);

  // Second time round: identical hatch, which is what the contour labels are
  // there to tell apart.
  assert.equal(timeToFillPattern(65 * 60, options).id, first.id);
  assert.throws(() => timeToFillPattern(-1, options), /non-negative/);
});

test('hatch patterns are pinned to user space so bands do not acquire different textures', () => {
  const defs = buildHatchPatternDefs(selectHatchPatterns(3));
  assert.ok(defs.includes('patternUnits="userSpaceOnUse"'));
  // The blank rung has nothing to define, and must not emit an empty pattern
  // that a fill could then reference.
  assert.ok(!defs.includes('id="mono-blank"'));
  assert.equal((defs.match(/<pattern /g) ?? []).length, 2);
});

test('placeContourLabel sets its text along the straightest run, never upside down', () => {
  // A long straight top and bottom joined by tight semicircular ends: the
  // label belongs on a straight, not on a bend.
  const points = [];
  for (let x = 0; x <= 200; x += 4) points.push(x, 0);
  for (let angle = -90; angle <= 90; angle += 10) {
    points.push(200 + 20 * Math.cos((angle * Math.PI) / 180), 20 + 20 * Math.sin((angle * Math.PI) / 180));
  }
  for (let x = 200; x >= 0; x -= 4) points.push(x, 40);
  for (let angle = 90; angle <= 270; angle += 10) {
    points.push(0 + 20 * Math.cos((angle * Math.PI) / 180), 20 + 20 * Math.sin((angle * Math.PI) / 180));
  }

  const label = placeContourLabel(Float64Array.from(points), { text: '36 min', fontSize: 10 });
  assert.ok(label, 'no label was placed');
  assert.ok(label.angleDegrees <= 90 && label.angleDegrees >= -90, `angle ${label.angleDegrees}`);
  // On one of the two straight runs rather than on an end cap: the caps are
  // the only part of this ring that curves, and they are the only part where
  // y sits away from 0 or 40.
  assert.ok(Math.abs(label.y - 0) < 2 || Math.abs(label.y - 40) < 2, `label landed at y=${label.y}`);
  assert.ok(label.x >= 0 && label.x <= 200, `label landed at x=${label.x}`);
});

test('placeContourLabel declines a ring too small to carry the text', () => {
  const tiny = [];
  for (let angle = 0; angle < 360; angle += 30) {
    tiny.push(3 * Math.cos((angle * Math.PI) / 180), 3 * Math.sin((angle * Math.PI) / 180));
  }
  assert.equal(placeContourLabel(Float64Array.from(tiny), { text: '36 min', fontSize: 10 }), null);
});

function squareRing(size, offset = 0) {
  const points = [];
  const step = size / 8;
  for (let x = 0; x < size; x += step) points.push(offset + x, offset);
  for (let y = 0; y < size; y += step) points.push(offset + size, offset + y);
  for (let x = size; x > 0; x -= step) points.push(offset + x, offset + size);
  for (let y = size; y > 0; y -= step) points.push(offset, offset + y);
  return { points: Float64Array.from(points), signedArea: size * size, isHole: false };
}

test('a band is filled as an annulus, so the band inside it is not painted over', () => {
  const patterns = selectHatchPatterns(3);
  const bands = [
    { threshold: 600, label: '10 min', pattern: patterns[0], rings: [squareRing(40, 30)] },
    { threshold: 1200, label: '20 min', pattern: patterns[1], rings: [squareRing(100)] },
  ];
  const svg = buildMonochromeIsochroneSvg({ widthPx: 200, heightPx: 200, bands, legend: false });

  assert.ok(svg.startsWith('<svg '));
  assert.ok(svg.includes('fill-rule="evenodd"'));
  // The blank innermost band contributes no fill of its own...
  assert.equal((svg.match(/fill="url\(#/g) ?? []).length, 1);
  // ...but its rings are still in the outer band's path, which is what makes
  // that path an annulus rather than a disc painted over its neighbour.
  const fillPath = svg.match(/<path d="([^"]+)" fill="url\(#[^"]+\)"/);
  assert.ok(fillPath, 'no filled band path was emitted');
  assert.equal((fillPath[1].match(/M/g) ?? []).length, 2, 'the band path is not two subpaths');
});

test('the legend shows real hatches and only one cycle of them', () => {
  const patterns = selectHatchPatterns(3);
  const bands = [0, 1, 2, 0, 1].map((patternIndex, index) => ({
    threshold: (index + 1) * 600,
    label: `${(index + 1) * 10} min`,
    pattern: patterns[patternIndex],
    rings: [squareRing(180 - index * 20, index * 10)],
  }));
  const svg = buildMonochromeIsochroneSvg({ widthPx: 400, heightPx: 400, bands });

  // Three rows: the fourth band restarts the cycle, and repeating the swatches
  // would say the opposite of what the labels say.
  const legendSwatches = svg.match(/<rect x="17"/g) ?? [];
  assert.equal(legendSwatches.length, 3);
  assert.ok(svg.includes('>10 min</text>'));
  assert.ok(svg.includes('>30 min</text>'));
});

test('buildMonochromeIsochroneSvg refuses a scene it cannot draw', () => {
  const bands = [{ threshold: 60, label: '1 min', pattern: HATCH_PATTERN_LADDER[1], rings: [] }];
  assert.throws(
    () => buildMonochromeIsochroneSvg({ widthPx: Number.NaN, heightPx: 10, bands }),
    /finite/,
  );
  assert.throws(
    () => buildMonochromeIsochroneSvg({ widthPx: 10, heightPx: 10, bands: [] }),
    /at least one band/,
  );
});

test('a contour label is masked out of whatever it lies on', () => {
  const patterns = selectHatchPatterns(2);
  const bands = [{
    threshold: 1800,
    label: '30 min',
    pattern: patterns[1],
    rings: [squareRing(300, 20)],
  }];
  const svg = buildMonochromeIsochroneSvg({
    widthPx: 400, heightPx: 400, bands, legend: false, paper: '#ffffff', ink: '#000000',
  });

  // Drawn twice: a thick paper-coloured stroke, then the black fill over it.
  // Black text on a black hatch cannot be read however well it is placed, and
  // the halo is the whole difference between legible and not.
  const texts = svg.match(/<text [^>]*>30 min<\/text>/g) ?? [];
  assert.ok(texts.length >= 2 && texts.length % 2 === 0, `${texts.length} text elements`);
  for (let index = 0; index < texts.length; index += 2) {
    assert.ok(texts[index].includes('stroke="#ffffff"'), 'the halo is not drawn first');
    assert.ok(texts[index].includes('fill="none"'));
    assert.ok(texts[index + 1].includes('fill="#000000"'));
  }

  // Set along the contour by default, which is what an isoline label does.
  assert.ok(texts[1].includes('rotate('));
});

test('labels can be set horizontally where that reads better', () => {
  const patterns = selectHatchPatterns(2);
  const bands = [{
    threshold: 1800, label: '30 min', pattern: patterns[1], rings: [squareRing(300, 20)],
  }];
  const svg = buildMonochromeIsochroneSvg({
    widthPx: 400, heightPx: 400, bands, legend: false, labelsFollowContour: false,
  });
  assert.ok(!/<text [^>]*rotate\(/.test(svg));
});

test('a hole carries the value of the band inside it, so it is not labelled here', () => {
  const patterns = selectHatchPatterns(2);
  const bands = [{
    threshold: 1800,
    label: '30 min',
    pattern: patterns[1],
    rings: [
      { ...squareRing(300, 20), isHole: false },
      { ...squareRing(160, 90), isHole: true },
    ],
  }];
  const svg = buildMonochromeIsochroneSvg({ widthPx: 400, heightPx: 400, bands, legend: false });
  // Labelling both would print two different times against one line, since a
  // band's hole is its neighbour's outer boundary.
  const labelled = (svg.match(/<text [^>]*>30 min<\/text>/g) ?? []).length / 2;
  const outerOnly = buildMonochromeIsochroneSvg({
    widthPx: 400,
    heightPx: 400,
    legend: false,
    bands: [{ ...bands[0], rings: [bands[0].rings[0]] }],
  });
  assert.equal(labelled, (outerOnly.match(/<text [^>]*>30 min<\/text>/g) ?? []).length / 2);
});

test('placeContourLabels repeats along a contour too long to label once', () => {
  const long = [];
  for (let x = 0; x <= 4000; x += 20) long.push(x, 0);
  for (let x = 4000; x >= 0; x -= 20) long.push(x, 30);
  const points = Float64Array.from(long);

  const once = placeContourLabels(points, { text: '30 min', fontSize: 12, spacingPx: 1e9 });
  assert.equal(once.length, 1, 'a single label was not produced for a huge spacing');

  const many = placeContourLabels(points, { text: '30 min', fontSize: 12, spacingPx: 1500 });
  assert.ok(many.length >= 3, `expected several labels along 8000px of contour, got ${many.length}`);
  // Spread out rather than bunched: a reader should not have to hunt.
  const xs = many.map((label) => label.x).sort((a, b) => a - b);
  assert.ok(xs[xs.length - 1] - xs[0] > 1500);
});

test('the basemap goes under the bands, and its islands stay dry', () => {
  const patterns = selectHatchPatterns(2);
  const bands = [{
    threshold: 1800, label: '30 min', pattern: patterns[1], rings: [squareRing(200, 40)],
  }];
  const svg = buildMonochromeIsochroneSvg({
    widthPx: 400,
    heightPx: 400,
    bands,
    legend: false,
    basemap: {
      waterFeatures: [{
        paths: [
          [[0, 0], [400, 0], [400, 400], [0, 400]],
          [[100, 100], [100, 300], [300, 300], [300, 100]],
        ],
      }],
      roadSegments: Float64Array.from([10, 10, 380, 380, 10, 380, 380, 10]),
    },
  });

  assert.ok(svg.includes(`id="${WATER_HATCH_PATTERN.id}"`), 'no water pattern was defined');
  const waterIndex = svg.indexOf(`url(#${WATER_HATCH_PATTERN.id})`);
  const roadIndex = svg.indexOf('stroke-linecap="round"');
  const bandIndex = svg.indexOf(`url(#${patterns[1].id})`);
  assert.ok(waterIndex > 0 && roadIndex > waterIndex, 'roads are not drawn over the water');
  assert.ok(bandIndex > roadIndex, 'the band tint is not drawn over the roads');

  // An island is a hole in the sea, so the water path carries both rings under
  // even-odd - the same rule the colour export needed.
  const waterPath = svg.slice(waterIndex - 400, waterIndex + 40).match(/<path d="([^"]+)"/);
  assert.ok(waterPath, 'no water path was emitted');
  assert.equal((waterPath[1].match(/M/g) ?? []).length, 2);
  assert.ok(svg.slice(waterIndex, waterIndex + 80).includes('evenodd'));
});

test('no pattern is drawn with a stroke thin enough to disappear', () => {
  // A sub-pixel stroke is not a lighter line, it is a line that may not be
  // drawn: the sea's ruling vanished outright at 0.45 units, snapped away by
  // the renderer. Tone comes from the spacing between strokes instead, which
  // is also what survives being thresholded to one bit.
  for (const pattern of [...HATCH_PATTERN_LADDER, WATER_HATCH_PATTERN]) {
    if (pattern.lines.length === 0) {
      assert.equal(pattern.strokeWidth, 0, `${pattern.id} has strokes but claims none`);
      continue;
    }
    assert.ok(
      pattern.strokeWidth >= MINIMUM_PATTERN_STROKE_WIDTH,
      `${pattern.id} strokes at ${pattern.strokeWidth}, under the minimum`,
    );
  }
  // And nothing pins them to the pixel grid, which is how the thin one came to
  // be snapped away in the first place.
  assert.ok(!buildHatchPatternDefs([WATER_HATCH_PATTERN]).includes('crispEdges'));
});

test('the sea is ruled more finely than any band, and never at their angle', () => {
  const bandCoverage = HATCH_PATTERN_LADDER
    .filter((pattern) => pattern.lines.length > 0)
    .map((pattern) => patternCoverageRatio(pattern, 120));
  const water = patternCoverageRatio(WATER_HATCH_PATTERN, 200);
  assert.ok(water < Math.min(...bandCoverage), 'the sea competes with the lightest band');

  // Horizontal, where every band runs at 45 degrees, so the sea cannot be read
  // as a time band - and in particular not as the bare-paper one.
  for (const line of WATER_HATCH_PATTERN.lines) {
    assert.equal(line.y1, line.y2, 'the water ruling is not horizontal');
  }
  for (const pattern of HATCH_PATTERN_LADDER) {
    for (const line of pattern.lines) {
      assert.notEqual(line.y1, line.y2, `${pattern.id} has a horizontal stroke`);
    }
  }
});

test('a band is an annulus under either fill rule, not just even-odd', () => {
  const patterns = selectHatchPatterns(2);
  const bands = [
    { threshold: 600, label: '10 min', pattern: patterns[1], rings: [squareRing(40, 30)] },
    { threshold: 1200, label: '20 min', pattern: patterns[1], rings: [squareRing(100)] },
  ];
  const svg = buildMonochromeIsochroneSvg({ widthPx: 200, heightPx: 200, bands, legend: false });

  // The outer band's path carries the inner band's ring wound the other way.
  // Under non-zero a same-wound inner ring adds rather than subtracts, and the
  // band paints as a full disc over its neighbour - which is what a renderer
  // that ignores fill-rule produces, and what made the same map look different
  // in two browsers.
  const fillPaths = [...svg.matchAll(/<path d="([^"]+)" fill="url\(#/g)].map((m) => m[1]);
  const outer = fillPaths[fillPaths.length - 1];
  const subpaths = outer.split('M').filter((part) => part.length > 0);
  assert.equal(subpaths.length, 2, 'the band path is not two subpaths');

  const signedArea = (subpath) => {
    const numbers = subpath.replace(/[LZ]/g, ' ').trim().split(/[\s]+/).map(Number);
    let total = 0;
    const count = numbers.length / 2;
    for (let index = 0; index < count; index += 1) {
      const next = (index + 1) % count;
      total += numbers[index * 2] * numbers[next * 2 + 1] - numbers[next * 2] * numbers[index * 2 + 1];
    }
    return total / 2;
  };
  const areas = subpaths.map(signedArea);
  assert.ok(
    Math.sign(areas[0]) !== Math.sign(areas[1]),
    `both subpaths wind the same way (${areas}), so non-zero fill would not subtract`,
  );
});

test('a label gap is a short forward run, never a wrap around the ring', () => {
  // A jagged ring with one straight stretch, placed so the straightest window
  // in its slice sits near that slice's end. A slice is an open chain, and if
  // the window is allowed to wrap from its end back to its start, the indices
  // read back against the ring describe a gap running the wrong way round -
  // and the contour drawn from them loses everything but a stub.
  const count = 400;
  const points = [];
  for (let step = 0; step < count; step += 1) {
    const angle = (step / count) * Math.PI * 2;
    // Straight from 20% to 24% of the way round; jagged everywhere else.
    const fraction = step / count;
    const wobble = fraction > 0.2 && fraction < 0.24 ? 0 : (step % 2 === 0 ? 18 : -18);
    const radius = 900 + wobble;
    points.push(1000 + radius * Math.cos(angle), 1000 + radius * Math.sin(angle));
  }
  const ring = Float64Array.from(points);

  const placements = placeContourLabels(ring, {
    text: '30 min',
    fontSize: 14,
    spacingPx: 1200,
  });
  assert.ok(placements.length >= 2, `expected several labels, got ${placements.length}`);

  for (const placement of placements) {
    assert.ok(
      placement.gapEndIndex > placement.gapStartIndex,
      `gap runs backwards: ${placement.gapStartIndex} -> ${placement.gapEndIndex}`,
    );
    const span = placement.gapEndIndex - placement.gapStartIndex;
    assert.ok(
      span < count / 8,
      `gap spans ${span} of ${count} points, which is a stretch of contour, not a label`,
    );
  }
});

/**
 * A graph of a few nodes in one small cluster, with no edges: enough for a
 * triangulation and a travel-time field, nothing to draw as roads.
 */
function buildTinyClusterMapData() {
  const nodeCount = 4;
  return {
    graph: {
      header: { nNodes: nodeCount, gridWidthPx: 400, gridHeightPx: 400, pixelSizeM: 10 },
      nodeU32: new Uint32Array(nodeCount * 4),
      nodeU16: new Uint16Array(nodeCount * 8),
      edgeU32: new Uint32Array(0),
      edgeModeMask: new Uint8Array(0),
      edgeRoadClassId: new Uint8Array(0),
    },
    nodePixels: {
      nodePixelX: Uint16Array.of(200, 210, 210, 200),
      nodePixelY: Uint16Array.of(200, 200, 210, 210),
    },
  };
}

test('the speck filter declutters the map, it never empties it', () => {
  // An origin that only reaches a small disconnected fragment - a courtyard, a
  // gated estate, an island - is all specks at low zoom. Dropping every ring
  // below the minimum then left no band at all, and a scene of no bands is no
  // scene: the caller blanked the window rather than showing the little there
  // was to show.
  const mapData = buildTinyClusterMapData();
  const snapshot = { distSeconds: Float32Array.of(0, 120, 240, 360) };
  const options = { widthPx: 400, heightPx: 400, cycleMinutes: 10, patternCount: 2 };

  const drawn = buildMonochromeScene(mapData, snapshot, options);
  assert.ok(drawn, 'the cluster is drawable at all');

  // Every ring in it is now far below the threshold.
  const decluttered = buildMonochromeScene(mapData, snapshot, {
    ...options,
    minimumRingOutputArea: 1e12,
  });
  assert.ok(decluttered, 'a map of nothing but specks still draws its specks');
  assert.ok(decluttered.bands.length > 0, 'and has bands in it to draw');
  assert.ok(
    decluttered.bands.every((band) => band.rings.length > 0),
    'every band it reports is one with geometry',
  );
});

test('the band count is bounded by the field, not by a fixed ceiling', () => {
  // Walking across Cyprus takes far longer than the ten hours forty bands of
  // fifteen minutes can describe. Everything past the ceiling fell into no
  // band at all, so most of the island drew as bare paper with a scatter of
  // fragments in it - the map reporting the limit of its own loop rather than
  // anything about the ground.
  const mapData = buildTinyClusterMapData();
  const distSeconds = Float64Array.of(0, 30 * 3600, 60 * 3600, 90 * 3600);
  const scene = buildMonochromeScene(mapData, { distSeconds }, {
    widthPx: 400,
    heightPx: 400,
    cycleMinutes: 30,
    patternCount: 2,
  });

  assert.ok(scene, 'a scene was built');
  // 90 hours in fifteen-minute bands, of which the two triangles cover a run.
  assert.ok(
    scene.bands.length > 40,
    `only ${scene.bands.length} bands, so a ceiling is still truncating the field`,
  );
  assert.match(scene.bands.at(-1).label, /\d+\s*h/, 'the last band is labelled in hours');
});
