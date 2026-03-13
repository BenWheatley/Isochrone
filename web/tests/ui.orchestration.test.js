import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bindHeaderMenuControl,
  bindModeSelectControl,
  bindThemeControl,
} from '../src/ui/orchestration.js';

function createEventTarget() {
  const listeners = new Map();
  return {
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
        listener({ type, ...event });
      }
    },
  };
}

function createModeSelect(selectedValues = ['car']) {
  const eventTarget = createEventTarget();
  const selectedSet = new Set(selectedValues);
  const options = [
    { value: 'walk', selected: selectedSet.has('walk') },
    { value: 'bike', selected: selectedSet.has('bike') },
    { value: 'car', selected: selectedSet.has('car') },
  ];

  return {
    ...eventTarget,
    options,
    get selectedOptions() {
      return options.filter((option) => option.selected);
    },
  };
}

function createInput(initialValue = '75') {
  const eventTarget = createEventTarget();
  return {
    ...eventTarget,
    value: initialValue,
  };
}

function createThemeSelect(initialValue = 'light') {
  const eventTarget = createEventTarget();
  return {
    ...eventTarget,
    value: initialValue,
  };
}

function createHeaderMenuFixture() {
  const insideTargets = new Set();
  const controlsMenu = {
    tagName: 'DETAILS',
    open: false,
    contains(target) {
      return insideTargets.has(target);
    },
  };
  const controlsMenuSummary = {
    tagName: 'SUMMARY',
    focusCallCount: 0,
    focus() {
      this.focusCallCount += 1;
    },
  };
  insideTargets.add(controlsMenu);
  insideTargets.add(controlsMenuSummary);
  return {
    controlsMenu,
    controlsMenuSummary,
    insideTargets,
  };
}

test('bindModeSelectControl uses redraw for mode changes and repaint for cycle changes', () => {
  const modeSelect = createModeSelect(['car']);
  const colourCycleMinutesInput = createInput('75');
  const shell = {
    modeSelect,
    colourCycleMinutesInput,
    isochroneLegend: {},
  };

  let redrawRequestCount = 0;
  let repaintRequestCount = 0;
  let legendRenderCount = 0;
  const binding = bindModeSelectControl(shell, {
    renderIsochroneLegendIfNeeded() {
      legendRenderCount += 1;
    },
    requestIsochroneRepaint() {
      repaintRequestCount += 1;
      return true;
    },
    requestIsochroneRedraw() {
      redrawRequestCount += 1;
      return true;
    },
  });

  assert.equal(redrawRequestCount, 0);
  assert.equal(legendRenderCount, 1);

  modeSelect.options[2].selected = false;
  modeSelect.options[0].selected = true;
  modeSelect.emit('change');
  assert.equal(redrawRequestCount, 1);
  assert.equal(repaintRequestCount, 0);

  colourCycleMinutesInput.value = '90';
  colourCycleMinutesInput.emit('change');
  assert.equal(redrawRequestCount, 1);
  assert.equal(repaintRequestCount, 1);
  assert.equal(legendRenderCount, 2);

  binding.dispose();
  modeSelect.emit('change');
  colourCycleMinutesInput.emit('change');
  assert.equal(redrawRequestCount, 1);
  assert.equal(repaintRequestCount, 1);
  assert.equal(legendRenderCount, 2);
});

test('bindModeSelectControl falls back to redraw when cycle repaint is unavailable', () => {
  const modeSelect = createModeSelect(['car']);
  const colourCycleMinutesInput = createInput('75');
  const shell = {
    modeSelect,
    colourCycleMinutesInput,
    isochroneLegend: {},
  };

  let redrawRequestCount = 0;
  let repaintRequestCount = 0;
  let legendRenderCount = 0;
  const binding = bindModeSelectControl(shell, {
    renderIsochroneLegendIfNeeded() {
      legendRenderCount += 1;
    },
    requestIsochroneRepaint() {
      repaintRequestCount += 1;
      return false;
    },
    requestIsochroneRedraw() {
      redrawRequestCount += 1;
      return true;
    },
  });

  colourCycleMinutesInput.value = '120';
  colourCycleMinutesInput.emit('change');
  assert.equal(repaintRequestCount, 1);
  assert.equal(redrawRequestCount, 1);
  assert.equal(legendRenderCount, 2);

  binding.dispose();
});

test('bindThemeControl restores persisted theme and persists changes', () => {
  const themeSelect = createThemeSelect('light');
  const shell = { themeSelect };
  const rootElement = { dataset: {} };
  const themeChangeEvents = [];
  let storedValue = 'dark';
  const storage = {
    getItem(key) {
      assert.equal(key, 'isochrone-theme');
      return storedValue;
    },
    setItem(key, value) {
      assert.equal(key, 'isochrone-theme');
      storedValue = value;
    },
  };

  const binding = bindThemeControl(shell, {
    rootElement,
    storage,
    onThemeChange(themeValue) {
      themeChangeEvents.push(themeValue);
    },
  });
  assert.equal(themeSelect.value, 'dark');
  assert.equal(rootElement.dataset.theme, 'dark');
  assert.deepEqual(themeChangeEvents, []);

  themeSelect.value = 'light';
  themeSelect.emit('change');
  assert.equal(rootElement.dataset.theme, 'light');
  assert.equal(storedValue, 'light');
  assert.deepEqual(themeChangeEvents, ['light']);

  binding.dispose();
  themeSelect.value = 'dark';
  themeSelect.emit('change');
  assert.equal(rootElement.dataset.theme, 'light');
});

test('bindThemeControl setTheme supports non-persistent temporary overrides', () => {
  const themeSelect = createThemeSelect('dark');
  const shell = { themeSelect };
  const rootElement = { dataset: {} };
  const persistedWrites = [];
  const storage = {
    getItem() {
      return 'dark';
    },
    setItem(key, value) {
      persistedWrites.push([key, value]);
    },
  };
  const changeEvents = [];

  const binding = bindThemeControl(shell, {
    rootElement,
    storage,
    onThemeChange(themeValue) {
      changeEvents.push(themeValue);
    },
  });

  binding.setTheme('light', { persist: false, notify: true });
  assert.equal(rootElement.dataset.theme, 'light');
  assert.equal(themeSelect.value, 'light');
  assert.deepEqual(changeEvents, ['light']);
  assert.deepEqual(persistedWrites, []);

  binding.dispose();
});

test('bindHeaderMenuControl closes menu on outside pointerdown and Escape key', () => {
  const eventRoot = createEventTarget();
  const { controlsMenu, controlsMenuSummary, insideTargets } = createHeaderMenuFixture();
  const shell = {
    controlsMenu,
    controlsMenuSummary,
  };
  const binding = bindHeaderMenuControl(shell, { eventRoot });

  const outsideTarget = {};
  controlsMenu.open = true;
  eventRoot.emit('pointerdown', { target: controlsMenuSummary });
  assert.equal(controlsMenu.open, true);

  controlsMenu.open = true;
  eventRoot.emit('pointerdown', { target: outsideTarget });
  assert.equal(controlsMenu.open, false);

  controlsMenu.open = true;
  eventRoot.emit('keydown', { key: 'Enter', target: outsideTarget });
  assert.equal(controlsMenu.open, true);
  assert.equal(controlsMenuSummary.focusCallCount, 0);

  controlsMenu.open = true;
  eventRoot.emit('keydown', { key: 'Escape', target: outsideTarget });
  assert.equal(controlsMenu.open, false);
  assert.equal(controlsMenuSummary.focusCallCount, 1);

  binding.dispose();
  controlsMenu.open = true;
  eventRoot.emit('pointerdown', { target: outsideTarget });
  eventRoot.emit('keydown', { key: 'Escape', target: outsideTarget });
  assert.equal(controlsMenu.open, true);
  assert.equal(controlsMenuSummary.focusCallCount, 1);
  assert.equal(insideTargets.has(controlsMenu), true);
});
