export function minutesToSeconds(minutes) {
  if (minutes < 0) {
    throw new Error('minutes must be non-negative');
  }

  return Math.round(minutes * 60);
}

export function initializeAppShell(doc) {
  const resolvedDocument = doc ?? globalThis.document;
  if (!resolvedDocument) {
    throw new Error('document is not available');
  }

  const mapCanvas = resolvedDocument.getElementById('map');
  const loadingOverlay = resolvedDocument.getElementById('loading');

  if (!mapCanvas || mapCanvas.tagName !== 'CANVAS') {
    throw new Error('index.html is missing <canvas id="map">');
  }
  if (!loadingOverlay || loadingOverlay.tagName !== 'DIV') {
    throw new Error('index.html is missing <div id="loading">');
  }

  loadingOverlay.textContent = 'Loading map and graph data...';

  return { mapCanvas, loadingOverlay };
}

if (typeof window !== 'undefined' && typeof globalThis.document !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    initializeAppShell(globalThis.document);
  });
}
