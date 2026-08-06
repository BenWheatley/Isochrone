import { validateGraphHeaderForBoundaryAlignment } from './graph-validation.js';
import { normalizeIsochroneTheme } from '../render/colour.js';

export function parseBoundaryBasemapPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('boundary payload must be an object');
  }

  const coordinateSpace = payload.coordinate_space;
  if (!coordinateSpace || typeof coordinateSpace !== 'object') {
    throw new Error('boundary payload is missing coordinate_space');
  }

  const width = asFiniteNumber(coordinateSpace.width, 'coordinate_space.width');
  const height = asFiniteNumber(coordinateSpace.height, 'coordinate_space.height');
  const xOrigin = asFiniteNumber(coordinateSpace.x_origin, 'coordinate_space.x_origin');
  const yOrigin = asFiniteNumber(coordinateSpace.y_origin, 'coordinate_space.y_origin');
  const axis =
    typeof coordinateSpace.axis === 'string' ? coordinateSpace.axis : 'x-right-y-down';

  if (width <= 0 || height <= 0) {
    throw new Error('coordinate_space width/height must be positive');
  }
  if (axis !== 'x-right-y-down') {
    throw new Error(`unsupported boundary coordinate_space.axis: ${axis}`);
  }

  const rawFeatures = payload.features;
  if (!Array.isArray(rawFeatures)) {
    throw new Error('boundary payload is missing features[]');
  }

  const features = parseDrawableFeatures(rawFeatures, 'features');
  const waterFeatures = parseDrawableFeatures(payload.water_features ?? [], 'water_features');
  const forestFeatures = parseDrawableFeatures(payload.forest_features ?? [], 'forest_features');
  const inlandWaterFeatures = parseDrawableFeatures(
    payload.inland_water_features ?? [],
    'inland_water_features',
  );
  const waterwayFeatures = parseDrawableFeatures(
    payload.waterway_features ?? [],
    'waterway_features',
    ['category', 'navigable'],
  );
  const airportFeatures = parseDrawableFeatures(
    payload.airport_features ?? [],
    'airport_features',
  );

  if (features.length === 0) {
    throw new Error('boundary payload has no drawable paths');
  }

  return {
    coordinateSpace: {
      xOrigin,
      yOrigin,
      width,
      height,
      axis,
    },
    features,
    waterFeatures,
    forestFeatures,
    inlandWaterFeatures,
    waterwayFeatures,
    airportFeatures,
  };
}

export function projectBoundaryBasemapToGraphPaths(payloadOrParsedBoundary, graphHeader) {
  validateGraphHeaderForBoundaryAlignment(graphHeader);
  const parsedBoundary = isParsedBoundaryBasemapPayload(payloadOrParsedBoundary)
    ? payloadOrParsedBoundary
    : parseBoundaryBasemapPayload(payloadOrParsedBoundary);

  const maxY = graphHeader.gridHeightPx - 1;
  const coordinateSpace = parsedBoundary.coordinateSpace;
  const project = (featureList, extraFieldNames = []) =>
    projectFeatureList(featureList ?? [], coordinateSpace, graphHeader, maxY, extraFieldNames);

  return {
    coordinateSpace,
    waterFeatures: project(parsedBoundary.waterFeatures),
    forestFeatures: project(parsedBoundary.forestFeatures),
    inlandWaterFeatures: project(parsedBoundary.inlandWaterFeatures),
    waterwayFeatures: project(parsedBoundary.waterwayFeatures, ['category', 'navigable']),
    airportFeatures: project(parsedBoundary.airportFeatures),
    features: project(parsedBoundary.features),
  };
}

function projectFeatureList(featureList, coordinateSpace, graphHeader, maxY, extraFieldNames) {
  return featureList.map((feature) => {
    const projectedFeature = {
      name: feature.name,
      relationId: feature.relationId,
      paths: feature.paths.map((path) =>
        path.map((point) => {
          const easting = coordinateSpace.xOrigin + point[0];
          const northing = coordinateSpace.yOrigin - point[1];
          const xPx = (easting - graphHeader.originEasting) / graphHeader.pixelSizeM;
          const yPx = maxY - (northing - graphHeader.originNorthing) / graphHeader.pixelSizeM;
          return [xPx, yPx];
        }),
      ),
    };
    for (const fieldName of extraFieldNames) {
      if (fieldName in feature) {
        projectedFeature[fieldName] = feature[fieldName];
      }
    }
    return projectedFeature;
  });
}

export function isClosedPath(path) {
  if (!Array.isArray(path) || path.length < 2) {
    return false;
  }
  const [firstX, firstY] = path[0];
  const [lastX, lastY] = path[path.length - 1];
  return firstX === lastX && firstY === lastY;
}

export function getBoundaryStrokeStyle(colourTheme) {
  return normalizeIsochroneTheme(colourTheme, 'dark') === 'light'
    ? 'rgba(58, 94, 126, 0.62)'
    : 'rgba(125, 175, 220, 0.55)';
}

export function getBoundaryWaterFillStyle(colourTheme) {
  return normalizeIsochroneTheme(colourTheme, 'dark') === 'light'
    ? 'rgba(120, 235, 255, 0.72)'
    : 'rgba(16, 55, 106, 0.78)';
}

export function getForestFillStyle(colourTheme) {
  return normalizeIsochroneTheme(colourTheme, 'dark') === 'light'
    ? 'rgba(80, 165, 90, 0.42)'
    : 'rgba(28, 66, 38, 0.55)';
}

export function getInlandWaterFillStyle(colourTheme) {
  return normalizeIsochroneTheme(colourTheme, 'dark') === 'light'
    ? 'rgba(110, 200, 220, 0.65)'
    : 'rgba(18, 68, 88, 0.72)';
}

export function getAirportFillStyle(colourTheme) {
  return normalizeIsochroneTheme(colourTheme, 'dark') === 'light'
    ? 'rgba(160, 140, 110, 0.38)'
    : 'rgba(120, 105, 80, 0.45)';
}

export function getWaterwayStrokeStyle(colourTheme, navigable) {
  const isLight = normalizeIsochroneTheme(colourTheme, 'dark') === 'light';
  if (navigable) {
    return isLight ? 'rgba(28, 108, 168, 0.85)' : 'rgba(96, 182, 230, 0.85)';
  }
  return isLight ? 'rgba(28, 108, 168, 0.5)' : 'rgba(96, 182, 230, 0.5)';
}

function isParsedBoundaryBasemapPayload(value) {
  return (
    value
    && typeof value === 'object'
    && value.coordinateSpace
    && typeof value.coordinateSpace === 'object'
    && Array.isArray(value.features)
  );
}

function parseDrawableFeatures(rawFeatures, contextName, extraFieldNames = []) {
  if (!Array.isArray(rawFeatures)) {
    throw new Error(`boundary payload is missing ${contextName}[]`);
  }

  return rawFeatures
    .map((feature, featureIndex) => {
      if (!feature || typeof feature !== 'object') {
        throw new Error(`${contextName}[${featureIndex}] must be an object`);
      }

      const name =
        typeof feature.name === 'string' ? feature.name : `${contextName}_feature_${featureIndex}`;
      const relationId = Number.isFinite(feature.relation_id) ? feature.relation_id : null;

      if (!Array.isArray(feature.paths)) {
        throw new Error(`${contextName}[${featureIndex}].paths must be an array`);
      }

      const paths = feature.paths
        .map((path, pathIndex) => {
          if (!Array.isArray(path)) {
            throw new Error(`${contextName}[${featureIndex}].paths[${pathIndex}] must be an array`);
          }

          return path
            .map((point, pointIndex) =>
              parseCoordinatePair(
                point,
                `${contextName}[${featureIndex}].paths[${pathIndex}][${pointIndex}]`,
              ),
            )
            .filter((point) => point.length === 2);
        })
        .filter((path) => path.length >= 2);

      const parsedFeature = {
        name,
        relationId,
        paths,
      };
      for (const fieldName of extraFieldNames) {
        if (fieldName in feature) {
          parsedFeature[fieldName] = feature[fieldName];
        }
      }
      return parsedFeature;
    })
    .filter((feature) => feature.paths.length > 0);
}

function parseCoordinatePair(value, context) {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error(`${context} must be a [x, y] coordinate pair`);
  }

  return [asFiniteNumber(value[0], `${context}[0]`), asFiniteNumber(value[1], `${context}[1]`)];
}

function asFiniteNumber(value, context) {
  if (!Number.isFinite(value)) {
    throw new Error(`${context} must be a finite number`);
  }
  return value;
}
