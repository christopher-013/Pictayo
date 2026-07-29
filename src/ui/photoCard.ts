import type { Photo } from '../types';
import { escapeAttr } from '../util/escape';
import { formatCaptured } from '../meta/datetime';

/**
 * One `.photo-card`, in the shape the Tokyo2026 gallery used.
 *
 * Interaction is wired by delegation on `data-lightbox-index` rather than the
 * reference's inline `onclick`, so nothing has to be exposed on `window` and
 * the markup stays safe to build by string concatenation.
 */

export interface CardOptions {
  photo: Photo;
  /** Index into the lightbox list, or -1 when there's no viewable image. */
  lightboxIndex: number;
}

export function photoCardHtml({ photo, lightboxIndex }: CardOptions): string {
  const caption = photo.caption;
  const captured = formatCaptured(photo.meta.takenAt, photo.meta.tzOffsetMinutes);

  const media =
    photo.kind === 'video'
      ? videoHtml(photo)
      : photo.previewUnavailable || !photo.thumbUrl
        ? nopreviewHtml(photo)
        : viewableHtml(photo, lightboxIndex);

  const location =
    caption?.location && caption.mapsUrl
      ? `<div class="photo-location">📍 <a href="${escapeAttr(caption.mapsUrl)}" target="_blank" rel="noopener">${escapeAttr(caption.location)}</a></div>`
      : caption?.location
        ? `<div class="photo-location">📍 ${escapeAttr(caption.location)}</div>`
        : '';

  return (
    `<div class="photo-card" data-photo-id="${escapeAttr(photo.id)}"` +
    (photo.clusterId ? ` data-cluster="${escapeAttr(photo.clusterId)}"` : '') +
    '>' +
    media +
    '<div class="photo-meta">' +
    `<div class="photo-kind">${kindLabel(photo)}</div>` +
    location +
    (caption?.desc ? `<div class="photo-desc">${escapeAttr(caption.desc)}</div>` : '') +
    (captured ? `<div class="photo-captured">🕒 ${escapeAttr(captured)}</div>` : '') +
    '</div>' +
    '</div>'
  );
}

function kindLabel(photo: Photo): string {
  if (photo.kind === 'video') return photo.meta.gps ? 'Video' : 'Video · no GPS';
  return photo.meta.gps ? 'Photo' : 'No GPS';
}

/**
 * Videos play where they sit, exactly as the Tokyo2026 gallery did, rather than
 * opening in the lightbox. The lightbox is built around stepping between
 * stills; a clip you have to dismiss to carry on scrolling is worse than one
 * that just plays in place.
 *
 * `preload="metadata"` keeps a page of clips from downloading themselves before
 * anyone presses play, and the poster frame gives each one something to show in
 * the grid meanwhile.
 */
function videoHtml(photo: Photo): string {
  const poster = photo.thumbUrl ? ` poster="${escapeAttr(photo.thumbUrl)}"` : '';
  const duration = photo.durationMs ? formatDuration(photo.durationMs) : '';

  // No `src` here. The file is fetched from storage and attached after the day
  // renders — see attachVideoSources — so only the videos actually on screen
  // are held in memory. Eagerly resolving a library's worth of clips would mean
  // gigabytes of blob URLs alive at once.
  return (
    '<div class="photo-video-wrap">' +
    `<video class="photo-video" data-video-id="${escapeAttr(photo.id)}"${poster}` +
    ' controls preload="metadata" playsinline></video>' +
    (duration ? `<span class="photo-video-time">${escapeAttr(duration)}</span>` : '') +
    '</div>'
  );
}

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function viewableHtml(photo: Photo, lightboxIndex: number): string {
  const img =
    `<img src="${escapeAttr(photo.thumbUrl)}" alt="${escapeAttr(photo.name)}" loading="lazy" decoding="async">`;

  if (lightboxIndex < 0) return img;

  return (
    `<button class="photo-full-link" type="button" data-lightbox-index="${lightboxIndex}"` +
    ` title="Open full-size photo">${img}</button>`
  );
}

/**
 * Shown when the browser could read the file's metadata but not decode its
 * pixels — almost always HEIC outside Safari. The photo keeps its place in the
 * timeline and on the map rather than vanishing with no explanation.
 */
function nopreviewHtml(photo: Photo): string {
  const kind = photo.name.split('.').pop()?.toUpperCase() ?? 'This format';
  return (
    '<div class="photo-nopreview">' +
    '<span aria-hidden="true">🖼️</span>' +
    `${escapeAttr(kind)} preview isn’t supported in this browser` +
    '</div>'
  );
}
