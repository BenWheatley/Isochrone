import { LOADING_FADE_MS } from '../config/constants.js';
import { clampInt } from '../core/math.js';
import { formatMebibytes } from '../core/graph-binary.js';
import { formatCommonMessage, getCommonMessage } from './localization.js';
import { hasWebAssemblySupport } from '../wasm/routing-kernel.js';

// Everything that writes user-facing text or progress chrome into the shell:
// the routing status line, the renderer badge, and the loading overlay. All
// of it goes through the locale bundle so the strings stay translatable.

export const WASM_REQUIRED_MESSAGE =
  'Your browser does not support WASM, this app requires WASM for performance reasons';

export function getShellLocaleMessages(shell) {
  return shell?.localeMessages && typeof shell.localeMessages === 'object' ? shell.localeMessages : null;
}

export function getLocalizedShellText(shell, key, fallbackValue, values = {}) {
  return formatCommonMessage(getShellLocaleMessages(shell), key, values, fallbackValue);
}

export function getWasmRequiredMessage(shell) {
  return getCommonMessage(
    getShellLocaleMessages(shell),
    'error.wasm.required',
    WASM_REQUIRED_MESSAGE,
  );
}

export function formatInitialGraphLoadingText(shell) {
  return getLocalizedShellText(shell, 'loading.graph.initial', 'Loading graph: 0.00 MB');
}

export function getRoutingFailedStatusText(shell) {
  return getLocalizedShellText(shell, 'error.routing.failed', 'Routing failed.');
}

export function formatRenderBackendBadgeText(rendererMode, options = {}) {
  const messages = options.messages ?? null;
  if (rendererMode === 'webgl') {
    return formatCommonMessage(messages, 'status.renderer.webgl', {}, 'Renderer: WebGL');
  }
  return formatCommonMessage(messages, 'status.renderer.cpu', {}, 'Renderer: CPU');
}

export function updateRenderBackendBadge(shell, renderer) {
  if (!shell || typeof shell !== 'object' || !shell.renderBackendBadge) {
    return;
  }

  const rendererMode = renderer?.mode === 'webgl' ? 'webgl' : 'cpu';
  const nextText = formatRenderBackendBadgeText(rendererMode, {
    messages: getShellLocaleMessages(shell),
  });
  if (shell.renderBackendBadge.textContent !== nextText) {
    shell.renderBackendBadge.textContent = nextText;
  }
  shell.renderBackendBadge.dataset.backend = rendererMode;
}

export function formatRoutingStatusCalculating(settledCount, options = {}) {
  const safeCount = Math.max(0, Math.floor(settledCount));
  return formatCommonMessage(
    options.messages ?? null,
    'routing.calculating',
    { settledCount: safeCount },
    `Calculating... (${safeCount} nodes settled)`,
  );
}

export function formatRoutingDurationSuffix(durationMs, options = {}) {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return '';
  }
  const roundedDurationMs = Math.max(0, Math.round(durationMs));
  return formatCommonMessage(
    options.messages ?? null,
    'routing.durationSuffix',
    { durationMs: roundedDurationMs },
    ` (${roundedDurationMs} ms)`,
  );
}

export function formatRoutingStatusDone(durationMs = null, options = {}) {
  return formatCommonMessage(
    options.messages ?? null,
    'routing.done',
    { durationSuffix: formatRoutingDurationSuffix(durationMs, options) },
    `Done - full travel-time field ready${formatRoutingDurationSuffix(durationMs, options)}`,
  );
}

export function formatRoutingStatusPreview(durationMs = null, options = {}) {
  return formatCommonMessage(
    options.messages ?? null,
    'routing.preview',
    { durationSuffix: formatRoutingDurationSuffix(durationMs, options) },
    `Done - preview updated${formatRoutingDurationSuffix(durationMs, options)}`,
  );
}

export function formatRoutingStatusNoReachable(durationMs = null, options = {}) {
  return formatCommonMessage(
    options.messages ?? null,
    'routing.none',
    { durationSuffix: formatRoutingDurationSuffix(durationMs, options) },
    `Done - no reachable network for selected mode at this start point${formatRoutingDurationSuffix(durationMs, options)}`,
  );
}

export function setRoutingStatus(shell, text) {
  shell.routingStatus.textContent = text;
}

export function ensureWasmSupportOrShowError(shell, options = {}) {
  if (!shell || typeof shell !== 'object' || !shell.isochroneCanvas) {
    throw new Error('shell.isochroneCanvas is required');
  }
  const runtimeGlobal = options.runtimeGlobal ?? globalThis;
  if (hasWebAssemblySupport(runtimeGlobal)) {
    return true;
  }

  shell.isochroneCanvas.style.pointerEvents = 'none';
  shell.isochroneCanvas.dataset.graphLoaded = 'false';
  const wasmRequiredMessage = getWasmRequiredMessage(shell);
  showLoadingOverlay(shell, wasmRequiredMessage, 0);
  setRoutingStatus(shell, wasmRequiredMessage);
  return false;
}

export function updateGraphLoadingText(shell, receivedBytes, totalBytes) {
  const receivedText = formatMebibytes(receivedBytes);
  if (totalBytes === null || totalBytes <= 0) {
    shell.loadingText.textContent = getLocalizedShellText(
      shell,
      'loading.graph.received',
      `Loading graph: ${receivedText}`,
      { received: receivedText },
    );
    return;
  }

  const totalText = formatMebibytes(totalBytes);
  const percent = Math.min(100, Math.round((receivedBytes / totalBytes) * 100));
  shell.loadingText.textContent = getLocalizedShellText(
    shell,
    'loading.graph.progress',
    `Loading graph: ${receivedText} / ${totalText} (${percent}%)`,
    { received: receivedText, total: totalText, percent },
  );
  setLoadingProgressBar(shell.loadingProgressBar, percent);
}

export function showLoadingOverlay(shell, text, progressPercent) {
  if (shell.loadingFadeTimeoutId !== null) {
    clearTimeout(shell.loadingFadeTimeoutId);
    shell.loadingFadeTimeoutId = null;
  }

  shell.loadingOverlay.hidden = false;
  shell.loadingOverlay.classList.remove('is-fading');
  shell.loadingText.textContent = text;
  setLoadingProgressBar(shell.loadingProgressBar, progressPercent);
}

export function fadeOutLoadingOverlay(shell) {
  if (shell.loadingFadeTimeoutId !== null) {
    clearTimeout(shell.loadingFadeTimeoutId);
  }

  shell.loadingOverlay.classList.add('is-fading');
  shell.loadingFadeTimeoutId = setTimeout(() => {
    shell.loadingOverlay.hidden = true;
    shell.loadingOverlay.classList.remove('is-fading');
    shell.loadingFadeTimeoutId = null;
  }, LOADING_FADE_MS);
}

export function setLoadingProgressBar(progressBar, progressPercent) {
  const clamped = clampInt(Math.round(progressPercent), 0, 100);
  progressBar.style.width = `${clamped}%`;
}
