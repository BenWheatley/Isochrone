import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatLegendDuration,
  formatLegendRange,
  formatLegendRepeatNote,
} from '../src/ui/legend-format.js';

test('formatLegendDuration falls back to readable english templates', () => {
  assert.equal(formatLegendDuration(24), '24 min');
  assert.equal(formatLegendDuration(120), '2 h');
  assert.equal(formatLegendDuration(72), '1 h 12 min');
});

test('formatLegendDuration uses locale-specific templates when provided', () => {
  const germanMessages = {
    'legend.duration.minuteOnly': '{minutes} Min.',
    'legend.duration.hourOnly': '{hours} Std.',
    'legend.duration.hourMinute': '{hours} Std. {minutes} Min.',
  };
  const frenchMessages = {
    'legend.duration.minuteOnly': '{minutes} min',
    'legend.duration.hourOnly': '{hours} h',
    'legend.duration.hourMinute': '{hours} h {minutes} min',
  };

  assert.equal(formatLegendDuration(72, { messages: germanMessages }), '1 Std. 12 Min.');
  assert.equal(formatLegendDuration(120, { messages: germanMessages }), '2 Std.');
  assert.equal(formatLegendDuration(72, { messages: frenchMessages }), '1 h 12 min');
});

test('formatLegendRange and formatLegendRepeatNote use localized message templates', () => {
  const frenchMessages = {
    'legend.duration.minuteOnly': '{minutes} min',
    'legend.duration.hourOnly': '{hours} h',
    'legend.duration.hourMinute': '{hours} h {minutes} min',
    'legend.range': '{start}–{end}',
    'legend.repeat': 'Les couleurs se répètent toutes les {duration}.',
  };

  assert.equal(formatLegendRange(48, 72, { messages: frenchMessages }), '48 min–1 h 12 min');
  assert.equal(
    formatLegendRepeatNote(120, { messages: frenchMessages }),
    'Les couleurs se répètent toutes les 2 h.',
  );
});
