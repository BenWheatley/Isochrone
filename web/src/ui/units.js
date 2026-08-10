// Metric/imperial display. Everything in the model stays metric - speeds are
// km/h, distances metres - and only what the user reads is converted, so a
// unit switch can never perturb routing.

export const CANONICAL_UNIT_SYSTEMS = ['metric', 'imperial'];

export const METRES_PER_MILE = 1609.344;
export const METRES_PER_FOOT = 0.3048;
const KM_PER_MILE = METRES_PER_MILE / 1000;

// Regions that use miles on road signage. Kept as a fallback for browsers
// without Intl.Locale measurement info.
const IMPERIAL_REGIONS = new Set(['US', 'GB', 'LR', 'MM']);

/**
 * The unit system to start in, inferred from where the *user* is (their
 * locale), not from whichever city they happen to be looking at.
 */
export function resolveDefaultUnitSystem(locales = globalThis.navigator?.languages) {
  const candidates = Array.isArray(locales) && locales.length > 0
    ? locales
    : [globalThis.navigator?.language].filter(Boolean);

  for (const tag of candidates) {
    try {
      const locale = new Intl.Locale(tag);
      // Chromium exposes the CLDR measurement system directly; "uksystem"
      // means miles for distance, which is what the scale bar shows.
      const measurementSystem = locale.getInfo?.().measurementSystem;
      if (measurementSystem === 'ussystem' || measurementSystem === 'uksystem') {
        return 'imperial';
      }
      if (measurementSystem === 'metric') {
        return 'metric';
      }
      const region = locale.maximize?.().region ?? locale.region;
      if (region) {
        return IMPERIAL_REGIONS.has(region) ? 'imperial' : 'metric';
      }
    } catch {
      // Malformed tag - fall through to the next candidate.
    }
  }
  return 'metric';
}

export function normalizeUnitSystem(value, fallback = 'metric') {
  if (CANONICAL_UNIT_SYSTEMS.includes(value)) {
    return value;
  }
  return CANONICAL_UNIT_SYSTEMS.includes(fallback) ? fallback : 'metric';
}

/** Reads back whichever system the document is currently displaying. */
export function resolveUnitSystem(rootElement = globalThis.document?.documentElement ?? null) {
  return normalizeUnitSystem(rootElement?.dataset?.units, resolveDefaultUnitSystem());
}

export function speedUnitLabel(unitSystem) {
  return normalizeUnitSystem(unitSystem) === 'imperial' ? 'mph' : 'km/h';
}

export function kphToDisplaySpeed(speedKph, unitSystem) {
  if (normalizeUnitSystem(unitSystem) !== 'imperial') {
    return speedKph;
  }
  return speedKph / KM_PER_MILE;
}

export function displaySpeedToKph(displaySpeed, unitSystem) {
  if (normalizeUnitSystem(unitSystem) !== 'imperial') {
    return displaySpeed;
  }
  return displaySpeed * KM_PER_MILE;
}

/**
 * Splits a distance into the unit a reader would actually use at that
 * magnitude, so the scale bar says "800 ft" rather than "0.2 mi".
 */
function resolveDistanceUnit(distanceMetres, unitSystem) {
  if (normalizeUnitSystem(unitSystem) === 'imperial') {
    return distanceMetres >= METRES_PER_MILE / 2
      ? { suffix: 'mi', metresPerUnit: METRES_PER_MILE }
      : { suffix: 'ft', metresPerUnit: METRES_PER_FOOT };
  }
  return distanceMetres >= 1000
    ? { suffix: 'km', metresPerUnit: 1000 }
    : { suffix: 'm', metresPerUnit: 1 };
}

export function formatDistanceLabel(distanceMetres, unitSystem = 'metric') {
  const { suffix, metresPerUnit } = resolveDistanceUnit(distanceMetres, unitSystem);
  const value = distanceMetres / metresPerUnit;
  if (metresPerUnit === 1 || metresPerUnit === METRES_PER_FOOT || value >= 10) {
    return `${Math.round(value)} ${suffix}`;
  }
  return `${value.toFixed(1)} ${suffix}`;
}

/**
 * Rounds a distance to a 1/2/5-style value that is round *in the displayed
 * unit*. Choosing in metres and converting afterwards would give a scale bar
 * reading "0.6 mi", which defeats the point of a scale bar.
 */
export function pickNiceDistanceMetres(targetDistanceMetres, unitSystem = 'metric') {
  const safeTarget = Math.max(1, targetDistanceMetres);
  const { metresPerUnit } = resolveDistanceUnit(safeTarget, unitSystem);
  const targetInUnits = safeTarget / metresPerUnit;
  const exponent = Math.floor(Math.log10(targetInUnits));
  const base = 10 ** exponent;

  let chosen = base;
  for (const multiplier of [1, 2, 5]) {
    const candidate = multiplier * base;
    if (candidate <= targetInUnits) {
      chosen = candidate;
    }
  }
  if (chosen > targetInUnits) {
    chosen /= 10;
  }
  return chosen * metresPerUnit;
}
