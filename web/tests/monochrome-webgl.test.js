import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendLabelQuads,
  appendThickPolyline,
  parseCssColour,
} from '../src/render/monochrome-webgl.js';

test('parseCssColour reads the ink and paper the scene is described in', () => {
  assert.deepEqual(parseCssColour('#000000'), [0, 0, 0, 1]);
  assert.deepEqual(parseCssColour('#ffffff'), [1, 1, 1, 1]);
  const grey = parseCssColour('#808080');
  assert.ok(Math.abs(grey[0] - 128 / 255) < 1e-9);
});

test('a stroke gets its width from geometry, not from the driver', () => {
  // Hardware line width is capped at one pixel nearly everywhere, and the
  // limit-of-travel contour has to be visibly heavier than a band edge - so
  // width is built into the triangles rather than asked of gl.lineWidth.
  const target = [];
  appendThickPolyline(target, Float64Array.of(0, 0, 100, 0), (x, y) => [x, y], 4, false);

  // One segment, two triangles, six vertices.
  assert.equal(target.length, 12);
  const ys = target.filter((_value, index) => index % 2 === 1);
  assert.equal(Math.min(...ys), -2);
  assert.equal(Math.max(...ys), 2);

  const wider = [];
  appendThickPolyline(wider, Float64Array.of(0, 0, 100, 0), (x, y) => [x, y], 10, false);
  const widerYs = wider.filter((_value, index) => index % 2 === 1);
  assert.equal(Math.max(...widerYs), 5);
});

test('a closed ring is stroked all the way round, an open chain is not', () => {
  const square = Float64Array.of(0, 0, 10, 0, 10, 10, 0, 10);
  const closed = [];
  appendThickPolyline(closed, square, (x, y) => [x, y], 1, true);
  const open = [];
  appendThickPolyline(open, square, (x, y) => [x, y], 1, false);
  // Four sides against three: the closing side is the difference, and a
  // contour left open would show a gap no reader could account for.
  assert.equal(closed.length / 12, 4);
  assert.equal(open.length / 12, 3);
});

test('a zero-length segment contributes nothing rather than a degenerate quad', () => {
  const target = [];
  appendThickPolyline(target, Float64Array.of(5, 5, 5, 5), (x, y) => [x, y], 2, false);
  assert.equal(target.length, 0);
});

test('the transform is applied before the stroke is widened', () => {
  // Widening in graph space would make a stroke thinner as you zoom out and
  // thicker as you zoom in; it is a property of the sheet, not of the map.
  const target = [];
  appendThickPolyline(target, Float64Array.of(0, 0, 10, 0), (x, y) => [x * 10, y * 10], 4, false);
  const xs = target.filter((_value, index) => index % 2 === 0);
  assert.equal(Math.max(...xs), 100, 'the transform was not applied');
  const ys = target.filter((_value, index) => index % 2 === 1);
  assert.equal(Math.max(...ys), 2, 'the width was scaled by the transform');
});

const testAtlas = {
  cellHeight: 10,
  glyphs: new Map([
    ['3', { u0: 0, u1: 0.25, advance: 6 }],
    ['0', { u0: 0.25, u1: 0.5, advance: 6 }],
    [' ', { u0: 0.5, u1: 0.6, advance: 3 }],
    ['m', { u0: 0.6, u1: 0.8, advance: 8 }],
  ]),
};

test('a label is laid out centred on its anchor', () => {
  const quads = [];
  appendLabelQuads(quads, { text: '30', x: 100, y: 50, angleDegrees: 0 }, testAtlas);

  // Two glyphs, six vertices each, four floats per vertex.
  assert.equal(quads.length, 2 * 6 * 4);
  const xs = quads.filter((_value, index) => index % 4 === 0);
  // Total advance is 12, so the string spans 94 to 106 around its anchor.
  assert.equal(Math.min(...xs), 94);
  assert.equal(Math.max(...xs), 106);
  const ys = quads.filter((_value, index) => index % 4 === 1);
  assert.equal(Math.min(...ys), 45);
  assert.equal(Math.max(...ys), 55);
});

test('a label turns with its contour', () => {
  const upright = [];
  const turned = [];
  appendLabelQuads(upright, { text: '30', x: 0, y: 0, angleDegrees: 0 }, testAtlas);
  appendLabelQuads(turned, { text: '30', x: 0, y: 0, angleDegrees: 90 }, testAtlas);

  const spanOf = (quads, component) => {
    const values = quads.filter((_value, index) => index % 4 === component);
    return Math.max(...values) - Math.min(...values);
  };
  // Turned a quarter turn, the string's width and height swap over.
  assert.ok(Math.abs(spanOf(upright, 0) - spanOf(turned, 1)) < 1e-9);
  assert.ok(Math.abs(spanOf(upright, 1) - spanOf(turned, 0)) < 1e-9);
});

test('the halo is the same string, shifted, so it needs no second atlas', () => {
  const plain = [];
  const shifted = [];
  const label = { text: '30 m', x: 40, y: 40, angleDegrees: 0 };
  appendLabelQuads(plain, label, testAtlas);
  appendLabelQuads(shifted, label, testAtlas, [3, -2]);

  assert.equal(plain.length, shifted.length);
  for (let index = 0; index < plain.length; index += 4) {
    assert.ok(Math.abs((shifted[index] - plain[index]) - 3) < 1e-9);
    assert.ok(Math.abs((shifted[index + 1] - plain[index + 1]) + 2) < 1e-9);
    // The texture coordinates are untouched: it is the same glyphs, moved.
    assert.equal(shifted[index + 2], plain[index + 2]);
    assert.equal(shifted[index + 3], plain[index + 3]);
  }
});

test('a character the atlas does not carry is skipped, not drawn as a hole', () => {
  const quads = [];
  appendLabelQuads(quads, { text: '3Z0', x: 0, y: 0 }, testAtlas);
  assert.equal(quads.length, 2 * 6 * 4);
});
