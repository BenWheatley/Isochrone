import { formatCommonMessage } from './localization.js';

export function formatLegendDuration(totalMinutes, options = {}) {
  const roundedMinutes = Math.max(0, Math.round(totalMinutes));
  const messages = options.messages ?? null;

  if (roundedMinutes < 60) {
    return formatCommonMessage(
      messages,
      'legend.duration.minuteOnly',
      { minutes: roundedMinutes },
      `${roundedMinutes} min`,
    );
  }

  const hours = Math.floor(roundedMinutes / 60);
  const minutes = roundedMinutes % 60;
  if (minutes === 0) {
    return formatCommonMessage(
      messages,
      'legend.duration.hourOnly',
      { hours },
      `${hours} h`,
    );
  }

  return formatCommonMessage(
    messages,
    'legend.duration.hourMinute',
    { hours, minutes },
    `${hours} h ${minutes} min`,
  );
}

export function formatLegendRange(startMinutes, endMinutes, options = {}) {
  const messages = options.messages ?? null;
  const start = formatLegendDuration(startMinutes, { messages });
  const end = formatLegendDuration(endMinutes, { messages });
  return formatCommonMessage(messages, 'legend.range', { start, end }, `${start}–${end}`);
}

export function formatLegendRepeatNote(cycleMinutes, options = {}) {
  const messages = options.messages ?? null;
  const duration = formatLegendDuration(cycleMinutes, { messages });
  return formatCommonMessage(
    messages,
    'legend.repeat',
    { duration },
    `Colours repeat every ${duration}.`,
  );
}
