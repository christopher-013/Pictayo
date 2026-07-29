import type { IngestResult } from '../types';
import { readVideoMeta } from '../meta/videoMeta';

/**
 * Brings a video into the library.
 *
 * Unlike photos this runs on the main thread, because the only way to get a
 * still out of a video in a browser is to load it into a `<video>` element,
 * seek, and paint a frame — and there is no video element in a worker. Videos
 * are usually a handful next to hundreds of photos, so the cost is bearable.
 */

const THUMB_MAX = 320;
const DISPLAY_MAX = 1600;
const THUMB_QUALITY = 0.72;
const DISPLAY_QUALITY = 0.82;

/** How far in to grab the poster frame. The first frame is often a black fade-in. */
const POSTER_SECONDS = 1;

/** Give up on a video that will not load or seek rather than hanging the import. */
const DECODE_TIMEOUT_MS = 15_000;

/**
 * Bytes hashed to identify a video.
 *
 * Photos are hashed whole, but a video can run to hundreds of megabytes and
 * reading all of it just to make an id would dominate the import. The opening
 * chunk plus the exact byte length is more than enough to tell two clips apart
 * — and a collision would only mean one replacing the other in the library.
 */
const HASH_SAMPLE_BYTES = 2 * 1024 * 1024;

export async function ingestVideo(file: File): Promise<IngestResult> {
  const [id, meta] = await Promise.all([hashVideo(file), readVideoMeta(file)]);

  let thumb: Blob | null = null;
  let display: Blob | null = null;
  let previewUnavailable = false;

  try {
    const frame = await grabPosterFrame(file);
    meta.width = frame.width;
    meta.height = frame.height;

    [thumb, display] = await Promise.all([
      encode(frame, THUMB_MAX, THUMB_QUALITY),
      encode(frame, DISPLAY_MAX, DISPLAY_QUALITY),
    ]);
  } catch {
    // Usually a codec the browser cannot decode — HEVC from an iPhone is the
    // common one outside Safari. The video keeps its date, place and caption;
    // it just shows a placeholder instead of a poster frame.
    previewUnavailable = true;
  }

  return {
    id,
    name: file.name,
    bytes: file.size,
    kind: 'video',
    durationMs: meta.durationMs,
    meta,
    thumb,
    display,
    video: file,
    previewUnavailable,
  };
}

async function hashVideo(file: File): Promise<string> {
  const sample = await file.slice(0, Math.min(file.size, HASH_SAMPLE_BYTES)).arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', sample);

  const hex = [...new Uint8Array(digest).slice(0, 6)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  // Length included so two clips sharing an opening chunk still differ.
  return `${hex}${file.size.toString(16)}`;
}

/** Loads the video far enough to paint one frame onto a canvas. */
async function grabPosterFrame(file: File): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');

  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;
  // Never attached to the document; it only exists to decode a frame.
  video.src = url;

  try {
    await waitFor(video, 'loadedmetadata');

    const target = Math.min(POSTER_SECONDS, (video.duration || 2) / 2);
    // Some browsers ignore a seek to exactly 0, so nudge it forward.
    video.currentTime = Number.isFinite(target) && target > 0 ? target : 0.1;
    await waitFor(video, 'seeked');

    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) throw new Error('video reported no dimensions');

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext('2d');
    if (!context) throw new Error('no 2D context');
    context.drawImage(video, 0, 0, width, height);

    return canvas;
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

function waitFor(video: HTMLVideoElement, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener(event, onDone);
      video.removeEventListener('error', onError);
      clearTimeout(timer);
    };
    const onDone = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error(`video ${event} failed`)); };

    const timer = setTimeout(() => { cleanup(); reject(new Error(`video ${event} timed out`)); },
      DECODE_TIMEOUT_MS);

    video.addEventListener(event, onDone, { once: true });
    video.addEventListener('error', onError, { once: true });
  });
}

async function encode(source: HTMLCanvasElement, max: number, quality: number): Promise<Blob> {
  const scale = Math.min(1, max / Math.max(source.width, source.height));
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d');
  if (!context) throw new Error('no 2D context');
  context.drawImage(source, 0, 0, width, height);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('encode failed'))),
      'image/webp',
      quality,
    );
  });
}
