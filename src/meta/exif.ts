import exifr from 'exifr';
import type { PhotoMeta } from '../types';
import {
  dayKeyOf,
  instantFromFileTime,
  parseExifDateTime,
  parseExifOffset,
  wallClockToInstant,
} from './datetime';

/**
 * Normalizes whatever EXIF a file happens to carry into a {@link PhotoMeta}.
 *
 * Dates are read as raw strings (`reviveValues: false`) rather than letting
 * exifr build Date objects. exifr interprets a naive EXIF timestamp in the
 * *browser's* timezone, which would silently shift capture times — and
 * therefore day grouping — depending on where the page is being viewed. Parsing
 * the string ourselves keeps the camera's wall clock intact. See ./datetime.ts.
 */

interface RawTags {
  DateTimeOriginal?: unknown;
  CreateDate?: unknown;
  ModifyDate?: unknown;
  OffsetTimeOriginal?: unknown;
  OffsetTimeDigitized?: unknown;
  OffsetTime?: unknown;
  Make?: unknown;
  Model?: unknown;
  ExifImageWidth?: unknown;
  ExifImageHeight?: unknown;
  ImageWidth?: unknown;
  ImageHeight?: unknown;
}

export async function readMeta(file: File): Promise<PhotoMeta> {
  const [tags, gps] = await Promise.all([
    exifr
      .parse(file, {
        // `tiff: true` pulls in IFD0 (Make/Model) and the Exif sub-IFD (dates)
        // together; GPS is read separately below.
        tiff: true,
        gps: false,
        reviveValues: false,
        translateValues: false,
        mergeOutput: true,
      })
      .catch(() => null) as Promise<RawTags | null>,
    // exifr.gps parses only the GPS block and already resolves the N/S/E/W refs.
    exifr.gps(file).catch(() => null),
  ]);

  const wall =
    parseExifDateTime(tags?.DateTimeOriginal) ??
    parseExifDateTime(tags?.CreateDate) ??
    parseExifDateTime(tags?.ModifyDate);

  let takenAt: number | null = null;
  let tzOffsetMinutes: number | null = null;
  let dateSource: PhotoMeta['dateSource'] = 'none';

  if (wall) {
    takenAt = wallClockToInstant(wall);
    tzOffsetMinutes =
      parseExifOffset(tags?.OffsetTimeOriginal) ??
      parseExifOffset(tags?.OffsetTimeDigitized) ??
      parseExifOffset(tags?.OffsetTime);
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
    gps: validGps(gps),
    width: asDimension(tags?.ExifImageWidth ?? tags?.ImageWidth),
    height: asDimension(tags?.ExifImageHeight ?? tags?.ImageHeight),
    make: asText(tags?.Make),
    model: asText(tags?.Model),
    dateSource,
  };
}

/**
 * Rejects coordinates that are out of range or sitting exactly at Null Island —
 * (0, 0) is what a GPS chip writes when it never got a fix, not a real location
 * off the coast of Ghana.
 */
function validGps(gps: { latitude?: number; longitude?: number } | null): PhotoMeta['gps'] {
  const lat = gps?.latitude;
  const lon = gps?.longitude;

  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  if (lat === 0 && lon === 0) return null;

  return { lat, lon };
}

function asDimension(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : null;
}

function asText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // Some firmware pads these fields with NULs.
  const trimmed = value.replace(/\0/g, '').trim();
  return trimmed ? trimmed : null;
}
