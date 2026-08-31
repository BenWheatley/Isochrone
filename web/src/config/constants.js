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
export const STOP_RECORD_SIZE = 24;
export const TEDGE_RECORD_SIZE = 20;
export const TRANSFER_RECORD_SIZE = 8;
export const BYTES_PER_MEBIBYTE = 1024 * 1024;
// v3 spends two words the v2 stop record reserved and never wrote on a CSR
// range into a new transfer table, and appends that table after the transit
// edges. A v2 payload is therefore still readable: those words are zero, which
// reads as "this stop has no transfers", and the transfer table is empty
// because the file ends where it would start. Regions built before v3 keep
// working, with the pre-v3 behaviour of no changes of vehicle.
export const SUPPORTED_GRAPH_VERSIONS = new Set([2, 3]);
export const EDGE_MODE_WALK_BIT = 1;
export const EDGE_MODE_BIKE_BIT = 1 << 1;
export const EDGE_MODE_CAR_BIT = 1 << 2;
export const EDGE_MODE_WATER_BIT = 1 << 3;
// The modes you can board a ferry in. A ferry edge carries the water bit plus
// whichever of these its vessel accepts, so a walk-on ferry is walk|water and
// a drive-on ferry car|water. Riding one needs Ferry selected *and* a matching
// boarding mode - see computeEdgeTraversalCostSeconds.
export const EDGE_MODE_BOARDING_BITS =
  EDGE_MODE_WALK_BIT | EDGE_MODE_BIKE_BIT | EDGE_MODE_CAR_BIT;
// A query-time sentinel passed as allowedModeMask when the user has
// selected Public transit but no real road/ferry mode. It deliberately
// matches no bit any real graph edge ever carries (edge_mode_mask is only
// ever built from the four bits above, max value 0b1111), so every
// road/ferry edge costs Infinity and pass 1 can't spread past the origin
// node at all - CSA then reaches only stops within walk-attach range of
// that single node, and transit connections carry the isochrone from
// there. This makes "Public transit" alone route strictly via transit,
// with no implicit walking/biking/driving through the road network.
export const TRANSIT_ONLY_ALLOWED_MODE_MASK = 1 << 4;
// GRAPH ENCODING CONSTANT - not a user preference, and not safe to retune.
// data_pipeline/src/isochrone_pipeline/adjacency.py divides each edge's real
// length by this to store walkingCostSeconds, and the runtime multiplies it
// back out to recover the edge's physical length (see
// core/routing.js computeEdgeTraversalCostSeconds and the matching
// edge_cost_seconds in wasm/routing-kernel/src/lib.rs). Bike, car and ferry
// costs are all derived from that reconstructed length, so changing this
// without rebuilding every region's graph binary would silently distort
// every mode's travel times.
export const WALKING_SPEED_M_S = 1.39;
export const BIKE_CRUISE_SPEED_KPH = 18;
// UI default for the walk-speed input. Deliberately independent of
// WALKING_SPEED_M_S above: that one is fixed by the stored graph encoding,
// whereas this is just the speed we assume for a person until they say
// otherwise, and is free to change.
export const DEFAULT_WALK_SPEED_KPH = 4;
// How long a rider may walk on each leg of a transit journey - to the first
// stop, between stops when changing, and away from the last one. Bounds the
// walking that public-transit routing is allowed to add on top of the
// vehicle legs themselves.
//
// 15 minutes is roughly a kilometre, which is the outer edge of the catchment
// journey planners generally assume for reaching a station. It was 5 minutes
// (about 330 m) while the budget was inert for every mode combination except
// "transit and nothing else"; once it actually bounds the access leg, 5
// minutes is short enough to leave a rider with no service at all - measured
// against Berlin, the nearest stop to a Märkisches Viertel origin is a 6
// minute walk, so a 5 minute budget silently returned a walking isochrone.
export const DEFAULT_TRANSIT_WALK_BUDGET_MINUTES = 15;
// Charged for every change, over and above the walk itself: alighting,
// finding the next platform and boarding is never instantaneous, and without
// a floor the scan will happily change vehicles in zero seconds. Only a
// fallback - where the feed's transfers.txt declares a real minimum for an
// interchange, the graph carries that instead, per transfer.
export const TRANSIT_MIN_TRANSFER_SECONDS = 60;
export const CAR_FALLBACK_SPEED_KPH = 30;
// Kept numerically identical to FERRY_FALLBACK_SPEED_KPH in
// data_pipeline/src/isochrone_pipeline/adjacency.py.
export const WATER_FALLBACK_SPEED_KPH = 25;
export const ROAD_CLASS_MOTORWAY = 15;
export const DEFAULT_COLOUR_CYCLE_MINUTES = 75;
export const LOADING_FADE_MS = 180;
export const LAST_CLICKED_NODE_QUERY_PARAM = 'node';
export const SELECTED_REGION_QUERY_PARAM = 'region';
export const LANGUAGE_QUERY_PARAM = 'lang';
export const MODE_SELECTION_QUERY_PARAM = 'modes';
export const COLOUR_CYCLE_QUERY_PARAM = 'cycle';
export const DEPARTURE_DATETIME_QUERY_PARAM = 'departure';
export const WALK_SPEED_QUERY_PARAM = 'walkKph';
export const BIKE_SPEED_QUERY_PARAM = 'bikeKph';
export const TRANSIT_WALK_BUDGET_QUERY_PARAM = 'walkMin';
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
