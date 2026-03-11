import {
  DEFAULT_COLOUR_CYCLE_MINUTES,
  EDGE_MODE_BIKE_BIT,
  EDGE_MODE_CAR_BIT,
  EDGE_MODE_WALK_BIT,
} from '../config/constants.js';
import {
  parseColourCycleMinutesFromLocationSearch,
  parseModeValuesFromLocationSearch,
  persistColourCycleMinutesToLocation,
  persistModeValuesToLocation,
} from '../core/coords.js';

const CANONICAL_MODE_VALUES = ['walk', 'bike', 'car'];

export function initializeAppShell(doc) {
  const resolvedDocument = doc ?? globalThis.document;
  if (!resolvedDocument) {
    throw new Error('document is not available');
  }

  const mapRegion = resolvedDocument.getElementById('map-region');
  const isochroneCanvas =
    resolvedDocument.getElementById('isochrone') ?? resolvedDocument.getElementById('map');
  const boundaryCanvas = resolvedDocument.getElementById('boundaries');
  const canvasStack = resolvedDocument.getElementById('canvas-stack');
  const loadingOverlay = resolvedDocument.getElementById('loading');
  const loadingText = resolvedDocument.getElementById('loading-text');
  const loadingProgressBar = resolvedDocument.getElementById('loading-progress-bar');
  const routingStatus = resolvedDocument.getElementById('routing-status');
  const renderBackendBadge = resolvedDocument.getElementById('render-backend-badge');
  const modeSelect = resolvedDocument.getElementById('mode-select');
  const colourCycleMinutesInput = resolvedDocument.getElementById('colour-cycle-minutes');
  const exportSvgButton = resolvedDocument.getElementById('export-svg-button');
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
  if (!modeSelect || modeSelect.tagName !== 'SELECT') {
    throw new Error('index.html is missing <select id="mode-select">');
  }
  if (!colourCycleMinutesInput || colourCycleMinutesInput.tagName !== 'INPUT') {
    throw new Error('index.html is missing <input id="colour-cycle-minutes">');
  }
  if (!exportSvgButton || exportSvgButton.tagName !== 'BUTTON') {
    throw new Error('index.html is missing <button id="export-svg-button">');
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

  sizeCanvasToCssPixels(isochroneCanvas);
  sizeCanvasToCssPixels(boundaryCanvas);

  isochroneCanvas.style.pointerEvents = 'none';
  isochroneCanvas.dataset.graphLoaded = 'false';
  loadingOverlay.hidden = false;
  loadingOverlay.classList.remove('is-fading');
  loadingText.textContent = 'Loading district boundaries...';
  setLoadingProgressBar(loadingProgressBar, 0);
  routingStatus.textContent = 'Ready.';
  renderBackendBadge.textContent = 'Renderer: Detecting...';
  exportSvgButton.disabled = true;
  const locationSearch = globalThis.location?.search ?? '';
  const persistedModeValues = parseModeValuesFromLocationSearch(locationSearch);
  if (persistedModeValues !== null && persistedModeValues.length > 0) {
    setSelectedModeValues(modeSelect, persistedModeValues);
  } else {
    setSelectedModeValues(modeSelect, ['car']);
  }

  const persistedCycleMinutes = parseColourCycleMinutesFromLocationSearch(locationSearch);
  if (persistedCycleMinutes === null) {
    colourCycleMinutesInput.value = String(DEFAULT_COLOUR_CYCLE_MINUTES);
  } else {
    colourCycleMinutesInput.value = String(persistedCycleMinutes);
  }

  return {
    mapRegion,
    isochroneCanvas,
    mapCanvas: isochroneCanvas,
    boundaryCanvas,
    canvasStack,
    loadingOverlay,
    loadingText,
    loadingProgressBar,
    routingStatus,
    renderBackendBadge,
    modeSelect,
    colourCycleMinutesInput,
    exportSvgButton,
    distanceScale,
    distanceScaleLine,
    distanceScaleLabel,
    isochroneLegend,
    loadingFadeTimeoutId: null,
    lastRenderedLegendCycleMinutes: null,
  };
}

export function getAllowedModeMaskFromShell(shell) {
  if (!shell || typeof shell !== 'object') {
    throw new Error('shell is required');
  }

  const selectedOptions = shell.modeSelect?.selectedOptions;
  let allowedModeMask = 0;

  for (const option of selectedOptions ?? []) {
    const optionValue = option.value;
    if (optionValue === 'walk') {
      allowedModeMask |= EDGE_MODE_WALK_BIT;
    }
    if (optionValue === 'bike') {
      allowedModeMask |= EDGE_MODE_BIKE_BIT;
    }
    if (optionValue === 'car') {
      allowedModeMask |= EDGE_MODE_CAR_BIT;
    }
  }

  if (allowedModeMask === 0) {
    if (shell.modeSelect) {
      setSelectedModeValues(shell.modeSelect, ['car']);
    }
    return EDGE_MODE_CAR_BIT;
  }

  return allowedModeMask;
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

export function bindModeSelectControl(shell, dependencies = {}) {
  if (!shell || typeof shell !== 'object') {
    throw new Error('shell is required');
  }
  if (!shell.modeSelect || !shell.colourCycleMinutesInput || !shell.isochroneLegend) {
    throw new Error('mode and colour controls are required');
  }

  const renderIsochroneLegendIfNeeded = dependencies.renderIsochroneLegendIfNeeded;
  if (typeof renderIsochroneLegendIfNeeded !== 'function') {
    throw new Error('dependencies.renderIsochroneLegendIfNeeded must be a function');
  }
  const requestIsochroneRedraw = dependencies.requestIsochroneRedraw;
  if (
    requestIsochroneRedraw !== undefined
    && typeof requestIsochroneRedraw !== 'function'
  ) {
    throw new Error('dependencies.requestIsochroneRedraw must be a function when provided');
  }

  const maybeRequestIsochroneRedraw = () => {
    if (typeof requestIsochroneRedraw !== 'function') {
      return;
    }
    const maybePromise = requestIsochroneRedraw();
    if (maybePromise && typeof maybePromise.then === 'function') {
      void maybePromise.catch((error) => {
        console.error(error);
      });
    }
  };

  const handleSelectChange = () => {
    getAllowedModeMaskFromShell(shell);
    persistModeValuesToLocation(getSelectedModeValues(shell.modeSelect));
    maybeRequestIsochroneRedraw();
  };
  const handleCycleChange = () => {
    const cycleMinutes = getColourCycleMinutesFromShell(shell);
    persistColourCycleMinutesToLocation(cycleMinutes);
    renderIsochroneLegendIfNeeded(shell, cycleMinutes);
    maybeRequestIsochroneRedraw();
  };

  getAllowedModeMaskFromShell(shell);
  getColourCycleMinutesFromShell(shell);
  renderIsochroneLegendIfNeeded(shell, getColourCycleMinutesFromShell(shell));
  shell.modeSelect.addEventListener('change', handleSelectChange);
  shell.colourCycleMinutesInput.addEventListener('change', handleCycleChange);

  return {
    dispose() {
      shell.modeSelect.removeEventListener('change', handleSelectChange);
      shell.colourCycleMinutesInput.removeEventListener('change', handleCycleChange);
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

function clampInt(value, minValue, maxValue) {
  if (value < minValue) {
    return minValue;
  }
  if (value > maxValue) {
    return maxValue;
  }
  return value;
}

function setSelectedModeValues(modeSelect, modeValues) {
  const selectedModeSet = new Set(modeValues);
  for (const option of modeSelect.options) {
    option.selected = selectedModeSet.has(option.value);
  }
}

function getSelectedModeValues(modeSelect) {
  const selectedModeSet = new Set();
  for (const option of modeSelect.options) {
    if (option.selected && CANONICAL_MODE_VALUES.includes(option.value)) {
      selectedModeSet.add(option.value);
    }
  }
  return CANONICAL_MODE_VALUES.filter((modeValue) => selectedModeSet.has(modeValue));
}
