/**
 * Capture-time handling.
 *
 * The model here is deliberate and worth reading before changing anything.
 *
 * EXIF `DateTimeOriginal` is a *naive wall clock* — "2026:06:06 16:42:00" with
 * no timezone. Most cameras never write the companion `OffsetTimeOriginal`, so
 * the true UTC instant is usually unknowable. What a photo gallery actually
 * wants to show is the wall clock anyway: a photo taken at 4:42pm in Tokyo
 * should read "4:42 PM" and belong to that Tokyo day, not shift around based on
 * where the viewer happens to be sitting. Tokyo2026's hand-built
 * `capture-times.js` made the same choice.
 *
 * So `takenAt` stores the wall clock *encoded as if it were UTC*: formatting it
 * with timeZone 'UTC' reproduces exactly what the camera recorded. The real
 * offset, when known, is carried separately in `tzOffsetMinutes` purely for
 * display ("UTC+09:00").
 *
 * Consequence to keep in mind: `takenAt` is not a true instant, so it must not
 * be compared across timezones as though it were. Within a day — which is all
 * the sorting here does — it is exactly right.
 */

export const UNDATED_KEY = 'undated';

export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Parses EXIF's "YYYY:MM:DD HH:MM:SS" form. */
export function parseExifDateTime(raw: unknown): WallClock | null {
  if (typeof raw !== 'string') return null;

  const m = /^(\d{4})[:-](\d{2})[:-](\d{2})[T ](\d{2}):(\d{2}):(\d{2})/.exec(raw.trim());
  if (!m) return null;

  const wall: WallClock = {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
    second: Number(m[6]),
  };

  // Cameras with a dead clock battery write all-zero dates; treat as undated.
  if (wall.year < 1900 || wall.month < 1 || wall.month > 12 || wall.day < 1 || wall.day > 31) {
    return null;
  }

  return wall;
}

/** Parses EXIF's "+09:00" / "-07:00" offset into minutes east of UTC. */
export function parseExifOffset(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;

  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(raw.trim());
  if (!m) return null;

  const minutes = Number(m[2]) * 60 + Number(m[3]);
  if (!Number.isFinite(minutes) || minutes > 14 * 60) return null;

  return m[1] === '-' ? -minutes : minutes;
}

/** Encodes a wall clock as the pseudo-instant described in the module comment. */
export function wallClockToInstant(wall: WallClock): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
}

/**
 * Fallback for photos with no EXIF date: the file's own timestamp, converted
 * into the same wall-clock encoding using the viewer's current zone.
 */
export function instantFromFileTime(lastModified: number): {
  instant: number;
  offsetMinutes: number;
} {
  const offsetMinutes = -new Date(lastModified).getTimezoneOffset();
  return { instant: lastModified + offsetMinutes * 60_000, offsetMinutes };
}

/** Grouping key: the calendar date the camera recorded. */
export function dayKeyOf(instant: number | null): string | null {
  if (instant === null) return null;
  return new Date(instant).toISOString().slice(0, 10);
}

const dayLabelFormat = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

const capturedFormat = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'UTC',
});

const clockFormat = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'UTC',
});

/** "Sat, Jun 6, 2026" for a "YYYY-MM-DD" key. */
export function formatDayLabel(dayKey: string): string {
  if (dayKey === UNDATED_KEY) return 'Date unknown';
  const instant = Date.parse(`${dayKey}T00:00:00Z`);
  if (Number.isNaN(instant)) return dayKey;
  return dayLabelFormat.format(instant);
}

/**
 * "Sat, Jun 6, 2026 · 4:42 PM UTC+09:00" — matching the reference's format.
 *
 * The zone suffix is a numeric offset rather than an abbreviation like "JST",
 * because EXIF records only the offset and mapping one back to a named zone is
 * ambiguous. Omitted entirely when the camera didn't record an offset, rather
 * than guessing one.
 */
export function formatCaptured(instant: number | null, offsetMinutes: number | null): string {
  if (instant === null) return '';
  const stamp = capturedFormat.format(instant).replace(/,\s*(\d+:\d+)/, ' · $1');
  const zone = formatOffset(offsetMinutes);
  return zone ? `${stamp} ${zone}` : stamp;
}

/** "4:42 PM" */
export function formatClock(instant: number | null): string {
  return instant === null ? '' : clockFormat.format(instant);
}

export function formatOffset(offsetMinutes: number | null): string {
  if (offsetMinutes === null) return '';
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `UTC${sign}${hh}:${mm}`;
}

/** Coarse phrase used when composing descriptions. */
export function timeOfDayPhrase(instant: number | null): string {
  if (instant === null) return '';
  const hour = new Date(instant).getUTCHours();
  if (hour < 5) return 'the small hours';
  if (hour < 9) return 'early morning';
  if (hour < 12) return 'late morning';
  if (hour < 14) return 'midday';
  if (hour < 17) return 'afternoon';
  if (hour < 20) return 'evening';
  return 'night';
}
