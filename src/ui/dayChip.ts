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

/** The day heading: date followed by every distinct reliable location name. */
export function dayHeading(day: DayGroup): string {
  const locations = placesFor(day).all.join(' · ');
  return locations ? `${day.label} · ${locations}` : day.label;
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
    .sort((a, b) => {
      const countDifference = b.photoIds.length - a.photoIds.length;
      if (countDifference !== 0) return countDifference;

      // When equally represented, prefer a landmark known to enclose the
      // photos over a nearby guess, and either landmark over an area-only name.
      // This makes a Sensō-ji cluster win its tie with nearby Kaminarimon.
      return landmarkConfidence(b) - landmarkConfidence(a);
    });

  const seen = new Set<string>();
  const names: string[] = [];

  for (const cluster of clusters) {
    // The same matched location shown on the map and photo card should also be
    // reflected in the day navigation. Nearby matches are already identified
    // as "Near" in the detailed caption, where that nuance fits.
    const short = cluster.place.split(',')[0]?.trim();
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

function landmarkConfidence(cluster: DayGroup['regions'][number]['clusters'][number]): number {
  if (!cluster.landmark) return 0;
  return cluster.landmarkNearby ? 1 : 2;
}
