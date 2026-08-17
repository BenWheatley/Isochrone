import { DEFAULT_COLOUR_CYCLE_MINUTES } from '../config/constants.js';
import {
  buildRenderedIsochroneSvgDocument,
  resolveSvgBackgroundColour,
  resolveSvgOverlayColours,
  resolveSvgTheme,
} from './svg.js';

// Printing goes through exactly the same vector document the SVG export
// produces, rather than letting the browser rasterise the WebGL canvas and
// print the surrounding page chrome. The document is handed to a hidden
// same-origin iframe, which is what actually gets printed.

const PRINT_IFRAME_STYLE = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';

export function buildIsochronePrintDocument(svgDocument, options = {}) {
  if (typeof svgDocument !== 'string' || svgDocument.length === 0) {
    throw new Error('svgDocument must be a non-empty string');
  }
  const title = typeof options.title === 'string' ? options.title : 'Isochrone';
  // The XML declaration is valid in a standalone .svg file but not inside an
  // HTML document, so it is dropped on the way in.
  const inlineSvg = svgDocument.replace(/^<\?xml[^>]*\?>\s*/, '');
  const escapedTitle = title
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return [
    '<!doctype html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${escapedTitle}</title>`,
    '<style>',
    // No page margin: the poster carries its own margin, title band, legend,
    // scale bar and credits, so the sheet should be filled edge to edge.
    '@page { margin: 0; }',
    'html, body { margin: 0; padding: 0; }',
    // Fill the sheet and let the SVG's own preserveAspectRatio (xMidYMid meet)
    // letterbox it, so the poster comes out centred and uncropped whichever
    // way round the user prints.
    'body { width: 100vw; height: 100vh; overflow: hidden; }',
    'svg { display: block; width: 100%; height: 100%; }',
    '</style>',
    '</head>',
    '<body>',
    inlineSvg,
    '</body>',
    '</html>',
  ].join('\n');
}

/**
 * Renders the current isochrone to a vector document and opens the browser's
 * print dialog on it. Returns the document that was printed so callers (and
 * tests) can assert on it.
 */
export function printCurrentRenderedIsochrone(shell, options = {}) {
  if (!shell || typeof shell !== 'object') {
    throw new Error('shell is required');
  }
  if (!shell.isochroneCanvas || !Number.isInteger(shell.isochroneCanvas.width)) {
    throw new Error('shell.isochroneCanvas with width/height is required');
  }

  const widthPx = Number.isInteger(options.graphHeader?.gridWidthPx)
    ? options.graphHeader.gridWidthPx
    : shell.isochroneCanvas.width;
  const heightPx = Number.isInteger(options.graphHeader?.gridHeightPx)
    ? options.graphHeader.gridHeightPx
    : shell.isochroneCanvas.height;

  const theme = resolveSvgTheme(shell, options);
  const svgDocument = buildRenderedIsochroneSvgDocument({
    widthPx,
    heightPx,
    backgroundColour: resolveSvgBackgroundColour(shell, options),
    graphHeader: options.graphHeader ?? null,
    boundaryPayload: options.boundaryPayload ?? null,
    edgeVertexData: options.edgeVertexData ?? new Float32Array(0),
    cycleMinutes: options.cycleMinutes ?? DEFAULT_COLOUR_CYCLE_MINUTES,
    theme,
    overlayColours: resolveSvgOverlayColours(shell, { ...options, theme }),
    title: options.title ?? 'Isochrone',
    subtitle: options.subtitle,
    messages: options.messages ?? null,
    scaleBarLabel: options.scaleBarLabel,
    scaleBarWidthPx: options.scaleBarWidthPx,
    scaleBarSegmentWidthPx: options.scaleBarSegmentWidthPx,
    copyrightNotice: options.copyrightNotice,
  });
  // The browser offers the document title as the default "Save as PDF"
  // filename, so it carries the modes too, not just the place.
  const documentTitle = typeof options.subtitle === 'string' && options.subtitle.length > 0
    ? `${options.title ?? 'Isochrone'} - ${options.subtitle}`
    : options.title;
  const printDocument = buildIsochronePrintDocument(svgDocument, { title: documentTitle });

  const documentObject = options.documentObject ?? globalThis.document;
  if (
    !documentObject
    || typeof documentObject.createElement !== 'function'
    || !documentObject.body
  ) {
    throw new Error('A DOM document with body is required for printing');
  }
  const scheduleCleanup = options.scheduleCleanup ?? ((callback) => setTimeout(callback, 0));
  if (typeof scheduleCleanup !== 'function') {
    throw new Error('options.scheduleCleanup must be a function when provided');
  }

  const iframe = documentObject.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.setAttribute('style', PRINT_IFRAME_STYLE);
  documentObject.body.appendChild(iframe);

  const frameDocument = iframe.contentDocument ?? iframe.contentWindow?.document ?? null;
  if (!frameDocument || typeof frameDocument.write !== 'function') {
    iframe.remove();
    throw new Error('print frame document is unavailable');
  }
  frameDocument.open();
  frameDocument.write(printDocument);
  frameDocument.close();

  const frameWindow = iframe.contentWindow;
  if (frameWindow && typeof frameWindow.print === 'function') {
    frameWindow.focus?.();
    frameWindow.print();
  }
  // Removing the frame synchronously would tear the document out from under a
  // print dialog that is still reading it.
  scheduleCleanup(() => {
    iframe.remove();
  });

  return { printDocument, svgDocument };
}

export function bindPrintControl(shell, dependencies = {}) {
  if (!shell || typeof shell !== 'object' || !shell.printButton) {
    throw new Error('shell.printButton is required');
  }

  const print = dependencies.printCurrentRenderedIsochrone;
  if (typeof print !== 'function') {
    throw new Error('dependencies.printCurrentRenderedIsochrone must be a function');
  }
  const onPrintSuccess = dependencies.onPrintSuccess;
  if (onPrintSuccess !== undefined && typeof onPrintSuccess !== 'function') {
    throw new Error('dependencies.onPrintSuccess must be a function when provided');
  }
  const onPrintError = dependencies.onPrintError;
  if (onPrintError !== undefined && typeof onPrintError !== 'function') {
    throw new Error('dependencies.onPrintError must be a function when provided');
  }

  const handleClick = () => {
    let printResult;
    try {
      printResult = print(shell);
    } catch (error) {
      if (typeof onPrintError === 'function') {
        onPrintError(error);
      }
      return;
    }

    Promise.resolve(printResult)
      .then((resolvedResult) => {
        if (typeof onPrintSuccess === 'function') {
          onPrintSuccess(resolvedResult);
        }
      })
      .catch((error) => {
        if (typeof onPrintError === 'function') {
          onPrintError(error);
        }
      });
  };

  shell.printButton.addEventListener('click', handleClick);
  return {
    dispose() {
      shell.printButton.removeEventListener('click', handleClick);
    },
  };
}
