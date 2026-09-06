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
 * Paints the scene. Returns the number of ways drawn, so a caller can tell an
 * empty map from a failed one.
 */
export function drawMonochromeScene(context, scene, options = {}) {
  if (!context || typeof context.beginPath !== 'function') {
    throw new Error('context must be a 2D canvas context');
  }
  if (!scene || typeof scene !== 'object') {
    throw new Error('scene must be an object');
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

  // The sea's ruling, then the zones, then the linework over both, then the
  // labels over everything.
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
    }
  }

  // The same zone around the same ways the GPU draws, in the same order: the
  // outline wider than the zone so only the outside of the union survives,
  // then band by band from the farthest in, so the nearer time covers any
  // ground two bands both reach.
  // The same zone around the same ways the GPU draws, in the same order: the
  // outline wider than the zone so only the outside of the union survives,
  // then band by band from the farthest in, so the nearer time covers any
  // ground two bands both reach.
  let drawnSegments = 0;
  if (scene.ribbons && scene.ribbons.ordered.data.length >= 6) {
    const { ordered, patterns, widthPx: ribbonPx, outlinePx } = scene.ribbons;
    drawnSegments = Math.floor(ordered.data.length / 6);

    const strokeRange = (first, count, width, style) => {
      context.beginPath();
      for (let piece = 0; piece < count; piece += 1) {
        const offset = (first + piece) * 6;
        const [x0, y0] = transform(ordered.data[offset], ordered.data[offset + 1]);
        const [x1, y1] = transform(ordered.data[offset + 3], ordered.data[offset + 4]);
        context.moveTo(x0, y0);
        context.lineTo(x1, y1);
      }
      context.lineCap = 'round';
      context.lineJoin = 'round';
      context.lineWidth = width;
      context.strokeStyle = style;
      context.stroke();
    };

    // Clipped to the land. A zone is a claim about ground someone can stand
    // on, and the sea is not that - but a river or a lake is different, having
    // ways along both banks whose zones legitimately meet over the water, so
    // only the coastline clips anything.
    const coastline = basemap.coastlineFeatures ?? [];
    context.save();
    if (coastline.length > 0) {
      context.beginPath();
      context.rect(0, 0, widthPx, heightPx);
      for (const feature of coastline) {
        for (const path of feature.paths) {
          tracePolygon(context, Float64Array.from(path.flat()), transform);
        }
      }
      context.clip('evenodd');
    }

    // The limit of travel first, heavier, outside them all.
    strokeRange(0, drawnSegments, ribbonPx + scene.contourStrokeWidth * 4.4, ink);
    for (const range of ordered.ranges) {
      if (range.count === 0) {
        continue;
      }
      // Outlined before it is filled: a nearer band covers the outline of the
      // farther one everywhere but along their shared edge, so what survives
      // is a line exactly on each band boundary.
      strokeRange(range.first, range.count, ribbonPx + outlinePx * 2, ink);
      strokeRange(range.first, range.count, ribbonPx, paper);
      const pattern = patterns[((range.band % patterns.length) + patterns.length) % patterns.length];
      if (pattern.lines.length === 0) {
        continue;
      }
      const fill = getOrCreatePattern(context, pattern, {
        ink,
        scale: scene.patternScale,
        createCanvas,
      });
      if (fill) {
        strokeRange(range.first, range.count, ribbonPx, fill);
      }
    }
    context.restore();
  }


  // The linework goes over the zones, not under them. A zone is opaque paper
  // where its hatch is not inked, so anything drawn first is covered - and a
  // reader needs the coast and the streets to place the isochrone against.
  if (waterPattern && basemap.waterFeatures?.length) {
    context.beginPath();
    let tracedOutline = false;
    for (const feature of basemap.waterFeatures) {
      for (const path of feature.paths) {
        tracedOutline = tracePolygon(context, Float64Array.from(path.flat()), transform)
          || tracedOutline;
      }
    }
    if (tracedOutline) {
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
    context.strokeStyle = scene.roadInk ?? ink;
    context.lineWidth = scene.roadStrokeWidth;
    context.stroke();
  }

  drawSceneLabels(context, scene);
  context.restore();
  return drawnSegments;
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
