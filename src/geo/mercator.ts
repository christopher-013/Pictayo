import type { GpsPoint } from '../types';

/**
 * Web Mercator maths, ported from the Tokyo2026 gallery.
 *
 * The map is a keyless Google Maps embed used purely as a basemap, with HTML
 * pins positioned on top of it. That only works if we project coordinates the
 * exact same way Google does: 256px tiles, y from the Mercator formula, world
 * size doubling per zoom level.
 */

const TILE_SIZE = 256;

/** Pin geometry: anchored bottom-centre, 46px tall, so it needs headroom above. */
const PIN_MARGIN_X = 28;
const PIN_MARGIN_TOP = 54;
const PIN_MARGIN_BOTTOM = 14;

export interface WorldPoint {
  x: number;
  y: number;
}

export function worldSizeAt(zoom: number): number {
  return TILE_SIZE * Math.pow(2, zoom);
}

/** Normalized Mercator y in [0, 1]. Clamped to avoid infinity at the poles. */
export function mercatorY(lat: number): number {
  let siny = Math.sin((lat * Math.PI) / 180);
  siny = Math.min(Math.max(siny, -0.9999), 0.9999);
  return 0.5 - Math.log((1 + siny) / (1 - siny)) / (4 * Math.PI);
}

/** Inverse of {@link mercatorY}. */
export function latitudeFromMercator(y: number): number {
  return (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
}

export function worldPoint(lat: number, lon: number, worldSize: number): WorldPoint {
  return {
    x: ((lon + 180) / 360) * worldSize,
    y: mercatorY(lat) * worldSize,
  };
}

/**
 * Centre of a set of points.
 *
 * Latitude is averaged in *Mercator* space, not degrees. Averaging degrees puts
 * the centre visibly off on a tall bounding box, because Mercator stretches
 * higher latitudes — the reference implementation got this right and it matters.
 */
export function centerOf(points: GpsPoint[]): GpsPoint {
  if (points.length === 0) return { lat: 0, lon: 0 };

  let minY = Infinity;
  let maxY = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;

  for (const p of points) {
    const y = mercatorY(p.lat);
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }

  return {
    lat: round6(latitudeFromMercator((minY + maxY) / 2)),
    lon: round6((minLon + maxLon) / 2),
  };
}

/**
 * Highest zoom at which every point still fits inside a canvas of the given
 * size, allowing for pin geometry. Walks down from maxZoom like the reference.
 */
export function fitZoom(
  points: GpsPoint[],
  width: number,
  height: number,
  maxZoom = 16,
  minZoom = 2,
): number {
  if (points.length <= 1) return Math.min(maxZoom, 15);

  const usableWidth = Math.max(1, width - PIN_MARGIN_X * 2);
  const usableHeight = Math.max(1, height - PIN_MARGIN_TOP - PIN_MARGIN_BOTTOM);

  let minY = Infinity;
  let maxY = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;

  for (const p of points) {
    const y = mercatorY(p.lat);
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }

  for (let zoom = maxZoom; zoom > minZoom; zoom--) {
    const size = worldSizeAt(zoom);
    const spanX = ((maxLon - minLon) / 360) * size;
    const spanY = (maxY - minY) * size;
    if (spanX <= usableWidth && spanY <= usableHeight) return zoom;
  }

  return minZoom;
}

/** Pixel position of a coordinate within a canvas centred on `center` at `zoom`. */
export function screenPosition(
  point: GpsPoint,
  center: GpsPoint,
  zoom: number,
  width: number,
  height: number,
): { left: number; top: number; visible: boolean } {
  const size = worldSizeAt(zoom);
  const c = worldPoint(center.lat, center.lon, size);
  const p = worldPoint(point.lat, point.lon, size);
  const left = width / 2 + p.x - c.x;
  const top = height / 2 + p.y - c.y;

  return {
    left,
    top,
    visible:
      left >= PIN_MARGIN_X - 3 &&
      left <= width - PIN_MARGIN_X + 3 &&
      top >= PIN_MARGIN_TOP - 4 &&
      top <= height - PIN_MARGIN_BOTTOM + 4,
  };
}

function round6(n: number): number {
  return Number(n.toFixed(6));
}
