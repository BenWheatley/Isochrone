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
} from '../src/export/monochrome-svg.js';
import { buildMonochromeScene } from '../src/render/monochrome-screen.js';
import { buildBandOrderedSegments } from '../src/render/band-ribbons.js';

/** A scene's ribbon geometry, as the scene builder assembles it. */
function orderedRibbon(segments, bandSeconds) {
  return { segments, ordered: buildBandOrderedSegments(segments, bandSeconds) };
}

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

test('the legend shows real hatches and only one cycle of them', () => {
  const patterns = selectHatchPatterns(3);
  const svg = buildMonochromeIsochroneSvg({
    widthPx: 400,
    heightPx: 400,
    ribbons: {
      ...orderedRibbon(Float32Array.from([20, 20, 0, 380, 380, 3600]), 600),
      bandSeconds: 600,
      patterns,
      patternLabels: ['10 min', '20 min', '30 min'],
      widthPx: 20,
      outlinePx: 0.9,
    },
  });

  // Three rows: the fourth band restarts the cycle, and repeating the swatches
  // would say the opposite of what the labels say.
  const legendSwatches = svg.match(/<rect x="17"/g) ?? [];
  assert.equal(legendSwatches.length, 3);
  assert.ok(svg.includes('>10 min</text>'));
  assert.ok(svg.includes('>30 min</text>'));
});

test('buildMonochromeIsochroneSvg needs a size, and nothing else', () => {
  assert.throws(
    () => buildMonochromeIsochroneSvg({ widthPx: Number.NaN, heightPx: 10 }),
    /finite/,
  );
  // A sheet with nothing reached on it is still a sheet: coastline and roads
  // and no zones, the same as the screen draws.
  const svg = buildMonochromeIsochroneSvg({ widthPx: 10, heightPx: 10 });
  assert.ok(svg.startsWith('<svg '));
  assert.ok(svg.endsWith('</svg>'));
});

test('a contour label is masked out of whatever it lies on', () => {
  const patterns = selectHatchPatterns(2);
  const svg = buildMonochromeIsochroneSvg({
    widthPx: 400,
    heightPx: 400,
    legend: false,
    paper: '#ffffff',
    ink: '#000000',
    ribbons: {
      ...orderedRibbon(Float32Array.from([20, 200, 0, 380, 200, 3600]), 1800),
      bandSeconds: 1800,
      patterns,
      patternLabels: ['30 min', '60 min'],
      widthPx: 40,
      outlinePx: 0.9,
    },
    labels: [{ x: 200, y: 200, angleDegrees: 20, text: '30 min' }],
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

test('the basemap goes under the zones, and its islands stay dry', () => {
  const patterns = selectHatchPatterns(2);
  const svg = buildMonochromeIsochroneSvg({
    widthPx: 400,
    heightPx: 400,
    ribbons: {
      ...orderedRibbon(Float32Array.from([120, 120, 0, 280, 280, 1800]), 900),
      bandSeconds: 900,
      patterns,
      patternLabels: ['15 min', '30 min'],
      widthPx: 20,
      outlinePx: 0.9,
    },
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

/**
 * A graph of four nodes in one small cluster, with no edges of its own: enough
 * for a scene to be built against, nothing to draw as roads.
 */
function buildTinyClusterMapData() {
  const nodeCount = 4;
  // Map space, in metres: the same four corners the graph pixels below stand
  // for, at pixelSizeM 10 with the northing axis flipped against gridHeightPx.
  const nodeI32 = Int32Array.from([
    2000, 1990, 0, 0,
    2100, 1990, 0, 0,
    2100, 1890, 0, 0,
    2000, 1890, 0, 0,
  ]);
  return {
    graph: {
      header: {
        nNodes: nodeCount, nEdges: 0, gridWidthPx: 400, gridHeightPx: 400, pixelSizeM: 10,
      },
      nodeI32,
      nodeU32: new Uint32Array(nodeCount * 4),
      nodeU16: new Uint16Array(nodeCount * 8),
      edgeU32: new Uint32Array(0),
      edgeU16: new Uint16Array(0),
      edgeModeMask: new Uint8Array(0),
      edgeRoadClassId: new Uint8Array(0),
    },
    nodePixels: {
      nodePixelX: Uint16Array.of(200, 210, 210, 200),
      nodePixelY: Uint16Array.of(200, 200, 210, 210),
    },
  };
}

test('the scene carries the ways as zones, sized from the sheet', () => {
  // The snapshot already holds the colour renderer's edge buffer, so the
  // monochrome scene reuses it rather than walking the graph again - and the
  // two modes then cannot come to describe different journeys.
  const mapData = buildTinyClusterMapData();
  const edgeVertexData = Float32Array.of(
    200, 200, 0, 210, 200, 600,
    210, 200, 600, 210, 210, 1800,
  );
  const snapshot = {
    distSeconds: Float64Array.of(0, 600, 1800, Infinity),
    edgeVertexData,
    edgeVertexDataModeMask: 4,
  };

  const scene = buildMonochromeScene(mapData, snapshot, {
    widthPx: 400,
    heightPx: 400,
    cycleMinutes: 30,
    patternCount: 2,
    allowedModeMask: 4,
  });

  assert.ok(scene, 'a scene was built');
  assert.equal(scene.ribbons.segments, edgeVertexData, 'the colour buffer, unchanged');
  assert.equal(scene.ribbons.bandSeconds, 900, '30 minutes over two patterns');
  // 15 mm of finished sheet, not a pixel count chosen for one device.
  assert.ok(Math.abs(scene.ribbons.widthPx - 15 * (96 / 25.4)) < 1e-9);
  assert.ok(scene.labels.length > 0, 'a boundary is crossed, so it is labelled');
});
