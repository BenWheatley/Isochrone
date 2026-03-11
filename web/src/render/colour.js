import {
  CYCLE_COLOUR_MAP_GLSL,
  DEFAULT_COLOUR_CYCLE_MINUTES,
} from '../config/constants.js';

export { CYCLE_COLOUR_MAP_GLSL, DEFAULT_COLOUR_CYCLE_MINUTES };

export function timeToColour(seconds, options = {}) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error('seconds must be a non-negative finite number');
  }

  const cycleMinutes = options.cycleMinutes ?? DEFAULT_COLOUR_CYCLE_MINUTES;
  if (!Number.isFinite(cycleMinutes) || cycleMinutes <= 0) {
    throw new Error('cycleMinutes must be a positive finite number');
  }
  const cyclePositionMinutes = (seconds / 60) % cycleMinutes;
  const cycleRatio = cyclePositionMinutes / cycleMinutes;

  if (cycleRatio <= 1 / 5) {
    return [0, 255, 255];
  }
  if (cycleRatio <= 2 / 5) {
    return [64, 255, 64];
  }
  if (cycleRatio <= 3 / 5) {
    return [255, 255, 64];
  }
  if (cycleRatio <= 4 / 5) {
    return [255, 140, 0];
  }

  // Final fifth band in each cycle.
  return [255, 64, 160];
}
