// Draws a monochrome scene into a 2D canvas.
//
// The same scene the SVG export serialises, painted rather than written out.
// There is one map, described once, and two ways of putting it somewhere -
// which is what stops the screen and the sheet drifting apart.
//
// It draws into the map canvas rather than a layer over it, so the map has one
// surface with one lifetime and one set of pointer handlers. 2D gives
// repeating pattern fills, an even-odd fill rule, strokes and haloed text,
// which is the whole of what this draws.

const HALO_WIDTH_RATIO = 0.45;
const LABEL_FONT_FAMILY = "'Helvetica Neue', Helvetica, Arial, sans-serif";

/**
 * A repeating tile for one hatch, as a canvas pattern.
 *
 * Cached on the pattern spec per context, since a pattern belongs to the
 * context that made it and rebuilding one per frame is pure waste.
 */
function getOrCreatePattern(context, pattern, { ink, scale, createCanvas }) {
  const cacheKey = `__monoPattern_${pattern.id}_${ink}_${scale}`;
  const cached = context[cacheKey];
  if (cached) {
    return cached;
  }
  const size = Math.max(1, Math.round(pattern.tileSize * scale));
  const tile = createCanvas(size, size);
  const tileContext = tile.getContext('2d');
  if (!tileContext) {
    return null;
  }
  tileContext.strokeStyle = ink;
  tileContext.lineWidth = pattern.strokeWidth * scale;
  tileContext.beginPath();
  for (const line of pattern.lines) {
    tileContext.moveTo(line.x1 * scale, line.y1 * scale);
    tileContext.lineTo(line.x2 * scale, line.y2 * scale);
  }
  tileContext.stroke();
  const created = context.createPattern(tile, 'repeat');
  context[cacheKey] = created;
  return created;
}

function tracePolygon(context, points, transform) {
  const count = points.length / 2;
  if (count < 3) {
    return false;
  }
  for (let index = 0; index < count; index += 1) {
    const [x, y] = transform(points[index * 2], points[index * 2 + 1]);
    if (index === 0) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
  }
  context.closePath();
  return true;
}

/**
 * Paints the scene. Returns the number of bands drawn, so a caller can tell an
 * empty map from a failed one.
 */
export function drawMonochromeScene(context, scene, options = {}) {
  if (!context || typeof context.beginPath !== 'function') {
    throw new Error('context must be a 2D canvas context');
  }
  if (!scene || !Array.isArray(scene.bands)) {
    throw new Error('scene must carry a bands array');
  }
  const createCanvas = options.createCanvas
    ?? ((width, height) => {
      const canvas = globalThis.document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      return canvas;
    });
  const { widthPx, heightPx, transform, ink, paper } = scene;
  const basemap = scene.basemap ?? {};

  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, widthPx, heightPx);
  context.fillStyle = paper;
  context.fillRect(0, 0, widthPx, heightPx);
  context.lineJoin = 'round';

  // Water, then roads, then the band tint over them, then contours, then
  // labels: the hatches are transparent, so the bands read as a screen tint
  // laid over linework the way a printed map does.
  const waterPattern = scene.waterPattern
    ? getOrCreatePattern(context, scene.waterPattern, {
      ink: scene.waterInk ?? ink,
      scale: 1,
      createCanvas,
    })
    : null;
  if (waterPattern && basemap.waterFeatures?.length) {
    context.beginPath();
    let traced = false;
    for (const feature of basemap.waterFeatures) {
      for (const path of feature.paths) {
        traced = tracePolygon(context, Float64Array.from(path.flat()), transform) || traced;
      }
    }
    if (traced) {
      context.fillStyle = waterPattern;
      // even-odd, so an island stays dry: a coastline is the sea with the land
      // taken out of it.
      context.fill('evenodd');
      context.strokeStyle = ink;
      context.lineWidth = scene.contourStrokeWidth;
      context.stroke();
    }
  }

  const roads = basemap.roadSegments;
  if (roads && roads.length >= 4) {
    context.beginPath();
    for (let index = 0; index + 3 < roads.length; index += 4) {
      const [x0, y0] = transform(roads[index], roads[index + 1]);
      const [x1, y1] = transform(roads[index + 2], roads[index + 3]);
      context.moveTo(x0, y0);
      context.lineTo(x1, y1);
    }
    context.strokeStyle = ink;
    context.lineWidth = scene.roadStrokeWidth;
    context.stroke();
  }

  let drawnBands = 0;
  for (const band of scene.bands) {
    if (band.pattern.lines.length === 0) {
      continue;
    }
    const fill = getOrCreatePattern(context, band.pattern, {
      ink,
      scale: scene.patternScale,
      createCanvas,
    });
    if (!fill) {
      continue;
    }
    context.beginPath();
    let traced = false;
    for (const ring of band.rings) {
      traced = tracePolygon(context, ring.points, transform) || traced;
    }
    if (!traced) {
      continue;
    }
    context.fillStyle = fill;
    context.fill('evenodd');
    drawnBands += 1;
  }

  // A solid hairline between bands, and heavier on the outermost, which is not
  // another band edge but the limit of travel - bare paper inside it is
  // otherwise the same white as ground nobody can reach at all.
  context.strokeStyle = ink;
  for (const band of scene.bands) {
    context.beginPath();
    let traced = false;
    for (const ring of band.rings) {
      traced = tracePolygon(context, ring.points, transform) || traced;
    }
    if (!traced) {
      continue;
    }
    context.lineWidth = band.isLimit ? scene.contourStrokeWidth * 2.2 : scene.contourStrokeWidth;
    context.stroke();
  }

  drawSceneLabels(context, scene);
  context.restore();
  return drawnBands;
}

function drawSceneLabels(context, scene) {
  const labels = scene.labels ?? [];
  if (labels.length === 0) {
    return;
  }
  const fontSize = scene.labelFontSize;
  context.font = `${fontSize}px ${LABEL_FONT_FAMILY}`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.lineJoin = 'round';
  for (const label of labels) {
    context.save();
    context.translate(label.x, label.y);
    if (label.angleDegrees) {
      context.rotate((label.angleDegrees * Math.PI) / 180);
    }
    // Drawn twice, a thick paper-coloured stroke under the ink fill. Black text
    // on a black hatch cannot be read however well it is placed, and the halo
    // is the difference between legible and not.
    context.strokeStyle = scene.paper;
    context.lineWidth = fontSize * HALO_WIDTH_RATIO;
    context.strokeText(label.text, 0, 0);
    context.fillStyle = scene.ink;
    context.fillText(label.text, 0, 0);
    context.restore();
  }
}
