function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function assertDataUrl(value, name) {
  if (typeof value !== 'string' || !value.startsWith('data:image/png')) {
    throw new Error(`${name} must be a PNG data URL`);
  }
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

export function buildRenderedIsochroneSvgDocument(options = {}) {
  const widthPx = options.widthPx;
  const heightPx = options.heightPx;
  assertPositiveInteger(widthPx, 'widthPx');
  assertPositiveInteger(heightPx, 'heightPx');

  const boundaryLayerDataUrl = options.boundaryLayerDataUrl;
  const isochroneLayerDataUrl = options.isochroneLayerDataUrl;
  assertDataUrl(boundaryLayerDataUrl, 'boundaryLayerDataUrl');
  assertDataUrl(isochroneLayerDataUrl, 'isochroneLayerDataUrl');

  const title = typeof options.title === 'string' ? options.title : 'Isochrone export';
  const escapedTitle = escapeXml(title);
  const escapedBoundaryDataUrl = escapeXml(boundaryLayerDataUrl);
  const escapedIsochroneDataUrl = escapeXml(isochroneLayerDataUrl);

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${heightPx}" viewBox="0 0 ${widthPx} ${heightPx}" role="img" aria-label="${escapedTitle}">`,
    `  <title>${escapedTitle}</title>`,
    `  <image x="0" y="0" width="${widthPx}" height="${heightPx}" href="${escapedBoundaryDataUrl}" />`,
    `  <image x="0" y="0" width="${widthPx}" height="${heightPx}" href="${escapedIsochroneDataUrl}" />`,
    '</svg>',
  ].join('\n');
}

export function buildSvgExportFilename(now = new Date()) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error('now must be a valid Date');
  }

  const year = now.getFullYear();
  const month = pad2(now.getMonth() + 1);
  const day = pad2(now.getDate());
  const hours = pad2(now.getHours());
  const minutes = pad2(now.getMinutes());
  const seconds = pad2(now.getSeconds());
  return `isochrone-${year}${month}${day}-${hours}${minutes}${seconds}.svg`;
}

export function exportCurrentRenderedIsochroneSvg(shell, options = {}) {
  if (!shell || typeof shell !== 'object') {
    throw new Error('shell is required');
  }
  if (!shell.boundaryCanvas || typeof shell.boundaryCanvas.toDataURL !== 'function') {
    throw new Error('shell.boundaryCanvas with toDataURL is required');
  }
  if (!shell.isochroneCanvas || typeof shell.isochroneCanvas.toDataURL !== 'function') {
    throw new Error('shell.isochroneCanvas with toDataURL is required');
  }

  const widthPx = shell.isochroneCanvas.width;
  const heightPx = shell.isochroneCanvas.height;
  assertPositiveInteger(widthPx, 'shell.isochroneCanvas.width');
  assertPositiveInteger(heightPx, 'shell.isochroneCanvas.height');

  const boundaryLayerDataUrl = shell.boundaryCanvas.toDataURL('image/png');
  const isochroneLayerDataUrl = shell.isochroneCanvas.toDataURL('image/png');
  const svgDocument = buildRenderedIsochroneSvgDocument({
    widthPx,
    heightPx,
    boundaryLayerDataUrl,
    isochroneLayerDataUrl,
    title: options.title ?? 'Isochrone export',
  });
  const filename = options.filename ?? buildSvgExportFilename(options.now ?? new Date());

  const documentObject = options.documentObject ?? globalThis.document;
  const urlObject = options.urlObject ?? globalThis.URL;
  if (!documentObject || typeof documentObject.createElement !== 'function' || !documentObject.body) {
    throw new Error('A DOM document with body is required for SVG download');
  }
  if (!urlObject || typeof urlObject.createObjectURL !== 'function' || typeof urlObject.revokeObjectURL !== 'function') {
    throw new Error('URL.createObjectURL/revokeObjectURL are required for SVG download');
  }

  const blob = new Blob([svgDocument], { type: 'image/svg+xml;charset=utf-8' });
  const objectUrl = urlObject.createObjectURL(blob);
  const anchor = documentObject.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  documentObject.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => {
    urlObject.revokeObjectURL(objectUrl);
  }, 0);

  return { filename, svgDocument };
}

export function bindSvgExportControl(shell, dependencies = {}) {
  if (!shell || typeof shell !== 'object' || !shell.exportSvgButton) {
    throw new Error('shell.exportSvgButton is required');
  }

  const exportSvg = dependencies.exportCurrentRenderedIsochroneSvg;
  if (typeof exportSvg !== 'function') {
    throw new Error('dependencies.exportCurrentRenderedIsochroneSvg must be a function');
  }

  const handleClick = () => {
    exportSvg(shell);
  };

  shell.exportSvgButton.addEventListener('click', handleClick);
  return {
    dispose() {
      shell.exportSvgButton.removeEventListener('click', handleClick);
    },
  };
}
