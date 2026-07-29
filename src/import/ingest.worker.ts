/// <reference lib="webworker" />
import { readMeta } from '../meta/exif';
import type { IngestRequest, IngestResult } from '../types';

/**
 * Per-file ingest: hash, read metadata, and produce the two derivatives the app
 * stores. Runs off the main thread because decoding and re-encoding a few
 * hundred photos would otherwise lock the UI solid.
 */

/** Grid tiles are small; 320px covers them at 2x on a phone. */
const THUMB_MAX = 320;
/** Big enough for the lightbox and the exported site, small enough to keep. */
const DISPLAY_MAX = 1600;

const THUMB_QUALITY = 0.72;
const DISPLAY_QUALITY = 0.82;

self.onmessage = async (event: MessageEvent<IngestRequest>) => {
  const { id, file } = event.data;

  try {
    const [contentId, meta] = await Promise.all([hashFile(file), readMeta(file)]);

    let thumb: Blob | null = null;
    let display: Blob | null = null;
    let previewUnavailable = false;

    try {
      // `from-image` applies the EXIF orientation flag, so portrait iPhone
      // shots don't come out sideways. Without it every rotated photo is wrong.
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });

      // Post-orientation dimensions are the true ones; prefer them over EXIF.
      meta.width = bitmap.width;
      meta.height = bitmap.height;

      [thumb, display] = await Promise.all([
        encode(bitmap, THUMB_MAX, THUMB_QUALITY),
        encode(bitmap, DISPLAY_MAX, DISPLAY_QUALITY),
      ]);

      bitmap.close();
    } catch {
      // Typically HEIC on a browser that can read its metadata but not decode
      // its pixels. The photo is still worth keeping — it has a date and a
      // location — so it stays in the library with a placeholder tile.
      previewUnavailable = true;
    }

    const result: IngestResult = {
      id: contentId,
      name: file.name,
      bytes: file.size,
      kind: 'photo',
      meta,
      thumb,
      display,
      previewUnavailable,
    };

    postMessage(result, transferables(result));
  } catch (error) {
    const failure: IngestResult = {
      id,
      name: file.name,
      bytes: file.size,
      kind: 'photo',
      meta: {
        takenAt: null,
        tzOffsetMinutes: null,
        dayKey: null,
        gps: null,
        width: null,
        height: null,
        make: null,
        model: null,
        dateSource: 'none',
      },
      thumb: null,
      display: null,
      previewUnavailable: true,
      error: error instanceof Error ? error.message : String(error),
    };
    postMessage(failure);
  }
};

/**
 * Content hash as the photo id, so re-importing the same folder updates rows
 * instead of duplicating them. Truncated to 16 hex chars — ample for a personal
 * library and much kinder as a DOM id than a full digest.
 */
async function hashFile(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest).slice(0, 8)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function encode(bitmap: ImageBitmap, max: number, quality: number): Promise<Blob> {
  // Never upscale — a small original stays small.
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('OffscreenCanvas 2D context unavailable');

  context.drawImage(bitmap, 0, 0, width, height);

  try {
    return await canvas.convertToBlob({ type: 'image/webp', quality });
  } catch {
    return await canvas.convertToBlob({ type: 'image/jpeg', quality });
  }
}

function transferables(result: IngestResult): StructuredSerializeOptions {
  // Blobs are cloned by reference already; nothing to transfer, but keeping the
  // hook makes it obvious where to add ArrayBuffer transfers if that changes.
  void result;
  return {};
}
