import type { PhotoMeta } from '../types';
import { dayKeyOf, instantFromFileTime, parseExifOffset, wallClockToInstant } from './datetime';

/**
 * Reads capture time and location out of a video file.
 *
 * Videos carry none of this in EXIF — exifr returns nothing for an MP4 — so the
 * QuickTime container has to be walked directly. MP4 and MOV share the same box
 * layout: a 4-byte big-endian size, a 4-byte type, then the payload, nested.
 *
 * Three sources, in descending order of usefulness:
 *
 *  - `com.apple.quicktime.creationdate` — an ISO 8601 timestamp *with* the
 *    offset the camera was in ("2026-06-08T16:43:00+0900"). The only source
 *    that knows the local time, which is what the day grouping needs.
 *  - `moov/mvhd` creation time — seconds since 1904, always UTC, no offset.
 *    Fine as a fallback, but a video shot at 4pm in Tokyo lands on the wrong
 *    day for a viewer far enough west.
 *  - ISO 6709 location ("+35.7056+139.7519+12.345/"), written by iPhones both
 *    as a `©xyz` box and inside Apple's metadata.
 *
 * The two Apple values live in a `meta`/`keys`/`ilst` structure whose full
 * parse is long and fiddly. Since both have distinctive, unambiguous shapes,
 * they are matched against the decoded `moov` payload instead — far shorter,
 * and it copes with the layout variations between iOS versions and Android.
 */

/** Seconds between the QuickTime epoch (1904-01-01) and the Unix epoch. */
const QUICKTIME_EPOCH_OFFSET_SECONDS = 2_082_844_800;

/** `moov` can be large; only its head is scanned for the metadata strings. */
const MAX_SCAN_BYTES = 4 * 1024 * 1024;

export interface VideoMeta extends PhotoMeta {
  /** Duration in milliseconds, when the container reported one. */
  durationMs: number | null;
}

export async function readVideoMeta(file: File): Promise<VideoMeta> {
  // The metadata sits in `moov`, which is at the front of a
  // streaming-optimised file and at the very end otherwise. Reading the whole
  // file would mean pulling hundreds of megabytes into memory for a timestamp,
  // so try the head first and fall back to the tail.
  const head = await readSlice(file, 0, Math.min(file.size, MAX_SCAN_BYTES));
  let moov = findBox(head, 'moov');

  if (!moov && file.size > MAX_SCAN_BYTES) {
    const tail = await readSlice(file, Math.max(0, file.size - MAX_SCAN_BYTES), file.size);
    moov = findBox(tail, 'moov');
  }

  const parsed = moov ? parseMoov(moov) : null;

  let takenAt: number | null = null;
  let tzOffsetMinutes: number | null = null;
  let dateSource: PhotoMeta['dateSource'] = 'none';

  if (parsed?.wallClock) {
    takenAt = parsed.wallClock.instant;
    tzOffsetMinutes = parsed.wallClock.offsetMinutes;
    dateSource = 'exif';
  } else if (parsed?.mvhdCreatedAt) {
    // No offset recorded, so this instant is UTC. Encode it the same way the
    // rest of the app does — see ./datetime.ts — and leave the offset unknown.
    takenAt = parsed.mvhdCreatedAt;
    tzOffsetMinutes = null;
    dateSource = 'exif';
  } else if (Number.isFinite(file.lastModified) && file.lastModified > 0) {
    const fallback = instantFromFileTime(file.lastModified);
    takenAt = fallback.instant;
    tzOffsetMinutes = fallback.offsetMinutes;
    dateSource = 'file';
  }

  return {
    takenAt,
    tzOffsetMinutes,
    dayKey: dayKeyOf(takenAt),
    gps: parsed?.gps ?? null,
    width: null,
    height: null,
    make: null,
    model: null,
    dateSource,
    durationMs: parsed?.durationMs ?? null,
  };
}

async function readSlice(file: File, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

/** Walks top-level boxes looking for one by type. */
export function findBox(bytes: Uint8Array, wanted: string): Uint8Array | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;

  while (offset + 8 <= bytes.length) {
    let size = view.getUint32(offset);
    const type = String.fromCharCode(
      bytes[offset + 4]!, bytes[offset + 5]!, bytes[offset + 6]!, bytes[offset + 7]!,
    );

    let headerSize = 8;
    if (size === 1) {
      // 64-bit size, stored in the eight bytes after the type.
      if (offset + 16 > bytes.length) return null;
      size = Number(view.getBigUint64(offset + 8));
      headerSize = 16;
    } else if (size === 0) {
      // Runs to the end of the file.
      size = bytes.length - offset;
    }

    if (size < headerSize) return null;

    if (type === wanted) {
      return bytes.subarray(offset + headerSize, Math.min(offset + size, bytes.length));
    }

    offset += size;
  }

  return null;
}

interface ParsedMoov {
  mvhdCreatedAt: number | null;
  durationMs: number | null;
  gps: { lat: number; lon: number } | null;
  wallClock: { instant: number; offsetMinutes: number | null } | null;
}

export function parseMoov(moov: Uint8Array): ParsedMoov {
  const mvhd = findBox(moov, 'mvhd');
  let mvhdCreatedAt: number | null = null;
  let durationMs: number | null = null;

  if (mvhd && mvhd.length >= 20) {
    const view = new DataView(mvhd.buffer, mvhd.byteOffset, mvhd.byteLength);
    const version = mvhd[0];

    try {
      if (version === 1 && mvhd.length >= 32) {
        const created = Number(view.getBigUint64(4));
        const timescale = view.getUint32(20);
        const duration = Number(view.getBigUint64(24));
        mvhdCreatedAt = quickTimeToUnixMs(created);
        durationMs = timescale > 0 ? (duration / timescale) * 1000 : null;
      } else {
        const created = view.getUint32(4);
        const timescale = view.getUint32(12);
        const duration = view.getUint32(16);
        mvhdCreatedAt = quickTimeToUnixMs(created);
        durationMs = timescale > 0 ? (duration / timescale) * 1000 : null;
      }
    } catch {
      // Malformed header; the text scan below may still find something.
    }
  }

  const text = decodeForScan(moov);

  return {
    mvhdCreatedAt,
    durationMs: durationMs && Number.isFinite(durationMs) ? Math.round(durationMs) : null,
    gps: parseIso6709(text),
    wallClock: parseAppleCreationDate(text),
  };
}

function quickTimeToUnixMs(seconds: number): number | null {
  if (!Number.isFinite(seconds) || seconds <= QUICKTIME_EPOCH_OFFSET_SECONDS) return null;
  const ms = (seconds - QUICKTIME_EPOCH_OFFSET_SECONDS) * 1000;
  // Reject clearly bogus clocks rather than filing a video under 1970.
  return ms > Date.UTC(1990, 0, 1) ? ms : null;
}

/** latin1 so byte offsets survive; only ASCII patterns are searched for. */
function decodeForScan(bytes: Uint8Array): string {
  return new TextDecoder('latin1').decode(
    bytes.length > MAX_SCAN_BYTES ? bytes.subarray(0, MAX_SCAN_BYTES) : bytes,
  );
}

/**
 * "+35.7056+139.7519+012.345/" — sign-prefixed latitude then longitude, with an
 * optional altitude, terminated by a slash.
 */
export function parseIso6709(text: string): { lat: number; lon: number } | null {
  const match = /([+-]\d{1,2}\.\d+)([+-]\d{1,3}\.\d+)/.exec(text);
  if (!match) return null;

  const lat = Number(match[1]);
  const lon = Number(match[2]);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  // (0, 0) means the chip never got a fix, not a spot in the Atlantic.
  if (lat === 0 && lon === 0) return null;

  return { lat, lon };
}

/** "2026-06-08T16:43:00+0900" — the local wall clock plus its offset. */
export function parseAppleCreationDate(
  text: string,
): { instant: number; offsetMinutes: number | null } | null {
  const match = /(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?/.exec(text);
  if (!match) return null;

  const year = Number(match[1]);
  if (year < 1990 || year > 2200) return null;

  const instant = wallClockToInstant({
    year,
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6]),
  });

  const zone = match[7];
  let offsetMinutes: number | null = null;
  if (zone === 'Z') offsetMinutes = 0;
  else if (zone) {
    const normalised = zone.includes(':') ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`;
    offsetMinutes = parseExifOffset(normalised);
  }

  return { instant, offsetMinutes };
}
