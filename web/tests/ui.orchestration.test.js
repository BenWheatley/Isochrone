import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bindLocationSelectControl,
  bindHeaderMenuControl,
  bindModeSelectControl,
  bindPointerButtonInversionControl,
  bindThemeControl,
  getAllowedModeMaskFromShell,
  getSpeedOptionsFromShell,
  getTransitOptionsFromShell,
  populateLocationSelect,
  updateTransitControlAvailability,
} from '../src/ui/orchestration.js';
import {
  BIKE_CRUISE_SPEED_KPH,
  DEFAULT_WALK_SPEED_KPH,
  EDGE_MODE_WATER_BIT,
} from '../src/config/constants.js';

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
    { value: 'water', selected: selectedSet.has('water') },
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

function createLocationSelect(initialValue = '') {
  const eventTarget = createEventTarget();
  const optionElements = [];
  return {
    ...eventTarget,
    tagName: 'SELECT',
    value: initialValue,
    disabled: false,
    ownerDocument: {
      createElement(tagName) {
        assert.equal(tagName, 'option');
        return {
          tagName: 'OPTION',
          value: '',
          textContent: '',
        };
      },
    },
    replaceChildren(...children) {
      optionElements.length = 0;
      optionElements.push(...children);
    },
    get options() {
      return optionElements;
    },
  };
}

function createCheckbox(initialChecked = false) {
  const eventTarget = createEventTarget();
  return {
    ...eventTarget,
    checked: initialChecked,
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

test('getAllowedModeMaskFromShell includes EDGE_MODE_WATER_BIT for the water option', () => {
  const modeSelect = createModeSelect(['water']);
  const shell = { modeSelect };

  assert.equal(getAllowedModeMaskFromShell(shell), EDGE_MODE_WATER_BIT);
});

test('getAllowedModeMaskFromShell combines walk and water bits when both selected', () => {
  const modeSelect = createModeSelect(['walk', 'water']);
  const shell = { modeSelect };

  const mask = getAllowedModeMaskFromShell(shell);
  assert.equal(mask & EDGE_MODE_WATER_BIT, EDGE_MODE_WATER_BIT);
  assert.notEqual(mask, EDGE_MODE_WATER_BIT);
});

test('getSpeedOptionsFromShell converts km/h inputs to the expected units, defaulting when missing/invalid', () => {
  assert.deepEqual(getSpeedOptionsFromShell({}), {
    walkingSpeedMps: DEFAULT_WALK_SPEED_KPH / 3.6,
    bikeCruiseSpeedKph: BIKE_CRUISE_SPEED_KPH,
  });

  const shell = {
    walkSpeedInput: createInput('7.2'),
    bikeSpeedInput: createInput('25'),
  };
  const options = getSpeedOptionsFromShell(shell);
  assert.ok(Math.abs(options.walkingSpeedMps - 7.2 / 3.6) < 1e-9);
  assert.equal(options.bikeCruiseSpeedKph, 25);

  const invalidShell = {
    walkSpeedInput: createInput('not-a-number'),
    bikeSpeedInput: createInput('-5'),
  };
  const fallbackOptions = getSpeedOptionsFromShell(invalidShell);
  assert.equal(fallbackOptions.walkingSpeedMps, DEFAULT_WALK_SPEED_KPH / 3.6);
  assert.equal(fallbackOptions.bikeCruiseSpeedKph, BIKE_CRUISE_SPEED_KPH);
});

test('getTransitOptionsFromShell parses a datetime-local value into seconds-of-day and weekday', () => {
  const shell = {
    // 2026-08-12 is a Wednesday.
    departureDatetimeInput: createInput('2026-08-12T08:30'),
    transitEnabledInput: createCheckbox(true),
    transitEnabledRow: { hidden: false },
  };

  const options = getTransitOptionsFromShell(shell);
  assert.equal(options.transitEnabled, true);
  assert.equal(options.departureSecondsOfDay, 8 * 3600 + 30 * 60);
  assert.equal(options.departureWeekdayIndex, 2);
});

test('getTransitOptionsFromShell reports transitEnabled=false when the control row is hidden', () => {
  const shell = {
    departureDatetimeInput: createInput('2026-08-12T08:30'),
    transitEnabledInput: createCheckbox(true),
    transitEnabledRow: { hidden: true },
  };

  const options = getTransitOptionsFromShell(shell);
  assert.equal(options.transitEnabled, false);
});

test('getTransitOptionsFromShell reports transitEnabled=false when the checkbox is unchecked', () => {
  const shell = {
    departureDatetimeInput: createInput('2026-08-12T08:30'),
    transitEnabledInput: createCheckbox(false),
    transitEnabledRow: { hidden: false },
  };

  const options = getTransitOptionsFromShell(shell);
  assert.equal(options.transitEnabled, false);
});

test('getTransitOptionsFromShell returns NaN for both fields on a malformed datetime value', () => {
  const shell = {
    departureDatetimeInput: createInput(''),
    transitEnabledInput: createCheckbox(true),
    transitEnabledRow: { hidden: false },
  };

  const options = getTransitOptionsFromShell(shell);
  assert.ok(Number.isNaN(options.departureSecondsOfDay));
  assert.ok(Number.isNaN(options.departureWeekdayIndex));
});

function createDateInput() {
  const attributes = {};
  return {
    value: '',
    setAttribute(name, value) {
      attributes[name] = value;
      this[name] = value;
    },
    removeAttribute(name) {
      delete attributes[name];
      delete this[name];
    },
  };
}

test('updateTransitControlAvailability shows the row and attribution, and defaults to "now" clamped into the transit date range', () => {
  const shell = {
    transitEnabledRow: { hidden: true },
    transitEnabledInput: createCheckbox(true),
    routingDisclaimerTransit: { hidden: true },
    departureDatetimeRow: { hidden: true },
    departureDatetimeInput: createDateInput(),
  };

  updateTransitControlAvailability(shell, true, {
    transitDateRange: { min: '2026-01-01', max: '2026-12-31' },
    nowIsoDatetime: '2026-08-08T09:15',
  });

  assert.equal(shell.transitEnabledRow.hidden, false);
  assert.equal(shell.transitEnabledInput.checked, true);
  assert.equal(shell.routingDisclaimerTransit.hidden, false);
  assert.equal(shell.departureDatetimeRow.hidden, false);
  assert.equal(shell.departureDatetimeInput.min, '2026-01-01T00:00');
  assert.equal(shell.departureDatetimeInput.max, '2026-12-31T23:59');
  assert.equal(shell.departureDatetimeInput.value, '2026-08-08T09:15');
});

test('updateTransitControlAvailability clamps "now" to the range bounds (keeping time-of-day) when now falls outside it', () => {
  const shell = {
    transitEnabledRow: { hidden: true },
    transitEnabledInput: createCheckbox(true),
    routingDisclaimerTransit: { hidden: true },
    departureDatetimeRow: { hidden: true },
    departureDatetimeInput: createDateInput(),
  };

  updateTransitControlAvailability(shell, true, {
    transitDateRange: { min: '2026-09-01', max: '2026-12-31' },
    nowIsoDatetime: '2026-08-08T09:15',
  });

  assert.equal(shell.departureDatetimeInput.value, '2026-09-01T09:15');
});

test('updateTransitControlAvailability preserves an existing value already within the transit date range', () => {
  const shell = {
    transitEnabledRow: { hidden: true },
    transitEnabledInput: createCheckbox(true),
    routingDisclaimerTransit: { hidden: true },
    departureDatetimeRow: { hidden: true },
    departureDatetimeInput: createDateInput(),
  };
  shell.departureDatetimeInput.value = '2026-10-05T14:00';

  updateTransitControlAvailability(shell, true, {
    transitDateRange: { min: '2026-09-01', max: '2026-12-31' },
    nowIsoDatetime: '2026-08-08T09:15',
  });

  assert.equal(shell.departureDatetimeInput.value, '2026-10-05T14:00');
});

test('updateTransitControlAvailability hides the row, attribution, and resets the checkbox when transit data is absent', () => {
  const shell = {
    transitEnabledRow: { hidden: false },
    transitEnabledInput: createCheckbox(true),
    routingDisclaimerTransit: { hidden: false },
    departureDatetimeRow: { hidden: false },
    departureDatetimeInput: createDateInput(),
  };
  shell.departureDatetimeInput.min = '2026-08-12T00:00';
  shell.departureDatetimeInput.max = '2026-08-12T23:59';
  shell.departureDatetimeInput.value = '2026-08-12T08:00';

  updateTransitControlAvailability(shell, false);

  assert.equal(shell.transitEnabledRow.hidden, true);
  assert.equal(shell.transitEnabledInput.checked, false);
  assert.equal(shell.routingDisclaimerTransit.hidden, true);
  assert.equal(shell.departureDatetimeRow.hidden, true);
  assert.equal(shell.departureDatetimeInput.min, undefined);
  assert.equal(shell.departureDatetimeInput.max, undefined);
  assert.equal(shell.departureDatetimeInput.value, '');
});

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

test('bindModeSelectControl redraws and persists on walk/bike speed and departure datetime changes', () => {
  const modeSelect = createModeSelect(['car']);
  const colourCycleMinutesInput = createInput('75');
  const walkSpeedInput = createInput('5');
  const bikeSpeedInput = createInput('20');
  const departureDatetimeInput = createInput('2026-08-12T08:00');
  const shell = {
    modeSelect,
    colourCycleMinutesInput,
    walkSpeedInput,
    bikeSpeedInput,
    departureDatetimeInput,
    isochroneLegend: {},
  };

  let redrawRequestCount = 0;
  const binding = bindModeSelectControl(shell, {
    renderIsochroneLegendIfNeeded() {},
    requestIsochroneRedraw() {
      redrawRequestCount += 1;
      return true;
    },
  });

  walkSpeedInput.value = '7';
  walkSpeedInput.emit('change');
  assert.equal(redrawRequestCount, 1);

  bikeSpeedInput.value = '25';
  bikeSpeedInput.emit('change');
  assert.equal(redrawRequestCount, 2);

  departureDatetimeInput.value = '2026-08-13T09:15';
  departureDatetimeInput.emit('change');
  assert.equal(redrawRequestCount, 3);

  binding.dispose();
  walkSpeedInput.emit('change');
  bikeSpeedInput.emit('change');
  departureDatetimeInput.emit('change');
  assert.equal(redrawRequestCount, 3);
});


test('populateLocationSelect replaces options and selects the requested location', () => {
  const locationSelect = createLocationSelect();
  const shell = { locationSelect };

  const selectedLocationId = populateLocationSelect(
    shell,
    [
      { id: 'berlin', name: 'Berlin' },
      { id: 'paris', name: 'Paris' },
    ],
    'paris',
  );

  assert.equal(selectedLocationId, 'paris');
  assert.equal(locationSelect.value, 'paris');
  assert.deepEqual(
    locationSelect.options.map((option) => ({ value: option.value, textContent: option.textContent })),
    [
      { value: 'berlin', textContent: 'Berlin' },
      { value: 'paris', textContent: 'Paris' },
    ],
  );
});

test('bindLocationSelectControl notifies when the selected location changes', () => {
  const locationSelect = createLocationSelect('berlin');
  const shell = { locationSelect };
  const changedLocationIds = [];
  const binding = bindLocationSelectControl(shell, {
    onLocationChange(locationId) {
      changedLocationIds.push(locationId);
    },
  });

  locationSelect.value = 'paris';
  locationSelect.emit('change');
  assert.deepEqual(changedLocationIds, ['paris']);

  binding.dispose();
  locationSelect.value = 'berlin';
  locationSelect.emit('change');
  assert.deepEqual(changedLocationIds, ['paris']);
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

test('bindPointerButtonInversionControl restores persisted checkbox state and persists changes', () => {
  const invertPointerButtonsInput = createCheckbox(false);
  const shell = { invertPointerButtonsInput };
  let storedValue = '1';
  const storage = {
    getItem(key) {
      assert.equal(key, 'isochrone-invert-pointer-buttons');
      return storedValue;
    },
    setItem(key, value) {
      assert.equal(key, 'isochrone-invert-pointer-buttons');
      storedValue = value;
    },
  };

  const binding = bindPointerButtonInversionControl(shell, { storage });
  assert.equal(invertPointerButtonsInput.checked, true);

  invertPointerButtonsInput.checked = false;
  invertPointerButtonsInput.emit('change');
  assert.equal(storedValue, '0');

  binding.dispose();
  invertPointerButtonsInput.checked = true;
  invertPointerButtonsInput.emit('change');
  assert.equal(storedValue, '0');
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
