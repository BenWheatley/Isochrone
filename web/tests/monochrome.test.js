import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_HATCH_PATTERN_COUNT,
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
} from '../src/export/monochrome-svg.js';

// How far apart two hatches must sit in ink coverage to stay apart once the
// greys are gone. The colour palette this replaces shipped with two bands
// three levels out of 255 apart, which is the failure this number exists to
// prevent recurring.
const MINIMUM_COVERAGE_SEPARATION = 0.1;

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
    for (let index = 1; index < coverage.length; index += 1) {
      const separation = coverage[index] - coverage[index - 1];
      assert.ok(
        separation >= MINIMUM_COVERAGE_SEPARATION,
        `at n=${count}, bands ${index - 1} and ${index} differ by only ${separation.toFixed(3)}`,
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
