import assert from 'node:assert/strict';
import test from 'node:test';

import { bindModeSelectControl, bindThemeControl } from '../src/ui/orchestration.js';

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
    emit(type) {
      const listenerSet = listeners.get(type);
      if (!listenerSet) {
        return;
      }
      for (const listener of listenerSet) {
        listener({ type });
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

test('bindModeSelectControl requests isochrone redraw on mode and cycle changes', () => {
  const modeSelect = createModeSelect(['car']);
  const colourCycleMinutesInput = createInput('75');
  const shell = {
    modeSelect,
    colourCycleMinutesInput,
    isochroneLegend: {},
  };

  let redrawRequestCount = 0;
  let legendRenderCount = 0;
  const binding = bindModeSelectControl(shell, {
    renderIsochroneLegendIfNeeded() {
      legendRenderCount += 1;
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

  colourCycleMinutesInput.value = '90';
  colourCycleMinutesInput.emit('change');
  assert.equal(redrawRequestCount, 2);
  assert.equal(legendRenderCount, 2);

  binding.dispose();
  modeSelect.emit('change');
  colourCycleMinutesInput.emit('change');
  assert.equal(redrawRequestCount, 2);
  assert.equal(legendRenderCount, 2);
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
