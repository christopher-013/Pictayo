import type { DayGroup } from '../types';
import { UNDATED_KEY } from '../meta/datetime';

/**
 * The content of a date-strip card, shared by the live app and the exported
 * album so both strips read identically.
 */

/**
 * How many place names a chip shows.
 *
 * One. A day often has several, and listing two made the chips wide and hard to
 * scan for the thing they are actually for — picking a date. The busiest place
 * is the useful one; the rest are in the chip's tooltip.
 */
const MAX_CHIP_PLACES = 1;

export interface ChipParts {
  month: string;
  number: string;
  weekday: string;
}

/** "Sat, Jun 6, 2026" → { month: "JUN", number: "6", weekday: "SAT" } */
export function chipParts(day: DayGroup): ChipParts {
  if (day.dayKey === UNDATED_KEY) return { month: '', number: '?', weekday: 'UNDATED' };

  const instant = Date.parse(`${day.dayKey}T00:00:00Z`);
  if (Number.isNaN(instant)) return { month: '', number: '?', weekday: '' };

  const date = new Date(instant);
  const format = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' }).format(date);

  return {
    month: format({ month: 'short' }).toUpperCase(),
    number: format({ day: 'numeric' }),
    weekday: format({ weekday: 'short' }).toUpperCase(),
  };
}

export interface DayPlaces {
  /** What the chip shows: up to two names, plus "+N" when there are more. */
  label: string;
  /** Every distinct place, busiest first — used for the tooltip. */
  all: string[];
}

/**
 * The places a day's photos were taken, busiest first.
 *
 * Names are shortened to their most specific part — "Shinjuku, Tokyo" becomes
 * "Shinjuku" — because the chip has room for a landmark, not an address, and
 * the broader half repeats across every day of a trip anyway.
 */
export function placesFor(day: DayGroup): DayPlaces {
  const clusters = day.regions
    .flatMap((region) => region.clusters)
    .slice()
    .sort((a, b) => b.photoIds.length - a.photoIds.length);

  const seen = new Set<string>();
  const names: string[] = [];

  for (const cluster of clusters) {
    // A nearest landmark is only a guess. Keep the reliable area in the compact
    // day navigation instead of confidently relabelling the whole day after a
    // nearby museum, station, or attraction.
    const displayPlace = cluster.landmarkNearby ? cluster.area : cluster.place;
    const short = displayPlace.split(',')[0]?.trim();
    if (!short || seen.has(short)) continue;
    seen.add(short);
    names.push(short);
  }

  if (names.length === 0) {
    const count = day.photos.length;
    return { label: `${count} photo${count === 1 ? '' : 's'}`, all: [] };
  }

  // No "+N" suffix: it added width for information the tooltip already carries.
  return { label: names.slice(0, MAX_CHIP_PLACES).join(' · '), all: names };
}
