import type { Place } from '../types';
import { getCachedPlace, putCachedPlace } from '../store/db';

/**
 * Reverse geocoding for cluster centroids.
 *
 * Called once per *place cluster*, never per photo, so importing 500 photos
 * typically costs well under twenty lookups. Results are cached in IndexedDB by
 * rounded coordinate, which also makes re-imports and offline reloads free.
 *
 * BigDataCloud's reverse-geocode-client endpoint is used because it needs no API
 * key, sets permissive CORS headers, and is explicitly intended for calls made
 * directly from the browser — so Pictayo needs no backend and no secrets.
 *
 * The request carries a coordinate and nothing else: no image data, filenames,
 * or timestamps. Google Maps embeds and optional Overpass landmark enrichment
 * also receive coordinates; see the README privacy section.
 */

const ENDPOINT = 'https://api.bigdatacloud.net/data/reverse-geocode-client';
const REQUEST_TIMEOUT_MS = 8000;
const MIN_REQUEST_SPACING_MS = 120;
const NETWORK_RETRY_AFTER_MS = 30_000;

export interface Geocoder {
  lookup(lat: number, lon: number): Promise<Place | null>;
}

/** Reads resolved place names without ever starting a network request. */
export class CacheOnlyGeocoder implements Geocoder {
  async lookup(lat: number, lon: number): Promise<Place | null> {
    return (await getCachedPlace(cacheKey(lat, lon)).catch(() => undefined)) ?? null;
  }
}

/** ~110m resolution, comfortably finer than the 250m clustering radius. */
export function cacheKey(lat: number, lon: number): string {
  return `${lat.toFixed(3)},${lon.toFixed(3)}`;
}

export function formatCoords(lat: number, lon: number): string {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(4)}°${ns}, ${Math.abs(lon).toFixed(4)}°${ew}`;
}

export function googleMapsUrl(lat: number, lon: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
}

/**
 * Opens a Google Maps place search for the venue in its surrounding area.
 * Google documents `query` as a place name/address *or* a latitude/longitude
 * pair. Combining a name and raw coordinates can become a nonexistent address.
 */
export function googleMapsVenueUrl(name: string, area?: string): string {
  const query = [name.trim(), area?.trim()].filter(Boolean).join(', ');
  return (
    `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}` +
    '&utm_source=pictayo&utm_campaign=nearby_place'
  );
}

interface BigDataCloudResponse {
  locality?: string;
  city?: string;
  principalSubdivision?: string;
  countryName?: string;
}

export class CachedGeocoder implements Geocoder {
  /** De-duplicates concurrent lookups of the same key within one import. */
  private inFlight = new Map<string, Promise<Place | null>>();
  private queue: Promise<unknown> = Promise.resolve();
  private failedUntil = 0;

  async lookup(lat: number, lon: number): Promise<Place | null> {
    const key = cacheKey(lat, lon);

    const cached = await getCachedPlace(key).catch(() => undefined);
    if (cached) return cached;

    const existing = this.inFlight.get(key);
    if (existing) return existing;

    // Once the network is clearly unavailable, stop hammering it — every
    // remaining cluster would just wait out the same timeout.
    if (Date.now() < this.failedUntil) return null;

    const request = this.enqueue(() => this.fetchPlace(key, lat, lon));
    this.inFlight.set(key, request);

    try {
      return await request;
    } finally {
      this.inFlight.delete(key);
    }
  }

  /** Serializes requests with a small gap, to stay a well-behaved client. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    this.queue = result
      .catch(() => undefined)
      .then(() => new Promise((r) => setTimeout(r, MIN_REQUEST_SPACING_MS)));
    return result;
  }

  private async fetchPlace(key: string, lat: number, lon: number): Promise<Place | null> {
    const url = `${ENDPOINT}?latitude=${lat}&longitude=${lon}&localityLanguage=en`;

    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        // No credentials, no referrer — this request should carry nothing but
        // the coordinate in the query string.
        referrerPolicy: 'no-referrer',
        credentials: 'omit',
      });

      if (!response.ok) return null;

      const data = (await response.json()) as BigDataCloudResponse;
      const place = toPlace(key, data);
      if (place) await putCachedPlace(place).catch(() => undefined);
      return place;
    } catch {
      this.failedUntil = Date.now() + NETWORK_RETRY_AFTER_MS;
      return null;
    }
  }
}

function toPlace(key: string, data: BigDataCloudResponse): Place | null {
  const locality = clean(data.locality);
  const city = clean(data.city);
  const region = clean(data.principalSubdivision);
  const country = clean(data.countryName);

  // Most specific usable name wins; anything is better than raw coordinates.
  const primary = locality ?? city ?? region ?? country;
  if (!primary) return null;

  // Add one broader term for context, skipping any that just repeats the name.
  const context = [city, region, country].find((c) => c && c !== primary) ?? null;

  return {
    key,
    name: context ? `${primary}, ${context}` : primary,
    locality: locality ?? city,
    region,
    country,
  };
}

function clean(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
