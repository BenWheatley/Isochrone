export const DEFAULT_BOUNDARY_FILE_NAME = 'berlin-district-boundaries-canvas.json';
export const DEFAULT_GRAPH_FILE_NAME = 'graph-walk.bin.gz';
export const DEFAULT_BOUNDARY_BASEMAP_URL =
  `../data_pipeline/output/${DEFAULT_BOUNDARY_FILE_NAME}`;
export const DEFAULT_GRAPH_BINARY_URL = `../data_pipeline/output/${DEFAULT_GRAPH_FILE_NAME}`;
export const DEFAULT_LOCATION_NAME = 'Berlin';
export const DEFAULT_LOCATION_ID = 'berlin';
export const DEFAULT_LOCATION_REGISTRY_URL = '../data/locations.json';
export const GRAPH_MAGIC = 0x49534f43;

export const HEADER_SIZE = 64;
export const NODE_RECORD_SIZE = 16;
export const EDGE_RECORD_SIZE = 12;
export const BYTES_PER_MEBIBYTE = 1024 * 1024;
export const SUPPORTED_GRAPH_VERSIONS = new Set([2]);
export const EDGE_MODE_WALK_BIT = 1;
export const EDGE_MODE_BIKE_BIT = 1 << 1;
export const EDGE_MODE_CAR_BIT = 1 << 2;
export const WALKING_SPEED_M_S = 1.39;
export const BIKE_CRUISE_SPEED_KPH = 20;
export const CAR_FALLBACK_SPEED_KPH = 30;
export const ROAD_CLASS_MOTORWAY = 15;
export const DEFAULT_COLOUR_CYCLE_MINUTES = 75;
export const LOADING_FADE_MS = 180;
export const LAST_CLICKED_NODE_QUERY_PARAM = 'node';
export const SELECTED_REGION_QUERY_PARAM = 'region';
export const LANGUAGE_QUERY_PARAM = 'lang';
export const MODE_SELECTION_QUERY_PARAM = 'modes';
export const COLOUR_CYCLE_QUERY_PARAM = 'cycle';
export const EDGE_INTERPOLATION_SLACK_SECONDS = 0.75;
export const INTERACTIVE_EDGE_INTERPOLATION_STEP_STRIDE = 3;
export const FINAL_EDGE_INTERPOLATION_STEP_STRIDE = 1;
export const EDGE_TRAVERSAL_COST_CACHE_PROPERTY = '__edgeTraversalCostSecondsByModeMask';
export const CYCLE_COLOUR_MAP_GLSL = `vec3 mapCycleColourDark(float cycleRatio) {
  if (cycleRatio <= 1.0 / 5.0) {
    return vec3(0.0, 255.0, 255.0);
  }
  if (cycleRatio <= 2.0 / 5.0) {
    return vec3(64.0, 255.0, 64.0);
  }
  if (cycleRatio <= 3.0 / 5.0) {
    return vec3(255.0, 255.0, 64.0);
  }
  if (cycleRatio <= 4.0 / 5.0) {
    return vec3(255.0, 140.0, 0.0);
  }
  return vec3(255.0, 64.0, 160.0);
}

vec3 mapCycleColourLight(float cycleRatio) {
  if (cycleRatio <= 1.0 / 5.0) {
    return vec3(0.0, 110.0, 210.0);
  }
  if (cycleRatio <= 2.0 / 5.0) {
    return vec3(0.0, 150.0, 70.0);
  }
  if (cycleRatio <= 3.0 / 5.0) {
    return vec3(185.0, 140.0, 0.0);
  }
  if (cycleRatio <= 4.0 / 5.0) {
    return vec3(185.0, 85.0, 0.0);
  }
  return vec3(165.0, 0.0, 130.0);
}

vec3 mapCycleColour(float cycleRatio, float themeVariant) {
  if (themeVariant >= 0.5) {
    return mapCycleColourLight(cycleRatio);
  }
  return mapCycleColourDark(cycleRatio);
}`;
