import assert from 'node:assert/strict';
import test from 'node:test';

import { mapScreenCanvasPixelToGraphPixel } from '../src/core/viewport.js';
import { bindCanvasClickRouting } from '../src/interaction/canvas-routing.js';

function createEventTarget(base = {}) {
  const listeners = new Map();
  return {
    ...base,
    addEventListener(type, listener) {
      const listenerSet = listeners.get(type) ?? new Set();
      listenerSet.add(listener);
      listeners.set(type, listenerSet);
    },
    removeEventListener(type, listener) {
      const listenerSet = listeners.get(type);
      listenerSet?.delete(listener);
    },
    emit(type, event = {}) {
      const listenerSet = listeners.get(type);
      if (!listenerSet) {
        return;
      }
      for (const listener of listenerSet) {
        listener({
          type,
          preventDefault() {},
          stopPropagation() {},
          ...event,
        });
      }
    },
  };
}

function parseTransform(styleTransform) {
  if (typeof styleTransform !== 'string' || styleTransform.length === 0 || styleTransform === 'none') {
    return { translateX: 0, translateY: 0, scale: 1 };
  }

  const match = /translate\((-?\d+(?:\.\d+)?)px,\s*(-?\d+(?:\.\d+)?)px\)\s+scale\((\d+(?:\.\d+)?)\)/.exec(
    styleTransform,
  );
  if (!match) {
    return { translateX: 0, translateY: 0, scale: 1 };
  }

  return {
    translateX: Number.parseFloat(match[1]),
    translateY: Number.parseFloat(match[2]),
    scale: Number.parseFloat(match[3]),
  };
}

function createCanvasFixture() {
  const baseRect = {
    left: 100,
    top: 60,
    width: 400,
    height: 300,
  };
  const capturedPointerIds = new Set();
  const canvasStackStyle = {
    transform: '',
    transformOrigin: '',
    setProperty(name, value) {
      this[name] = value;
    },
  };

  const canvasStack = createEventTarget({
    style: canvasStackStyle,
    getBoundingClientRect() {
      const { translateX, translateY, scale } = parseTransform(canvasStackStyle.transform);
      return {
        left: baseRect.left + translateX,
        top: baseRect.top + translateY,
        width: baseRect.width * scale,
        height: baseRect.height * scale,
        right: baseRect.left + translateX + baseRect.width * scale,
        bottom: baseRect.top + translateY + baseRect.height * scale,
      };
    },
  });

  const isochroneCanvas = createEventTarget({
    width: 400,
    height: 300,
    style: {},
    getBoundingClientRect() {
      return canvasStack.getBoundingClientRect();
    },
    setPointerCapture(pointerId) {
      capturedPointerIds.add(pointerId);
    },
    releasePointerCapture(pointerId) {
      capturedPointerIds.delete(pointerId);
    },
    hasPointerCapture(pointerId) {
      return capturedPointerIds.has(pointerId);
    },
  });

  const mapRegion = {
    getBoundingClientRect() {
      return {
        left: baseRect.left,
        top: baseRect.top,
        width: baseRect.width,
        height: baseRect.height,
        right: baseRect.left + baseRect.width,
        bottom: baseRect.top + baseRect.height,
      };
    },
  };

  return {
    shell: {
      isochroneCanvas,
      canvasStack,
      mapRegion,
      invertPointerButtonsInput: { checked: false },
    },
    baseRect,
  };
}

function flushTasks() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

test('requestIsochroneRedraw reruns from the last completed node', async () => {
  const { shell } = createCanvasFixture();
  const mapData = {
    graph: {
      header: {
        nNodes: 16,
      },
    },
  };

  let runCount = 0;
  const binding = bindCanvasClickRouting(shell, mapData, {}, {
    findNearestNodeForCanvasPixel() {
      return { nodeIndex: 7 };
    },
    getAllowedModeMaskFromShell() {
      return 4;
    },
    getColourCycleMinutesFromShell() {
      return 75;
    },
    mapClientPointToCanvasPixel() {
      return { xPx: 10, yPx: 12 };
    },
    parseNodeIndexFromLocationSearch() {
      return null;
    },
    persistNodeIndexToLocation() {},
    renderIsochroneLegendIfNeeded() {},
    async runWalkingIsochroneFromSourceNode() {
      runCount += 1;
      return { cancelled: false };
    },
    setRoutingStatus() {},
  });

  await binding.runFromCanvasPixel(10, 12);
  assert.equal(runCount, 1);

  const requested = binding.requestIsochroneRedraw();
  assert.equal(requested, true);
  await flushTasks();
  assert.equal(runCount, 2);
});

test('runFromCanvasPixel forwards getTransitOptionsFromShell result into routing options', async () => {
  const { shell } = createCanvasFixture();
  const mapData = {
    graph: {
      header: {
        nNodes: 16,
      },
    },
  };

  let capturedOptions = null;
  const binding = bindCanvasClickRouting(shell, mapData, {}, {
    findNearestNodeForCanvasPixel() {
      return { nodeIndex: 7 };
    },
    getAllowedModeMaskFromShell() {
      return 4;
    },
    getColourCycleMinutesFromShell() {
      return 75;
    },
    getTransitOptionsFromShell() {
      return { transitEnabled: true, departureSecondsOfDay: 30_600 };
    },
    mapClientPointToCanvasPixel() {
      return { xPx: 10, yPx: 12 };
    },
    parseNodeIndexFromLocationSearch() {
      return null;
    },
    persistNodeIndexToLocation() {},
    renderIsochroneLegendIfNeeded() {},
    async runWalkingIsochroneFromSourceNode(_shell, _mapData, _nodeIndex, _timeLimit, options) {
      capturedOptions = options;
      return { cancelled: false };
    },
    setRoutingStatus() {},
  });

  await binding.runFromCanvasPixel(10, 12);

  assert.equal(capturedOptions.transitEnabled, true);
  assert.equal(capturedOptions.departureSecondsOfDay, 30_600);
});

test('waitForIdle resolves after active routing run completes', async () => {
  const { shell } = createCanvasFixture();
  const mapData = {
    graph: {
      header: {
        nNodes: 16,
      },
    },
  };

  let resolveRun = null;
  const binding = bindCanvasClickRouting(shell, mapData, {}, {
    findNearestNodeForCanvasPixel() {
      return { nodeIndex: 7 };
    },
    getAllowedModeMaskFromShell() {
      return 4;
    },
    getColourCycleMinutesFromShell() {
      return 75;
    },
    mapClientPointToCanvasPixel() {
      return { xPx: 10, yPx: 12 };
    },
    parseNodeIndexFromLocationSearch() {
      return null;
    },
    persistNodeIndexToLocation() {},
    renderIsochroneLegendIfNeeded() {},
    runWalkingIsochroneFromSourceNode() {
      return new Promise((resolve) => {
        resolveRun = resolve;
      });
    },
    setRoutingStatus() {},
  });

  const runPromise = binding.runFromCanvasPixel(10, 12);
  let idleResolved = false;
  const idlePromise = binding.waitForIdle().then(() => {
    idleResolved = true;
  });

  await flushTasks();
  assert.equal(idleResolved, false);

  resolveRun({ cancelled: false });
  await runPromise;
  await idlePromise;
  assert.equal(idleResolved, true);
});

test('bindCanvasClickRouting can skip initial URL-driven autoroute during region restore', async () => {
  const { shell } = createCanvasFixture();
  const mapData = {
    graph: {
      header: {
        nNodes: 16,
      },
    },
  };

  let runCount = 0;
  bindCanvasClickRouting(shell, mapData, { autoStartFromLocation: false }, {
    findNearestNodeForCanvasPixel() {
      return { nodeIndex: 7 };
    },
    getAllowedModeMaskFromShell() {
      return 4;
    },
    getColourCycleMinutesFromShell() {
      return 75;
    },
    mapClientPointToCanvasPixel() {
      return { xPx: 10, yPx: 12 };
    },
    parseNodeIndexFromLocationSearch() {
      return 5;
    },
    persistNodeIndexToLocation() {},
    renderIsochroneLegendIfNeeded() {},
    async runWalkingIsochroneFromSourceNode() {
      runCount += 1;
      return { cancelled: false };
    },
    setRoutingStatus() {},
  });

  await flushTasks();
  assert.equal(runCount, 0);
});

test('primary click selects origin, wheel zooms, and primary drag pans without rerouting', async () => {
  const { shell } = createCanvasFixture();
  const mapData = {
    graph: {
      header: {
        nNodes: 512,
        gridWidthPx: 400,
        gridHeightPx: 300,
      },
    },
  };

  const routedNodeIndices = [];
  let scaleBarUpdateCount = 0;
  let redrawViewportCount = 0;
  const binding = bindCanvasClickRouting(shell, mapData, {}, {
    findNearestNodeForCanvasPixel(_mapData, xPx) {
      return { nodeIndex: Math.round(xPx) };
    },
    getAllowedModeMaskFromShell() {
      return 4;
    },
    getColourCycleMinutesFromShell() {
      return 75;
    },
    mapClientPointToCanvasPixel(_canvas, clientX, clientY) {
      return { xPx: Math.round(clientX), yPx: Math.round(clientY) };
    },
    parseNodeIndexFromLocationSearch() {
      return null;
    },
    persistNodeIndexToLocation() {},
    renderIsochroneLegendIfNeeded() {},
    async runWalkingIsochroneFromSourceNode(_shell, _mapData, nodeIndex) {
      routedNodeIndices.push(nodeIndex);
      return { cancelled: false };
    },
    setRoutingStatus() {},
    updateDistanceScaleBar() {
      scaleBarUpdateCount += 1;
    },
    redrawViewport() {
      redrawViewportCount += 1;
    },
  });

  shell.isochroneCanvas.emit('pointerdown', {
    button: 0,
    buttons: 1,
    clientX: 120,
    clientY: 140,
    pointerId: 1,
    pointerType: 'mouse',
  });
  shell.isochroneCanvas.emit('pointerup', {
    button: 0,
    buttons: 0,
    clientX: 120,
    clientY: 140,
    pointerId: 1,
    pointerType: 'mouse',
  });
  await flushTasks();
  assert.deepEqual(routedNodeIndices, [120]);

  let wheelPrevented = false;
  shell.isochroneCanvas.emit('wheel', {
    clientX: 250,
    clientY: 210,
    deltaY: -120,
    preventDefault() {
      wheelPrevented = true;
    },
  });

  const zoomedViewport = binding.getViewportState();
  assert.equal(wheelPrevented, true);
  assert.ok(zoomedViewport.scale > 1);
  assert.equal(scaleBarUpdateCount, 1);
  assert.equal(redrawViewportCount, 1);

  const viewportBeforePan = binding.getViewportState();
  shell.isochroneCanvas.emit('pointerdown', {
    button: 0,
    buttons: 1,
    clientX: 220,
    clientY: 180,
    pointerId: 2,
    pointerType: 'mouse',
  });
  shell.isochroneCanvas.emit('pointermove', {
    buttons: 1,
    clientX: 260,
    clientY: 210,
    pointerId: 2,
    pointerType: 'mouse',
  });
  shell.isochroneCanvas.emit('pointerup', {
    button: 0,
    buttons: 0,
    clientX: 260,
    clientY: 210,
    pointerId: 2,
    pointerType: 'mouse',
  });
  await flushTasks();

  assert.deepEqual(routedNodeIndices, [120]);
  const viewportAfterPan = binding.getViewportState();
  assert.notDeepEqual(viewportAfterPan, viewportBeforePan);
  assert.equal(redrawViewportCount, 2);
});

test('secondary drag moves the selection point without panning by default', async () => {
  const { shell } = createCanvasFixture();
  const mapData = {
    graph: {
      header: {
        nNodes: 512,
        gridWidthPx: 400,
        gridHeightPx: 300,
      },
    },
  };

  const routedNodeIndices = [];
  let redrawViewportCount = 0;
  const binding = bindCanvasClickRouting(shell, mapData, {}, {
    findNearestNodeForCanvasPixel(_mapData, xPx) {
      return { nodeIndex: Math.round(xPx) };
    },
    getAllowedModeMaskFromShell() {
      return 4;
    },
    getColourCycleMinutesFromShell() {
      return 75;
    },
    mapClientPointToCanvasPixel(_canvas, clientX, clientY) {
      return { xPx: Math.round(clientX), yPx: Math.round(clientY) };
    },
    parseNodeIndexFromLocationSearch() {
      return null;
    },
    persistNodeIndexToLocation() {},
    renderIsochroneLegendIfNeeded() {},
    async runWalkingIsochroneFromSourceNode(_shell, _mapData, nodeIndex) {
      routedNodeIndices.push(nodeIndex);
      return { cancelled: false };
    },
    setRoutingStatus() {},
    updateDistanceScaleBar() {},
    redrawViewport() {
      redrawViewportCount += 1;
    },
  });

  const viewportBefore = binding.getViewportState();
  shell.isochroneCanvas.emit('pointerdown', {
    button: 2,
    buttons: 2,
    clientX: 180,
    clientY: 160,
    pointerId: 3,
    pointerType: 'mouse',
  });
  shell.isochroneCanvas.emit('pointermove', {
    buttons: 2,
    clientX: 205,
    clientY: 170,
    pointerId: 3,
    pointerType: 'mouse',
  });
  shell.isochroneCanvas.emit('pointerup', {
    button: 2,
    buttons: 0,
    clientX: 205,
    clientY: 170,
    pointerId: 3,
    pointerType: 'mouse',
  });
  await flushTasks();

  assert.deepEqual(routedNodeIndices, [205, 205]);
  assert.deepEqual(binding.getViewportState(), viewportBefore);
  assert.equal(redrawViewportCount, 0);
});

test('invert pointer buttons swaps navigation and selection drag roles', async () => {
  const { shell } = createCanvasFixture();
  shell.invertPointerButtonsInput.checked = true;
  const mapData = {
    graph: {
      header: {
        nNodes: 512,
        gridWidthPx: 400,
        gridHeightPx: 300,
      },
    },
  };

  const routedNodeIndices = [];
  let redrawViewportCount = 0;
  const binding = bindCanvasClickRouting(shell, mapData, {}, {
    findNearestNodeForCanvasPixel(_mapData, xPx) {
      return { nodeIndex: Math.round(xPx) };
    },
    getAllowedModeMaskFromShell() {
      return 4;
    },
    getColourCycleMinutesFromShell() {
      return 75;
    },
    mapClientPointToCanvasPixel(_canvas, clientX, clientY) {
      return { xPx: Math.round(clientX), yPx: Math.round(clientY) };
    },
    parseNodeIndexFromLocationSearch() {
      return null;
    },
    persistNodeIndexToLocation() {},
    renderIsochroneLegendIfNeeded() {},
    async runWalkingIsochroneFromSourceNode(_shell, _mapData, nodeIndex) {
      routedNodeIndices.push(nodeIndex);
      return { cancelled: false };
    },
    setRoutingStatus() {},
    updateDistanceScaleBar() {},
    redrawViewport() {
      redrawViewportCount += 1;
    },
  });

  shell.isochroneCanvas.emit('wheel', {
    clientX: 250,
    clientY: 210,
    deltaY: -120,
    preventDefault() {},
  });

  shell.isochroneCanvas.emit('pointerdown', {
    button: 0,
    buttons: 1,
    clientX: 150,
    clientY: 150,
    pointerId: 4,
    pointerType: 'mouse',
  });
  shell.isochroneCanvas.emit('pointermove', {
    buttons: 1,
    clientX: 180,
    clientY: 150,
    pointerId: 4,
    pointerType: 'mouse',
  });
  shell.isochroneCanvas.emit('pointerup', {
    button: 0,
    buttons: 0,
    clientX: 180,
    clientY: 150,
    pointerId: 4,
    pointerType: 'mouse',
  });
  await flushTasks();
  const expectedSelectionPoint = mapScreenCanvasPixelToGraphPixel(binding.getViewportState(), 180, 150);
  assert.deepEqual(routedNodeIndices, [
    Math.round(expectedSelectionPoint.xPx),
    Math.round(expectedSelectionPoint.xPx),
  ]);
  assert.equal(redrawViewportCount, 1);

  const viewportBeforePan = binding.getViewportState();
  shell.isochroneCanvas.emit('pointerdown', {
    button: 2,
    buttons: 2,
    clientX: 220,
    clientY: 180,
    pointerId: 5,
    pointerType: 'mouse',
  });
  shell.isochroneCanvas.emit('pointermove', {
    buttons: 2,
    clientX: 255,
    clientY: 215,
    pointerId: 5,
    pointerType: 'mouse',
  });
  shell.isochroneCanvas.emit('pointerup', {
    button: 2,
    buttons: 0,
    clientX: 255,
    clientY: 215,
    pointerId: 5,
    pointerType: 'mouse',
  });
  await flushTasks();

  assert.deepEqual(routedNodeIndices, [
    Math.round(expectedSelectionPoint.xPx),
    Math.round(expectedSelectionPoint.xPx),
  ]);
  assert.notDeepEqual(binding.getViewportState(), viewportBeforePan);
  assert.equal(redrawViewportCount, 2);
});

test('single-touch tap selects origin without panning', async () => {
  const { shell } = createCanvasFixture();
  const mapData = {
    graph: {
      header: {
        nNodes: 512,
        gridWidthPx: 400,
        gridHeightPx: 300,
      },
    },
  };

  const routedNodeIndices = [];
  let redrawViewportCount = 0;
  const binding = bindCanvasClickRouting(shell, mapData, {}, {
    findNearestNodeForCanvasPixel(_mapData, xPx) {
      return { nodeIndex: Math.round(xPx) };
    },
    getAllowedModeMaskFromShell() {
      return 4;
    },
    getColourCycleMinutesFromShell() {
      return 75;
    },
    mapClientPointToCanvasPixel(_canvas, clientX, clientY) {
      return { xPx: Math.round(clientX), yPx: Math.round(clientY) };
    },
    parseNodeIndexFromLocationSearch() {
      return null;
    },
    persistNodeIndexToLocation() {},
    renderIsochroneLegendIfNeeded() {},
    async runWalkingIsochroneFromSourceNode(_shell, _mapData, nodeIndex) {
      routedNodeIndices.push(nodeIndex);
      return { cancelled: false };
    },
    setRoutingStatus() {},
    updateDistanceScaleBar() {},
    redrawViewport() {
      redrawViewportCount += 1;
    },
  });

  const viewportBefore = binding.getViewportState();
  shell.isochroneCanvas.emit('pointerdown', {
    button: 0,
    buttons: 1,
    clientX: 180,
    clientY: 140,
    pointerId: 20,
    pointerType: 'touch',
  });
  shell.isochroneCanvas.emit('pointerup', {
    button: 0,
    buttons: 0,
    clientX: 180,
    clientY: 140,
    pointerId: 20,
    pointerType: 'touch',
  });
  await flushTasks();

  assert.deepEqual(routedNodeIndices, [180]);
  assert.deepEqual(binding.getViewportState(), viewportBefore);
  assert.equal(redrawViewportCount, 0);
});

test('two-finger touch pinch zooms and two-finger drag pans without rerouting', async () => {
  const { shell } = createCanvasFixture();
  const mapData = {
    graph: {
      header: {
        nNodes: 512,
        gridWidthPx: 400,
        gridHeightPx: 300,
      },
    },
  };

  const routedNodeIndices = [];
  let scaleBarUpdateCount = 0;
  let redrawViewportCount = 0;
  const binding = bindCanvasClickRouting(shell, mapData, {}, {
    findNearestNodeForCanvasPixel(_mapData, xPx) {
      return { nodeIndex: Math.round(xPx) };
    },
    getAllowedModeMaskFromShell() {
      return 4;
    },
    getColourCycleMinutesFromShell() {
      return 75;
    },
    mapClientPointToCanvasPixel(_canvas, clientX, clientY) {
      return { xPx: Math.round(clientX), yPx: Math.round(clientY) };
    },
    parseNodeIndexFromLocationSearch() {
      return null;
    },
    persistNodeIndexToLocation() {},
    renderIsochroneLegendIfNeeded() {},
    async runWalkingIsochroneFromSourceNode(_shell, _mapData, nodeIndex) {
      routedNodeIndices.push(nodeIndex);
      return { cancelled: false };
    },
    setRoutingStatus() {},
    updateDistanceScaleBar() {
      scaleBarUpdateCount += 1;
    },
    redrawViewport() {
      redrawViewportCount += 1;
    },
  });

  shell.isochroneCanvas.emit('pointerdown', {
    button: 0,
    buttons: 1,
    clientX: 170,
    clientY: 150,
    pointerId: 30,
    pointerType: 'touch',
  });
  shell.isochroneCanvas.emit('pointerdown', {
    button: 0,
    buttons: 1,
    clientX: 230,
    clientY: 150,
    pointerId: 31,
    pointerType: 'touch',
  });

  shell.isochroneCanvas.emit('pointermove', {
    buttons: 1,
    clientX: 150,
    clientY: 150,
    pointerId: 30,
    pointerType: 'touch',
  });
  shell.isochroneCanvas.emit('pointermove', {
    buttons: 1,
    clientX: 250,
    clientY: 150,
    pointerId: 31,
    pointerType: 'touch',
  });

  const viewportAfterPinch = binding.getViewportState();
  assert.ok(viewportAfterPinch.scale > 1);
  assert.equal(scaleBarUpdateCount >= 1, true);

  const viewportBeforePan = binding.getViewportState();
  shell.isochroneCanvas.emit('pointermove', {
    buttons: 1,
    clientX: 170,
    clientY: 170,
    pointerId: 30,
    pointerType: 'touch',
  });
  shell.isochroneCanvas.emit('pointermove', {
    buttons: 1,
    clientX: 270,
    clientY: 170,
    pointerId: 31,
    pointerType: 'touch',
  });
  const viewportAfterPan = binding.getViewportState();

  shell.isochroneCanvas.emit('pointerup', {
    button: 0,
    buttons: 0,
    clientX: 170,
    clientY: 170,
    pointerId: 30,
    pointerType: 'touch',
  });
  shell.isochroneCanvas.emit('pointerup', {
    button: 0,
    buttons: 0,
    clientX: 270,
    clientY: 170,
    pointerId: 31,
    pointerType: 'touch',
  });
  await flushTasks();

  assert.deepEqual(routedNodeIndices, []);
  assert.notDeepEqual(viewportAfterPan, viewportBeforePan);
  assert.equal(redrawViewportCount >= 2, true);
});
