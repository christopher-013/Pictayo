import { getCachedLandmark, putCachedLandmark } from '../store/db';

/**
 * Names the landmark a photo was taken *inside*.
 *
 * Reverse geocoding answers "which administrative area is this?" — Bunkyo-ku,
 * Tokyo. That is true but rarely what the photo is of. A photo shot in the
 * stands at a baseball game should say Tokyo Dome.
 *
 * Nearest-POI lookup is the obvious approach and it is wrong: asked about the
 * middle of Tokyo Dome it returns an unnamed restaurant, and about a street in
 * Takadanobaba it returns a pharmacy. It finds whatever tiny thing is closest,
 * not the thing you are standing in.
 *
 * Overpass `is_in` asks the right question — which mapped areas *contain* this
 * point — and returns the stadium, the airport, the park. The rest of this
 * module is about picking the interesting one out of that list and being a
 * well-behaved client of a free service.
 */

/**
 * Public Overpass instances, tried in order.
 *
 * The main one is genuinely unreliable under load — testing drew a 429 and a
 * 504 within a few minutes, while an identical query moments later succeeded.
 * These failures are transient, so a single endpoint with no retry gives up on
 * landmarks that were perfectly findable. Rotating through the community
 * mirrors turns a flaky lookup into a dependable one.
 */
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const REQUEST_TIMEOUT_MS = 25_000;

/** Pause before trying the next mirror. */
const RETRY_BACKOFF_MS = 1500;

/**
 * Overpass rate-limits hard — two requests a second apart already earned a 429
 * while testing. Lookups are per place cluster, so even a long trip is a few
 * dozen, and a generous gap costs nothing that matters.
 */
const MIN_REQUEST_SPACING_MS = 2000;

/**
 * Give up for the session after this many *places* fail on every mirror. Counts
 * places rather than requests, so one bad response no longer ends the feature.
 */
const FAILURE_LIMIT = 3;

export interface Landmark {
  name: string;
  /** The OSM tag that matched, e.g. "leisure=stadium". Useful for debugging. */
  kind: string;
}

export interface LandmarkFinder {
  find(lat: number, lon: number): Promise<Landmark | null>;
}

/**
 * Feature classes worth naming, most specific first.
 *
 * Order is priority: a point inside Tokyo Dome is also inside "Tokyo Dome City"
 * (landuse=commercial), and the stadium is the better answer. Administrative
 * boundaries are deliberately absent — country, prefecture, ward and the rest
 * all contain the point too, and reverse geocoding already covers them.
 */
const LANDMARK_RULES: ReadonlyArray<{ key: string; values: ReadonlySet<string> }> = [
  { key: 'aeroway', values: new Set(['aerodrome', 'terminal']) },
  { key: 'tourism', values: new Set(['attraction', 'theme_park', 'zoo', 'aquarium', 'museum', 'gallery', 'viewpoint']) },
  { key: 'historic', values: new Set(['castle', 'monument', 'memorial', 'ruins', 'archaeological_site', 'fort']) },
  { key: 'leisure', values: new Set(['stadium', 'theme_park', 'water_park', 'sports_centre', 'garden', 'park', 'nature_reserve', 'marina']) },
  { key: 'amenity', values: new Set(['university', 'college', 'theatre', 'arts_centre', 'place_of_worship', 'marketplace', 'library', 'hospital']) },
  { key: 'shop', values: new Set(['mall', 'department_store']) },
  { key: 'man_made', values: new Set(['tower', 'lighthouse', 'pier', 'bridge']) },
  { key: 'natural', values: new Set(['beach', 'peak', 'volcano', 'cave_entrance']) },
  { key: 'railway', values: new Set(['station']) },
  { key: 'building', values: new Set(['stadium', 'train_station', 'cathedral', 'temple', 'castle']) },
  { key: 'landuse', values: new Set(['commercial', 'retail']) },
];

interface OverpassElement {
  tags?: Record<string, string>;
}

/** ~110m, matching the reverse-geocode cache so the two stay in step. */
export function landmarkCacheKey(lat: number, lon: number): string {
  return `${lat.toFixed(3)},${lon.toFixed(3)}`;
}

/**
 * Cache-only read, used while assembling the library.
 *
 * Building the timeline must never wait on the network, so this returns what
 * is already known and nothing more. The background pass fills the cache, then
 * the library is rebuilt and picks the names up from here.
 */
export async function cachedLandmarkName(lat: number, lon: number): Promise<string | null> {
  const cached = await getCachedLandmark(landmarkCacheKey(lat, lon)).catch(() => undefined);
  return cached?.name ? cached.name : null;
}

export class OverpassLandmarkFinder implements LandmarkFinder {
  private queue: Promise<unknown> = Promise.resolve();
  private consecutiveFailures = 0;
  private endpointIndex = 0;

  async find(lat: number, lon: number): Promise<Landmark | null> {
    const key = landmarkCacheKey(lat, lon);

    // A cached miss is stored as an empty name, so a place with no landmark is
    // only ever asked about once.
    const cached = await getCachedLandmark(key).catch(() => undefined);
    if (cached) return cached.name ? { name: cached.name, kind: cached.kind } : null;

    if (this.consecutiveFailures >= FAILURE_LIMIT) return null;

    return this.enqueue(() => this.query(key, lat, lon));
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    this.queue = result
      .catch(() => undefined)
      .then(() => new Promise((r) => setTimeout(r, MIN_REQUEST_SPACING_MS)));
    return result;
  }

  private async query(key: string, lat: number, lon: number): Promise<Landmark | null> {
    // `pivot` turns each enclosing area back into the way or relation it came
    // from, so the original tags come back with it.
    const overpassQl =
      `[out:json][timeout:20];is_in(${lat},${lon})->.a;` +
      'way(pivot.a);out tags;relation(pivot.a);out tags;';

    const elements = await this.fetchWithFallback(overpassQl);

    if (!elements) {
      this.consecutiveFailures += 1;
      // Nothing cached on failure: this place is worth asking about again.
      return null;
    }

    this.consecutiveFailures = 0;

    const landmark = pickLandmark(elements);

    // A miss is cached too, as an empty name, so a place with genuinely no
    // landmark is only ever asked about once.
    await putCachedLandmark({
      key,
      name: landmark?.name ?? '',
      kind: landmark?.kind ?? '',
    }).catch(() => undefined);

    return landmark;
  }

  /** Walks the mirrors until one answers, starting from the last that worked. */
  private async fetchWithFallback(overpassQl: string): Promise<OverpassElement[] | null> {
    for (let attempt = 0; attempt < ENDPOINTS.length; attempt++) {
      const endpoint = ENDPOINTS[(this.endpointIndex + attempt) % ENDPOINTS.length]!;

      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          body: `data=${encodeURIComponent(overpassQl)}`,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          referrerPolicy: 'strict-origin-when-cross-origin',
          credentials: 'omit',
        });

        if (response.ok) {
          // Stay on whatever answered, rather than going back to a busy one.
          this.endpointIndex = (this.endpointIndex + attempt) % ENDPOINTS.length;
          const data = (await response.json()) as { elements?: OverpassElement[] };
          return data.elements ?? [];
        }
      } catch {
        // Timeout or network error — fall through to the next mirror.
      }

      if (attempt < ENDPOINTS.length - 1) {
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
      }
    }

    return null;
  }
}

/** Picks the most specific interesting feature out of everything enclosing a point. */
export function pickLandmark(elements: OverpassElement[]): Landmark | null {
  for (const rule of LANDMARK_RULES) {
    for (const element of elements) {
      const tags = element.tags;
      if (!tags) continue;

      const value = tags[rule.key];
      if (!value || !rule.values.has(value)) continue;

      // Prefer the English name where the map carries one, so a Japanese
      // stadium reads as "Tokyo Dome" rather than "東京ドーム".
      const name = (tags['name:en'] ?? tags.name ?? '').trim();
      if (!name) continue;

      return { name, kind: `${rule.key}=${value}` };
    }
  }

  return null;
}
