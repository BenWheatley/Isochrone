import {
  BIKE_CRUISE_SPEED_KPH,
  DEFAULT_COLOUR_CYCLE_MINUTES,
  DEFAULT_TRANSIT_WALK_BUDGET_MINUTES,
  DEFAULT_WALK_SPEED_KPH,
  EDGE_MODE_BIKE_BIT,
  EDGE_MODE_CAR_BIT,
  EDGE_MODE_WALK_BIT,
  EDGE_MODE_WATER_BIT,
  TRANSIT_ONLY_ALLOWED_MODE_MASK,
} from '../config/constants.js';
import {
  parseBikeSpeedKphFromLocationSearch,
  parseColourCycleMinutesFromLocationSearch,
  parseDepartureDatetimeFromLocationSearch,
  parseModeValuesFromLocationSearch,
  parseTransitWalkBudgetMinutesFromLocationSearch,
  parseWalkSpeedKphFromLocationSearch,
  persistBikeSpeedKphToLocation,
  persistColourCycleMinutesToLocation,
  persistDepartureDatetimeToLocation,
  persistModeValuesToLocation,
  persistTransitWalkBudgetMinutesToLocation,
  persistWalkSpeedKphToLocation,
} from '../core/coords.js';
import {
  displaySpeedToKph,
  kphToDisplaySpeed,
  normalizeUnitSystem,
  resolveDefaultUnitSystem,
  speedUnitLabel,
} from './units.js';
import {
  applyCommonMessagesToDocument,
  getCommonMessage,
} from './localization.js';

const CANONICAL_MODE_VALUES = ['walk', 'bike', 'car', 'water', 'transit'];
const CANONICAL_THEME_VALUES = ['light', 'dark', 'auto'];
const THEME_STORAGE_KEY = 'isochrone-theme';
const POINTER_BUTTON_INVERSION_STORAGE_KEY = 'isochrone-invert-pointer-buttons';
const UNIT_SYSTEM_STORAGE_KEY = 'isochrone-unit-system';

export function initializeAppShell(doc, options = {}) {
  const resolvedDocument = doc ?? globalThis.document;
  if (!resolvedDocument) {
    throw new Error('document is not available');
  }

  const mapRegion = resolvedDocument.getElementById('map-region');
  const isochroneCanvas =
    resolvedDocument.getElementById('isochrone') ?? resolvedDocument.getElementById('map');
  const boundaryCanvas = resolvedDocument.getElementById('boundaries');
  const canvasStack = resolvedDocument.getElementById('canvas-stack');
  const controlsMenu = resolvedDocument.getElementById('controls-menu');
  const controlsMenuSummary = resolvedDocument.getElementById('controls-menu-summary');
  const locationSelect = resolvedDocument.getElementById('location-select');
  const loadingOverlay = resolvedDocument.getElementById('loading');
  const loadingText = resolvedDocument.getElementById('loading-text');
  const loadingProgressBar = resolvedDocument.getElementById('loading-progress-bar');
  const routingStatus = resolvedDocument.getElementById('routing-status');
  const renderBackendBadge = resolvedDocument.getElementById('render-backend-badge');
  const routingDisclaimer = resolvedDocument.getElementById('routing-disclaimer');
  const routingDisclaimerOsm = resolvedDocument.getElementById('routing-disclaimer-osm');
  const routingDisclaimerTransit = resolvedDocument.getElementById('routing-disclaimer-transit');
  const themeRadios = Array.from(resolvedDocument.querySelectorAll('input[name="theme"]'));
  const unitSystemRadios = Array.from(
    resolvedDocument.querySelectorAll('input[name="unit-system"]'),
  );
  const speedUnitLabelElement = resolvedDocument.getElementById('speed-unit-label');
  const invertPointerButtonsInput = resolvedDocument.getElementById('invert-pointer-buttons');
  const modeCheckboxGroup = resolvedDocument.getElementById('mode-checkbox-group');
  const modeCheckboxes = Array.from(resolvedDocument.querySelectorAll('.mode-checkbox'));
  const colourCycleMinutesInput = resolvedDocument.getElementById('colour-cycle-minutes');
  const walkSpeedInput = resolvedDocument.getElementById('walk-speed-kph');
  const bikeSpeedInput = resolvedDocument.getElementById('bike-speed-kph');
  const transitWalkBudgetRow = resolvedDocument.getElementById('transit-walk-budget-row');
  const transitWalkBudgetInput = resolvedDocument.getElementById('transit-walk-budget-minutes');
  const departureDatetimeRow = resolvedDocument.getElementById('departure-datetime-row');
  const departureDatetimeInput = resolvedDocument.getElementById('departure-datetime');
  const transitEnabledRow = resolvedDocument.getElementById('transit-enabled-row');
  const transitEnabledInput = resolvedDocument.getElementById('transit-enabled');
  const exportSvgButton = resolvedDocument.getElementById('export-svg-button');
  const printButton = resolvedDocument.getElementById('print-button');
  const distanceScale = resolvedDocument.getElementById('distance-scale');
  const distanceScaleLine = resolvedDocument.getElementById('distance-scale-line');
  const distanceScaleLabel = resolvedDocument.getElementById('distance-scale-label');
  const isochroneLegend = resolvedDocument.getElementById('isochrone-legend');

  if (!mapRegion || mapRegion.tagName !== 'SECTION') {
    throw new Error('index.html is missing <section id="map-region">');
  }
  if (!isochroneCanvas || isochroneCanvas.tagName !== 'CANVAS') {
    throw new Error('index.html is missing <canvas id="isochrone">');
  }
  if (!boundaryCanvas || boundaryCanvas.tagName !== 'CANVAS') {
    throw new Error('index.html is missing <canvas id="boundaries">');
  }
  if (!canvasStack || canvasStack.tagName !== 'DIV') {
    throw new Error('index.html is missing <div id="canvas-stack">');
  }
  if (!controlsMenu || controlsMenu.tagName !== 'DETAILS') {
    throw new Error('index.html is missing <details id="controls-menu">');
  }
  if (!controlsMenuSummary || controlsMenuSummary.tagName !== 'SUMMARY') {
    throw new Error('index.html is missing <summary id="controls-menu-summary">');
  }
  if (!locationSelect || locationSelect.tagName !== 'SELECT') {
    throw new Error('index.html is missing <select id="location-select">');
  }
  if (!loadingOverlay || loadingOverlay.tagName !== 'DIV') {
    throw new Error('index.html is missing <div id="loading">');
  }
  if (!loadingText || loadingText.tagName !== 'DIV') {
    throw new Error('index.html is missing <div id="loading-text">');
  }
  if (!loadingProgressBar || loadingProgressBar.tagName !== 'DIV') {
    throw new Error('index.html is missing <div id="loading-progress-bar">');
  }
  if (!routingStatus || routingStatus.tagName !== 'DIV') {
    throw new Error('index.html is missing <div id="routing-status">');
  }
  if (!renderBackendBadge || renderBackendBadge.tagName !== 'DIV') {
    throw new Error('index.html is missing <div id="render-backend-badge">');
  }
  if (!routingDisclaimer || routingDisclaimer.tagName !== 'DIV') {
    throw new Error('index.html is missing <div id="routing-disclaimer">');
  }
  if (!routingDisclaimerOsm || routingDisclaimerOsm.tagName !== 'SPAN') {
    throw new Error('index.html is missing <span id="routing-disclaimer-osm">');
  }
  if (!routingDisclaimerTransit || routingDisclaimerTransit.tagName !== 'SPAN') {
    throw new Error('index.html is missing <span id="routing-disclaimer-transit">');
  }
  if (themeRadios.length !== 3 || themeRadios.some((radio) => radio.tagName !== 'INPUT')) {
    throw new Error('index.html is missing three <input type="radio" name="theme"> elements');
  }
  if (unitSystemRadios.length !== 2 || unitSystemRadios.some((radio) => radio.tagName !== 'INPUT')) {
    throw new Error('index.html is missing two <input type="radio" name="unit-system"> elements');
  }
  if (!speedUnitLabelElement || speedUnitLabelElement.tagName !== 'SPAN') {
    throw new Error('index.html is missing <span id="speed-unit-label">');
  }
  if (!invertPointerButtonsInput || invertPointerButtonsInput.tagName !== 'INPUT') {
    throw new Error('index.html is missing <input id="invert-pointer-buttons">');
  }
  if (!modeCheckboxGroup || modeCheckboxGroup.tagName !== 'FIELDSET') {
    throw new Error('index.html is missing <fieldset id="mode-checkbox-group">');
  }
  if (modeCheckboxes.length === 0) {
    throw new Error('index.html is missing .mode-checkbox inputs inside #mode-checkbox-group');
  }
  if (!colourCycleMinutesInput || colourCycleMinutesInput.tagName !== 'INPUT') {
    throw new Error('index.html is missing <input id="colour-cycle-minutes">');
  }
  if (!walkSpeedInput || walkSpeedInput.tagName !== 'INPUT') {
    throw new Error('index.html is missing <input id="walk-speed-kph">');
  }
  if (!bikeSpeedInput || bikeSpeedInput.tagName !== 'INPUT') {
    throw new Error('index.html is missing <input id="bike-speed-kph">');
  }
  if (!transitWalkBudgetRow || transitWalkBudgetRow.tagName !== 'DIV') {
    throw new Error('index.html is missing <div id="transit-walk-budget-row">');
  }
  if (!transitWalkBudgetInput || transitWalkBudgetInput.tagName !== 'INPUT') {
    throw new Error('index.html is missing <input id="transit-walk-budget-minutes">');
  }
  if (!departureDatetimeRow || departureDatetimeRow.tagName !== 'DIV') {
    throw new Error('index.html is missing <div id="departure-datetime-row">');
  }
  if (!departureDatetimeInput || departureDatetimeInput.tagName !== 'INPUT') {
    throw new Error('index.html is missing <input id="departure-datetime">');
  }
  if (!transitEnabledRow || transitEnabledRow.tagName !== 'LABEL') {
    throw new Error('index.html is missing <label id="transit-enabled-row">');
  }
  if (!transitEnabledInput || transitEnabledInput.tagName !== 'INPUT') {
    throw new Error('index.html is missing <input id="transit-enabled">');
  }
  if (!exportSvgButton || exportSvgButton.tagName !== 'BUTTON') {
    throw new Error('index.html is missing <button id="export-svg-button">');
  }
  if (!printButton || printButton.tagName !== 'BUTTON') {
    throw new Error('index.html is missing <button id="print-button">');
  }
  if (!distanceScale || distanceScale.tagName !== 'DIV') {
    throw new Error('index.html is missing <div id="distance-scale">');
  }
  if (!distanceScaleLine || distanceScaleLine.tagName !== 'DIV') {
    throw new Error('index.html is missing <div id="distance-scale-line">');
  }
  if (!distanceScaleLabel || distanceScaleLabel.tagName !== 'DIV') {
    throw new Error('index.html is missing <div id="distance-scale-label">');
  }
  if (!isochroneLegend || isochroneLegend.tagName !== 'DIV') {
    throw new Error('index.html is missing <div id="isochrone-legend">');
  }

  const localeBundle = applyCommonMessagesToDocument(resolvedDocument, options.localeBundle);

  sizeCanvasToCssPixels(isochroneCanvas);
  sizeCanvasToCssPixels(boundaryCanvas);

  isochroneCanvas.style.pointerEvents = 'none';
  isochroneCanvas.dataset.graphLoaded = 'false';
  loadingOverlay.hidden = false;
  loadingOverlay.classList.remove('is-fading');
  loadingText.textContent = getCommonMessage(
    localeBundle.messages,
    'body.loading.boundaries',
    loadingText.textContent,
  );
  setLoadingProgressBar(loadingProgressBar, 0);
  routingStatus.textContent = getCommonMessage(localeBundle.messages, 'status.ready', routingStatus.textContent);
  renderBackendBadge.textContent = getCommonMessage(
    localeBundle.messages,
    'status.renderer.detecting',
    renderBackendBadge.textContent,
  );
  exportSvgButton.disabled = true;
  printButton.disabled = true;
  const locationSearch = globalThis.location?.search ?? '';
  const persistedModeValues = parseModeValuesFromLocationSearch(locationSearch);
  if (persistedModeValues !== null && persistedModeValues.length > 0) {
    setSelectedModeValues(modeCheckboxes, persistedModeValues);
  } else {
    setSelectedModeValues(modeCheckboxes, ['car']);
  }

  const persistedCycleMinutes = parseColourCycleMinutesFromLocationSearch(locationSearch);
  if (persistedCycleMinutes === null) {
    colourCycleMinutesInput.value = String(DEFAULT_COLOUR_CYCLE_MINUTES);
  } else {
    colourCycleMinutesInput.value = String(persistedCycleMinutes);
  }

  const persistedWalkSpeedKph = parseWalkSpeedKphFromLocationSearch(locationSearch);
  walkSpeedInput.value = String(persistedWalkSpeedKph ?? DEFAULT_WALK_SPEED_KPH);

  const persistedBikeSpeedKph = parseBikeSpeedKphFromLocationSearch(locationSearch);
  bikeSpeedInput.value = String(persistedBikeSpeedKph ?? BIKE_CRUISE_SPEED_KPH);

  const persistedTransitWalkBudgetMinutes =
    parseTransitWalkBudgetMinutesFromLocationSearch(locationSearch);
  transitWalkBudgetInput.value = String(
    persistedTransitWalkBudgetMinutes ?? DEFAULT_TRANSIT_WALK_BUDGET_MINUTES,
  );

  const persistedDepartureDatetime = parseDepartureDatetimeFromLocationSearch(locationSearch);
  if (persistedDepartureDatetime !== null) {
    departureDatetimeInput.value = persistedDepartureDatetime;
  }

  return {
    mapRegion,
    isochroneCanvas,
    mapCanvas: isochroneCanvas,
    boundaryCanvas,
    canvasStack,
    controlsMenu,
    controlsMenuSummary,
    locationSelect,
    loadingOverlay,
    loadingText,
    loadingProgressBar,
    routingStatus,
    renderBackendBadge,
    routingDisclaimer,
    routingDisclaimerOsm,
    routingDisclaimerTransit,
    themeRadios,
    unitSystemRadios,
    speedUnitLabelElement,
    invertPointerButtonsInput,
    modeCheckboxGroup,
    modeCheckboxes,
    colourCycleMinutesInput,
    walkSpeedInput,
    bikeSpeedInput,
    transitWalkBudgetRow,
    transitWalkBudgetInput,
    departureDatetimeRow,
    departureDatetimeInput,
    transitEnabledRow,
    transitEnabledInput,
    exportSvgButton,
    printButton,
    distanceScale,
    distanceScaleLine,
    distanceScaleLabel,
    isochroneLegend,
    locale: localeBundle.locale,
    localeMessages: localeBundle.messages,
    loadingFadeTimeoutId: null,
    lastRenderedLegendCycleMinutes: null,
    lastRenderedLegendLocale: null,
  };
}

export function populateLocationSelect(shell, locations, selectedLocationId = '') {
  if (!shell || typeof shell !== 'object' || !shell.locationSelect) {
    throw new Error('shell.locationSelect is required');
  }
  if (!Array.isArray(locations) || locations.length === 0) {
    throw new Error('locations must be a non-empty array');
  }
  if (
    !shell.locationSelect.ownerDocument
    || typeof shell.locationSelect.ownerDocument.createElement !== 'function'
    || typeof shell.locationSelect.replaceChildren !== 'function'
  ) {
    throw new Error('shell.locationSelect must support DOM option creation');
  }

  const optionElements = locations.map((location) => {
    const option = shell.locationSelect.ownerDocument.createElement('option');
    option.value = location.id;
    option.textContent = location.name;
    return option;
  });
  shell.locationSelect.replaceChildren(...optionElements);
  const hasSelectedLocationId = locations.some((location) => location.id === selectedLocationId);
  shell.locationSelect.value = hasSelectedLocationId ? selectedLocationId : locations[0].id;
  return shell.locationSelect.value;
}

export function bindLocationSelectControl(shell, options = {}) {
  if (!shell || typeof shell !== 'object' || !shell.locationSelect) {
    throw new Error('shell.locationSelect is required');
  }
  const onLocationChange = options.onLocationChange ?? null;
  if (typeof onLocationChange !== 'function') {
    throw new Error('options.onLocationChange must be a function');
  }

  const handleChange = () => {
    onLocationChange(shell.locationSelect.value);
  };
  shell.locationSelect.addEventListener('change', handleChange);

  return {
    dispose() {
      shell.locationSelect.removeEventListener('change', handleChange);
    },
  };
}

export function bindPointerButtonInversionControl(shell, options = {}) {
  if (!shell || typeof shell !== 'object' || !shell.invertPointerButtonsInput) {
    throw new Error('shell.invertPointerButtonsInput is required');
  }

  const storage = options.storage ?? globalThis.localStorage ?? null;
  const storageKey = options.storageKey ?? POINTER_BUTTON_INVERSION_STORAGE_KEY;
  if (typeof storageKey !== 'string' || storageKey.length === 0) {
    throw new Error('storageKey must be a non-empty string');
  }

  const setChecked = (checked, persist = true) => {
    shell.invertPointerButtonsInput.checked = checked === true;
    if (persist) {
      safeStorageSet(storage, storageKey, checked === true ? '1' : '0');
    }
    return shell.invertPointerButtonsInput.checked;
  };

  const persistedValue = safeStorageGet(storage, storageKey);
  setChecked(
    persistedValue === '1' || persistedValue === 'true' || persistedValue === 'yes' || persistedValue === 'on',
    false,
  );

  const handleChange = () => {
    setChecked(shell.invertPointerButtonsInput.checked, true);
  };

  shell.invertPointerButtonsInput.addEventListener('change', handleChange);

  return {
    dispose() {
      shell.invertPointerButtonsInput.removeEventListener('change', handleChange);
    },
    setChecked(checked, applyOptions = {}) {
      return setChecked(checked, applyOptions.persist !== false);
    },
  };
}

export function bindHeaderMenuControl(shell, options = {}) {
  if (!shell || typeof shell !== 'object' || !shell.controlsMenu) {
    throw new Error('shell.controlsMenu is required');
  }
  if (shell.controlsMenu.tagName !== 'DETAILS') {
    throw new Error('shell.controlsMenu must be a <details> element');
  }
  if (shell.controlsMenuSummary && shell.controlsMenuSummary.tagName !== 'SUMMARY') {
    throw new Error('shell.controlsMenuSummary must be a <summary> element when provided');
  }

  const eventRoot = options.eventRoot ?? globalThis.document ?? null;
  if (
    !eventRoot
    || typeof eventRoot.addEventListener !== 'function'
    || typeof eventRoot.removeEventListener !== 'function'
  ) {
    throw new Error('eventRoot with addEventListener/removeEventListener is required');
  }

  const closeMenu = () => {
    if (!shell.controlsMenu.open) {
      return false;
    }
    shell.controlsMenu.open = false;
    return true;
  };

  const handlePointerDown = (event) => {
    if (!shell.controlsMenu.open) {
      return;
    }
    const target = event?.target ?? null;
    if (target !== null && typeof shell.controlsMenu.contains === 'function') {
      if (shell.controlsMenu.contains(target)) {
        return;
      }
    }
    closeMenu();
  };

  const handleKeyDown = (event) => {
    if (!shell.controlsMenu.open) {
      return;
    }
    if (event?.key !== 'Escape') {
      return;
    }
    closeMenu();
    if (shell.controlsMenuSummary && typeof shell.controlsMenuSummary.focus === 'function') {
      shell.controlsMenuSummary.focus();
    }
  };

  eventRoot.addEventListener('pointerdown', handlePointerDown);
  eventRoot.addEventListener('keydown', handleKeyDown);

  return {
    closeMenu,
    dispose() {
      eventRoot.removeEventListener('pointerdown', handlePointerDown);
      eventRoot.removeEventListener('keydown', handleKeyDown);
    },
  };
}

function getCheckedThemeRadioValue(themeRadios) {
  const checkedRadio = themeRadios.find((radio) => radio.checked);
  return checkedRadio?.value ?? themeRadios[0]?.value;
}

export function bindThemeControl(shell, options = {}) {
  if (!shell || typeof shell !== 'object' || !Array.isArray(shell.themeRadios) || shell.themeRadios.length === 0) {
    throw new Error('shell.themeRadios is required');
  }

  const rootElement = options.rootElement ?? globalThis.document?.documentElement ?? null;
  if (!rootElement || typeof rootElement !== 'object' || typeof rootElement.dataset !== 'object') {
    throw new Error('rootElement with dataset is required');
  }
  const storage = options.storage ?? globalThis.localStorage ?? null;
  const storageKey = options.storageKey ?? THEME_STORAGE_KEY;
  const onThemeChange = options.onThemeChange ?? null;
  if (typeof storageKey !== 'string' || storageKey.length === 0) {
    throw new Error('storageKey must be a non-empty string');
  }
  if (onThemeChange !== null && typeof onThemeChange !== 'function') {
    throw new Error('onThemeChange must be a function when provided');
  }

  const setTheme = (themeValue, persist = true) => {
    const normalizedTheme = normalizeThemeValue(
      themeValue,
      normalizeThemeValue(getCheckedThemeRadioValue(shell.themeRadios)),
    );
    for (const radio of shell.themeRadios) {
      radio.checked = radio.value === normalizedTheme;
    }
    rootElement.dataset.theme = normalizedTheme;
    if (persist) {
      safeStorageSet(storage, storageKey, normalizedTheme);
    }
    return normalizedTheme;
  };

  const applyTheme = (themeValue, applyOptions = {}) => {
    const persist = applyOptions.persist !== false;
    const notify = applyOptions.notify === true;
    const nextTheme = setTheme(themeValue, persist);
    if (notify && onThemeChange) {
      onThemeChange(nextTheme);
    }
    return nextTheme;
  };

  const persistedTheme = safeStorageGet(storage, storageKey);
  setTheme(persistedTheme, false);

  const handleThemeChange = (event) => {
    applyTheme(event.target.value, { persist: true, notify: true });
  };
  for (const radio of shell.themeRadios) {
    radio.addEventListener('change', handleThemeChange);
  }

  // While "Auto" is selected, the CSS variables already follow OS changes
  // on their own via @media (prefers-color-scheme), but JS-rendered
  // surfaces (the WebGL canvas, the legend) only know to recompute when
  // notified - re-applying "auto" on every OS preference flip keeps them
  // in sync without the radio selection itself changing.
  const darkSchemeMediaQuery = options.matchMedia
    ?? globalThis.matchMedia?.('(prefers-color-scheme: dark)')
    ?? null;
  const handleColorSchemeChange = () => {
    if (rootElement.dataset.theme === 'auto') {
      applyTheme('auto', { persist: false, notify: true });
    }
  };
  darkSchemeMediaQuery?.addEventListener?.('change', handleColorSchemeChange);

  return {
    dispose() {
      for (const radio of shell.themeRadios) {
        radio.removeEventListener('change', handleThemeChange);
      }
      darkSchemeMediaQuery?.removeEventListener?.('change', handleColorSchemeChange);
    },
    setTheme(themeValue, applyOptions = {}) {
      return applyTheme(themeValue, applyOptions);
    },
  };
}

function getCheckedRadioValue(radios) {
  return radios.find((radio) => radio.checked)?.value ?? radios[0]?.value;
}

export function getUnitSystemFromShell(shell) {
  if (!shell || typeof shell !== 'object' || !Array.isArray(shell.unitSystemRadios)) {
    return 'metric';
  }
  return normalizeUnitSystem(getCheckedRadioValue(shell.unitSystemRadios));
}

/**
 * Metric/imperial display. Only presentation changes: the speed inputs are
 * re-expressed in the newly chosen unit (same underlying speed, so the
 * isochrone is unaffected) and the scale bar re-reads the system from
 * data-units on the root element.
 */
export function bindUnitSystemControl(shell, options = {}) {
  if (!shell || typeof shell !== 'object' || !Array.isArray(shell.unitSystemRadios)
    || shell.unitSystemRadios.length === 0) {
    throw new Error('shell.unitSystemRadios is required');
  }

  const rootElement = options.rootElement ?? globalThis.document?.documentElement ?? null;
  if (!rootElement || typeof rootElement !== 'object' || typeof rootElement.dataset !== 'object') {
    throw new Error('rootElement with dataset is required');
  }
  const storage = options.storage ?? globalThis.localStorage ?? null;
  const storageKey = options.storageKey ?? UNIT_SYSTEM_STORAGE_KEY;
  const onUnitSystemChange = options.onUnitSystemChange ?? null;

  // Starts at the canonical system, because the speed inputs are seeded from
  // km/h constants and the ?walkKph=/?bikeKph= params. The first apply below
  // therefore converts them into whatever the user actually reads.
  let appliedUnitSystem = 'metric';

  const applyUnitSystem = (value, { persist = true, notify = false } = {}) => {
    const nextUnitSystem = normalizeUnitSystem(
      value,
      options.defaultUnitSystem ?? resolveDefaultUnitSystem(),
    );
    const previousUnitSystem = appliedUnitSystem;
    appliedUnitSystem = nextUnitSystem;

    for (const radio of shell.unitSystemRadios) {
      radio.checked = radio.value === nextUnitSystem;
    }
    rootElement.dataset.units = nextUnitSystem;
    if (shell.speedUnitLabelElement) {
      shell.speedUnitLabelElement.textContent = speedUnitLabel(nextUnitSystem);
    }

    // Restate the speeds in the new unit. Converting through km/h keeps the
    // actual speed identical, so switching units never moves the isochrone.
    if (previousUnitSystem !== nextUnitSystem) {
      for (const input of [shell.walkSpeedInput, shell.bikeSpeedInput]) {
        const shown = parsePositiveFloatOrNull(input?.value);
        if (shown === null) {
          continue;
        }
        const speedKph = displaySpeedToKph(shown, previousUnitSystem);
        input.value = String(Math.round(kphToDisplaySpeed(speedKph, nextUnitSystem) * 10) / 10);
      }
    }

    if (persist) {
      safeStorageSet(storage, storageKey, nextUnitSystem);
    }
    if (notify && onUnitSystemChange) {
      onUnitSystemChange(nextUnitSystem);
    }
    return nextUnitSystem;
  };

  applyUnitSystem(safeStorageGet(storage, storageKey), { persist: false });

  const handleChange = (event) => {
    applyUnitSystem(event.target.value, { persist: true, notify: true });
  };
  for (const radio of shell.unitSystemRadios) {
    radio.addEventListener('change', handleChange);
  }

  return {
    dispose() {
      for (const radio of shell.unitSystemRadios) {
        radio.removeEventListener('change', handleChange);
      }
    },
    getUnitSystem() {
      return appliedUnitSystem;
    },
  };
}

// Public transit sits in the same checkbox group as Walk/Bike/Car/Ferry (it
// reads as a peer transport mode to a normal user), but it isn't an
// allowedModeMask bit - it's a boolean CSA-augmentation flag consumed
// separately by getTransitOptionsFromShell. This excludes the transit
// checkbox from the mask computation below (and from the "nothing
// selected" fallback), while it still rides along in shell.modeCheckboxes
// for URL persistence via getSelectedModeValues/setSelectedModeValues.
function getRoutingModeCheckboxesFromShell(shell) {
  const modeCheckboxes = shell.modeCheckboxes ?? [];
  return modeCheckboxes.filter((checkbox) => checkbox !== shell.transitEnabledInput);
}

export function getAllowedModeMaskFromShell(shell) {
  if (!shell || typeof shell !== 'object') {
    throw new Error('shell is required');
  }

  const routingModeCheckboxes = getRoutingModeCheckboxesFromShell(shell);
  let allowedModeMask = 0;

  for (const checkbox of routingModeCheckboxes) {
    if (!checkbox.checked) {
      continue;
    }
    const optionValue = checkbox.value;
    if (optionValue === 'walk') {
      allowedModeMask |= EDGE_MODE_WALK_BIT;
    }
    if (optionValue === 'bike') {
      allowedModeMask |= EDGE_MODE_BIKE_BIT;
    }
    if (optionValue === 'car') {
      allowedModeMask |= EDGE_MODE_CAR_BIT;
    }
    if (optionValue === 'water') {
      allowedModeMask |= EDGE_MODE_WATER_BIT;
    }
  }

  if (allowedModeMask === 0) {
    // "Just public transit" means literally that - route strictly via
    // transit connections between stop-attachment nodes, with zero implicit
    // walking/biking/driving through the road network. TRANSIT_ONLY_
    // ALLOWED_MODE_MASK deliberately matches no bit any real graph edge
    // ever carries, so pass 1 can't spread past the clicked origin node at
    // all; CSA then reaches only stops within walk-attach range of that one
    // node (the fixed node<->stop geometry snap, not a travel mode), and
    // transit connections carry the isochrone from there - producing a
    // real, expectedly island-y result instead of silently falling back to
    // Car. When transit isn't checked either, there's truly nothing to
    // route with, so fall back to Car.
    //
    // Deliberately keyed on `checked` alone, not on the row's visibility:
    // the row starts hidden and is only revealed once the graph reports
    // transit tables, so consulting `hidden` here made every call made
    // before the graph finished loading (e.g. from bindModeSelectControl)
    // conclude "no transit" and fall back to Car. For a region without
    // transit data updateTransitControlAvailability already unchecks the
    // box, so `checked` is the authoritative signal at every point in the
    // lifecycle.
    if (shell.transitEnabledInput?.checked === true) {
      return TRANSIT_ONLY_ALLOWED_MODE_MASK;
    }
    return EDGE_MODE_CAR_BIT;
  }

  return allowedModeMask;
}

/**
 * Enforces the "at least one mode" rule by re-checking Car when the user has
 * just cleared the last one. Kept separate from getAllowedModeMaskFromShell
 * so that reading the mask stays free of side effects: that getter used to
 * perform this repair itself, which meant merely asking for the current mask
 * could rewrite the user's selection.
 */
export function restoreDefaultModeIfNoneSelected(shell) {
  if (!shell || typeof shell !== 'object') {
    throw new Error('shell is required');
  }
  if (shell.transitEnabledInput?.checked === true) {
    return false;
  }

  const routingModeCheckboxes = getRoutingModeCheckboxesFromShell(shell);
  if (routingModeCheckboxes.some((checkbox) => checkbox.checked)) {
    return false;
  }

  setSelectedModeValues(routingModeCheckboxes, ['car']);
  return true;
}

export function getSelectedTransportModeLabels(shell) {
  if (!shell || typeof shell !== 'object' || !Array.isArray(shell.modeCheckboxes)) {
    return [];
  }
  const labels = [];
  for (const checkbox of shell.modeCheckboxes) {
    if (!checkbox?.checked) {
      continue;
    }
    // Skip the transit checkbox (folded into modeCheckboxes alongside
    // Walk/Bike/Car/Ferry) while its row is hidden - no transit data for
    // the loaded region - so a stale checked state from a previous region
    // can't leak into the export title. Mirrors
    // getTransitOptionsFromShell's own transitEnabledRow.hidden check.
    const optionRow = checkbox.closest?.('.mode-icon-option') ?? null;
    if (optionRow?.hidden) {
      continue;
    }
    // The first span in the row is the Material Symbols ligature ("directions_walk");
    // the readable name is the screen-reader one next to it.
    const labelSpan = optionRow?.querySelector?.('.sr-only') ?? null;
    const label =
      typeof labelSpan?.textContent === 'string' && labelSpan.textContent.trim().length > 0
        ? labelSpan.textContent.trim()
        : null;
    if (label) {
      labels.push(label);
    }
  }
  return labels;
}

export function getColourCycleMinutesFromShell(shell) {
  if (!shell || typeof shell !== 'object') {
    throw new Error('shell is required');
  }

  const rawCycleValue = shell.colourCycleMinutesInput?.value;
  const parsedCycleMinutes = Number.parseInt(rawCycleValue ?? '', 10);
  if (!Number.isFinite(parsedCycleMinutes) || parsedCycleMinutes <= 0) {
    if (shell.colourCycleMinutesInput) {
      shell.colourCycleMinutesInput.value = String(DEFAULT_COLOUR_CYCLE_MINUTES);
    }
    return DEFAULT_COLOUR_CYCLE_MINUTES;
  }

  const clampedCycleMinutes = clampInt(parsedCycleMinutes, 5, 24 * 60);
  if (shell.colourCycleMinutesInput) {
    shell.colourCycleMinutesInput.value = String(clampedCycleMinutes);
  }
  return clampedCycleMinutes;
}

/**
 * Converts an ISO YYYY-MM-DD date string to an ISO weekday index
 * (0=Monday..6=Sunday, matching data_pipeline/gtfs_transit.py's
 * _WEEKDAY_COLUMNS convention and the graph binary's tedgeServiceDayMask
 * bit order). Parsed as UTC so the result doesn't shift with the browser's
 * local timezone around midnight.
 */
export function isoWeekdayIndexForDateString(dateString) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateString ?? '');
  if (!match) {
    return Number.NaN;
  }
  const [, year, month, day] = match;
  const utcDate = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (Number.isNaN(utcDate.getTime())) {
    return Number.NaN;
  }
  const sundayZeroIndex = utcDate.getUTCDay();
  return (sundayZeroIndex + 6) % 7;
}

function nowIsoDatetimeLocalString() {
  const now = new Date();
  const year = String(now.getFullYear()).padStart(4, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function clampIsoDateToRange(dateString, minDateString, maxDateString) {
  if (dateString < minDateString) {
    return minDateString;
  }
  if (dateString > maxDateString) {
    return maxDateString;
  }
  return dateString;
}

// Clamps only the date portion of a datetime-local value into
// [minDateString, maxDateString], preserving the time-of-day portion — so
// "now" defaults to the current date+time when today is in range, and to
// the same time-of-day on the nearest valid date otherwise.
function clampIsoDatetimeLocalToDateRange(datetimeLocalString, minDateString, maxDateString) {
  const [datePart, timePart] = (datetimeLocalString ?? '').split('T');
  const clampedDatePart = clampIsoDateToRange(datePart ?? '', minDateString, maxDateString);
  return `${clampedDatePart}T${timePart ?? '00:00'}`;
}

const DEPARTURE_DATETIME_VALUE_PATTERN = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/;

export function getTransitOptionsFromShell(shell) {
  if (!shell || typeof shell !== 'object') {
    throw new Error('shell is required');
  }

  const transitEnabled = shell.transitEnabledInput?.checked === true
    && shell.transitEnabledRow?.hidden !== true;

  const rawDepartureDatetime = shell.departureDatetimeInput?.value ?? '';
  const match = DEPARTURE_DATETIME_VALUE_PATTERN.exec(rawDepartureDatetime);
  let departureSecondsOfDay = Number.NaN;
  let departureWeekdayIndex = Number.NaN;
  if (match) {
    const [, datePart, hoursText, minutesText] = match;
    const hours = Number.parseInt(hoursText, 10);
    const minutes = Number.parseInt(minutesText, 10);
    if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) {
      departureSecondsOfDay = hours * 3600 + minutes * 60;
    }
    departureWeekdayIndex = isoWeekdayIndexForDateString(datePart);
  }

  // A 0 budget is meaningful (ride only what you can board without walking),
  // so this parses non-negative rather than positive.
  const rawWalkBudget = Number.parseFloat(shell.transitWalkBudgetInput?.value ?? '');
  const transitWalkBudgetMinutes =
    Number.isFinite(rawWalkBudget) && rawWalkBudget >= 0
      ? rawWalkBudget
      : DEFAULT_TRANSIT_WALK_BUDGET_MINUTES;

  return {
    transitEnabled,
    departureSecondsOfDay,
    departureWeekdayIndex,
    transitWalkBudgetSeconds: transitWalkBudgetMinutes * 60,
  };
}

export function getSpeedOptionsFromShell(shell) {
  if (!shell || typeof shell !== 'object') {
    throw new Error('shell is required');
  }

  const unitSystem = getUnitSystemFromShell(shell);
  const walkSpeedInputValue = parsePositiveFloatOrNull(shell.walkSpeedInput?.value);
  const bikeSpeedInputValue = parsePositiveFloatOrNull(shell.bikeSpeedInput?.value);
  // The inputs carry whatever unit is on display; routing only ever speaks km/h.
  const walkSpeedKph = walkSpeedInputValue === null
    ? DEFAULT_WALK_SPEED_KPH
    : displaySpeedToKph(walkSpeedInputValue, unitSystem);
  const bikeCruiseSpeedKph = bikeSpeedInputValue === null
    ? BIKE_CRUISE_SPEED_KPH
    : displaySpeedToKph(bikeSpeedInputValue, unitSystem);

  return {
    walkingSpeedMps: walkSpeedKph / 3.6,
    bikeCruiseSpeedKph,
  };
}

function parsePositiveFloatOrNull(rawValue) {
  const parsed = Number.parseFloat(rawValue ?? '');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Toggles the "Public transit" control's visibility, the departure
 * date+time control, and the VBB/CC BY transit attribution line, based on
 * whether the currently-loaded region's graph actually has transit stops
 * (only Berlin, for now) — all absent for every other region rather than a
 * per-region config flag. Resets the checkbox when hiding so a stale
 * checked state from a previous region doesn't linger if the row is shown
 * again later. The SVG export's copyright notice reads both disclaimer
 * elements' live textContent and skips routingDisclaimerTransit while
 * hidden, so toggling `hidden` here is enough to keep exports correct too,
 * no separate wiring needed there.
 *
 * options.transitDateRange (an object with ISO YYYY-MM-DD `min`/`max`
 * strings) constrains the departure-datetime input to the actual calendar
 * window the region's GTFS build covers — every weekday-recurring service
 * across that whole window is included (single-date calendar_dates.txt
 * exceptions like holidays are not modeled; see
 * data_pipeline/gtfs_transit.py's resolve_recurring_service_ids_and_date_range).
 * An existing input value (e.g. restored from the URL at page load) is left
 * alone as long as its date falls within the new range; otherwise the input
 * defaults to "now" clamped into that range. options.nowIsoDatetime
 * overrides "now" for deterministic tests.
 */
export function updateTransitControlAvailability(shell, hasTransitData, options = {}) {
  if (!shell || typeof shell !== 'object') {
    throw new Error('shell is required');
  }

  if (shell.transitEnabledRow) {
    shell.transitEnabledRow.hidden = !hasTransitData;
  }
  if (!hasTransitData && shell.transitEnabledInput) {
    shell.transitEnabledInput.checked = false;
  }
  if (shell.routingDisclaimerTransit) {
    shell.routingDisclaimerTransit.hidden = !hasTransitData;
  }
  if (shell.departureDatetimeRow) {
    shell.departureDatetimeRow.hidden = !hasTransitData;
  }
  if (shell.transitWalkBudgetRow) {
    shell.transitWalkBudgetRow.hidden = !hasTransitData;
  }
  if (shell.departureDatetimeInput) {
    const transitDateRange =
      hasTransitData
      && options.transitDateRange
      && typeof options.transitDateRange.min === 'string'
      && typeof options.transitDateRange.max === 'string'
        ? options.transitDateRange
        : null;
    if (transitDateRange) {
      shell.departureDatetimeInput.min = `${transitDateRange.min}T00:00`;
      shell.departureDatetimeInput.max = `${transitDateRange.max}T23:59`;
      const currentDatePart = (shell.departureDatetimeInput.value ?? '').split('T')[0];
      const currentValueInRange =
        currentDatePart >= transitDateRange.min && currentDatePart <= transitDateRange.max;
      if (!currentValueInRange) {
        const nowIsoDatetime =
          typeof options.nowIsoDatetime === 'string' ? options.nowIsoDatetime : nowIsoDatetimeLocalString();
        shell.departureDatetimeInput.value = clampIsoDatetimeLocalToDateRange(
          nowIsoDatetime,
          transitDateRange.min,
          transitDateRange.max,
        );
      }
    } else {
      shell.departureDatetimeInput.removeAttribute('min');
      shell.departureDatetimeInput.removeAttribute('max');
      shell.departureDatetimeInput.value = '';
    }
  }
}

export function bindModeSelectControl(shell, dependencies = {}) {
  if (!shell || typeof shell !== 'object') {
    throw new Error('shell is required');
  }
  if (
    !shell.modeCheckboxes
    || shell.modeCheckboxes.length === 0
    || !shell.colourCycleMinutesInput
    || !shell.isochroneLegend
  ) {
    throw new Error('mode and colour controls are required');
  }

  const renderIsochroneLegendIfNeeded = dependencies.renderIsochroneLegendIfNeeded;
  if (typeof renderIsochroneLegendIfNeeded !== 'function') {
    throw new Error('dependencies.renderIsochroneLegendIfNeeded must be a function');
  }
  const requestIsochroneRedraw = dependencies.requestIsochroneRedraw;
  const requestIsochroneRepaint = dependencies.requestIsochroneRepaint;
  if (
    requestIsochroneRedraw !== undefined
    && typeof requestIsochroneRedraw !== 'function'
  ) {
    throw new Error('dependencies.requestIsochroneRedraw must be a function when provided');
  }
  if (
    requestIsochroneRepaint !== undefined
    && typeof requestIsochroneRepaint !== 'function'
  ) {
    throw new Error('dependencies.requestIsochroneRepaint must be a function when provided');
  }

  const maybeRequestIsochroneRedraw = () => {
    if (typeof requestIsochroneRedraw !== 'function') {
      return false;
    }
    const maybePromise = requestIsochroneRedraw();
    if (maybePromise && typeof maybePromise.then === 'function') {
      void maybePromise.catch((error) => {
        console.error(error);
      });
      return true;
    }
    return Boolean(maybePromise);
  };

  const maybeRequestIsochroneRepaint = () => {
    if (typeof requestIsochroneRepaint !== 'function') {
      return false;
    }
    const maybePromise = requestIsochroneRepaint();
    if (maybePromise && typeof maybePromise.then === 'function') {
      void maybePromise
        .then((didRepaint) => {
          if (!didRepaint) {
            maybeRequestIsochroneRedraw();
          }
        })
        .catch((error) => {
          console.error(error);
        });
      return true;
    }
    return Boolean(maybePromise);
  };

  // Shared by every mode checkbox (Walk/Bike/Car/Ferry and Public transit
  // alike, since they're presented as one group) - persists the full
  // checked set to the URL and always redraws (not just repaints), since a
  // mode or transit change can alter which nodes are reachable at all.
  const handleSelectChange = () => {
    restoreDefaultModeIfNoneSelected(shell);
    persistModeValuesToLocation(getSelectedModeValues(shell.modeCheckboxes));
    maybeRequestIsochroneRedraw();
  };
  const handleCycleChange = () => {
    const cycleMinutes = getColourCycleMinutesFromShell(shell);
    persistColourCycleMinutesToLocation(cycleMinutes);
    renderIsochroneLegendIfNeeded(shell, cycleMinutes);
    if (!maybeRequestIsochroneRepaint()) {
      maybeRequestIsochroneRedraw();
    }
  };
  const handleDepartureDatetimeChange = () => {
    const departureDatetime = shell.departureDatetimeInput?.value ?? '';
    if (departureDatetime.length > 0) {
      persistDepartureDatetimeToLocation(departureDatetime);
    }
    maybeRequestIsochroneRedraw();
  };
  // Walk/bike speed changes require a full redraw too — they change the
  // per-edge traversal cost, not just the isochrone's colouring. Persists
  // the raw km/h input values directly (not options.walkingSpeedMps * 3.6)
  // so the URL doesn't pick up km/h -> m/s -> km/h floating-point noise.
  const handleTransitWalkBudgetChange = () => {
    const rawMinutes = Number.parseFloat(shell.transitWalkBudgetInput?.value ?? '');
    if (Number.isFinite(rawMinutes) && rawMinutes >= 0) {
      persistTransitWalkBudgetMinutesToLocation(rawMinutes);
    }
    maybeRequestIsochroneRedraw();
  };
  const handleSpeedControlChange = () => {
    // The URL always carries km/h, whatever unit the box happens to show, so
    // a shared link means the same speed to everyone who opens it.
    const unitSystem = getUnitSystemFromShell(shell);
    const walkSpeedShown = parsePositiveFloatOrNull(shell.walkSpeedInput?.value);
    if (walkSpeedShown !== null) {
      persistWalkSpeedKphToLocation(displaySpeedToKph(walkSpeedShown, unitSystem));
    }
    const bikeSpeedShown = parsePositiveFloatOrNull(shell.bikeSpeedInput?.value);
    if (bikeSpeedShown !== null) {
      persistBikeSpeedKphToLocation(displaySpeedToKph(bikeSpeedShown, unitSystem));
    }
    maybeRequestIsochroneRedraw();
  };

  restoreDefaultModeIfNoneSelected(shell);
  getColourCycleMinutesFromShell(shell);
  getSpeedOptionsFromShell(shell);
  renderIsochroneLegendIfNeeded(shell, getColourCycleMinutesFromShell(shell));
  for (const checkbox of shell.modeCheckboxes) {
    checkbox.addEventListener('change', handleSelectChange);
  }
  shell.colourCycleMinutesInput.addEventListener('change', handleCycleChange);
  shell.walkSpeedInput?.addEventListener('change', handleSpeedControlChange);
  shell.bikeSpeedInput?.addEventListener('change', handleSpeedControlChange);
  shell.transitWalkBudgetInput?.addEventListener('change', handleTransitWalkBudgetChange);
  shell.departureDatetimeInput?.addEventListener('change', handleDepartureDatetimeChange);

  return {
    dispose() {
      for (const checkbox of shell.modeCheckboxes) {
        checkbox.removeEventListener('change', handleSelectChange);
      }
      shell.colourCycleMinutesInput.removeEventListener('change', handleCycleChange);
      shell.walkSpeedInput?.removeEventListener('change', handleSpeedControlChange);
      shell.bikeSpeedInput?.removeEventListener('change', handleSpeedControlChange);
      shell.departureDatetimeInput?.removeEventListener('change', handleDepartureDatetimeChange);
    },
  };
}

function sizeCanvasToCssPixels(canvas) {
  if (typeof canvas.getBoundingClientRect !== 'function') {
    return;
  }

  const { width, height } = canvas.getBoundingClientRect();
  if (width < 2 || height < 2) {
    return;
  }

  const nextWidth = Math.round(width);
  const nextHeight = Math.round(height);

  if (canvas.width !== nextWidth) {
    canvas.width = nextWidth;
  }
  if (canvas.height !== nextHeight) {
    canvas.height = nextHeight;
  }
}

function setLoadingProgressBar(progressBar, progressPercent) {
  const clamped = clampInt(Math.round(progressPercent), 0, 100);
  progressBar.style.width = `${clamped}%`;
}

function normalizeThemeValue(themeValue, fallbackTheme = 'light') {
  if (CANONICAL_THEME_VALUES.includes(themeValue)) {
    return themeValue;
  }
  if (CANONICAL_THEME_VALUES.includes(fallbackTheme)) {
    return fallbackTheme;
  }
  return 'light';
}

function safeStorageGet(storage, key) {
  if (!storage || typeof storage.getItem !== 'function') {
    return null;
  }
  try {
    return storage.getItem(key);
  } catch (_error) {
    return null;
  }
}

function safeStorageSet(storage, key, value) {
  if (!storage || typeof storage.setItem !== 'function') {
    return;
  }
  try {
    storage.setItem(key, value);
  } catch (_error) {
    // Ignore storage write failures (for example private browsing restrictions).
  }
}

function clampInt(value, minValue, maxValue) {
  if (value < minValue) {
    return minValue;
  }
  if (value > maxValue) {
    return maxValue;
  }
  return value;
}

function setSelectedModeValues(modeCheckboxes, modeValues) {
  const selectedModeSet = new Set(modeValues);
  for (const checkbox of modeCheckboxes) {
    checkbox.checked = selectedModeSet.has(checkbox.value);
  }
}

function getSelectedModeValues(modeCheckboxes) {
  const selectedModeSet = new Set();
  for (const checkbox of modeCheckboxes) {
    if (checkbox.checked && CANONICAL_MODE_VALUES.includes(checkbox.value)) {
      selectedModeSet.add(checkbox.value);
    }
  }
  return CANONICAL_MODE_VALUES.filter((modeValue) => selectedModeSet.has(modeValue));
}
