import {
  CYCLE_COLOUR_MAP_GLSL,
  DEFAULT_COLOUR_CYCLE_MINUTES,
} from '../config/constants.js';

export { CYCLE_COLOUR_MAP_GLSL, DEFAULT_COLOUR_CYCLE_MINUTES };
export const ISOCHRONE_THEME_DARK = 'dark';
export const ISOCHRONE_THEME_LIGHT = 'light';

const ISOCHRONE_PALETTE_DARK = [
  [0, 255, 255],
  [64, 255, 64],
  [255, 255, 64],
  [255, 140, 0],
  [255, 64, 160],
];

const ISOCHRONE_PALETTE_LIGHT = [
  [0, 110, 210],
  [0, 150, 70],
  [185, 140, 0],
  [185, 85, 0],
  [165, 0, 130],
];

export function normalizeIsochroneTheme(theme, fallback = ISOCHRONE_THEME_DARK) {
  if (theme === ISOCHRONE_THEME_LIGHT || theme === ISOCHRONE_THEME_DARK) {
    return theme;
  }
  if (fallback === ISOCHRONE_THEME_LIGHT || fallback === ISOCHRONE_THEME_DARK) {
    return fallback;
  }
  return ISOCHRONE_THEME_DARK;
}

export function getIsochronePalette(theme = ISOCHRONE_THEME_DARK) {
  const normalizedTheme = normalizeIsochroneTheme(theme);
  return normalizedTheme === ISOCHRONE_THEME_LIGHT ? ISOCHRONE_PALETTE_LIGHT : ISOCHRONE_PALETTE_DARK;
}

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
  const palette = getIsochronePalette(options.theme ?? ISOCHRONE_THEME_DARK);

  if (cycleRatio <= 1 / 5) {
    return palette[0];
  }
  if (cycleRatio <= 2 / 5) {
    return palette[1];
  }
  if (cycleRatio <= 3 / 5) {
    return palette[2];
  }
  if (cycleRatio <= 4 / 5) {
    return palette[3];
  }

  // Final fifth band in each cycle.
  return palette[4];
}
