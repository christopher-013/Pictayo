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
 * How many places go into one request.
 *
 * Overpass accepts many `is_in` lookups in a single query, and `out count`
 * between them delimits the results — so a whole trip usually needs one round
 * trip instead of one per place. Measured at ~1.9s for three places, which is
 * why this batches rather than throttling a queue of individual calls.
 *
 * Capped so a very large library still sends bounded queries.
 */
const BATCH_SIZE = 20;

/** Courtesy gap between batches, which most imports never reach. */
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

export interface GeoPoint {
  lat: number;
  lon: number;
}

export interface LandmarkFinder {
  /** Resolves many points at once, keyed by {@link landmarkCacheKey}. */
  findMany(points: GeoPoint[]): Promise<Map<string, Landmark | null>>;
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
  type?: string;
  tags?: Record<string, string>;
}

/**
 * Splits a batched response back into one group per requested point, using the
 * `count` elements emitted between them as separators.
 */
export function splitOnCountMarkers(elements: OverpassElement[]): OverpassElement[][] {
  const groups: OverpassElement[][] = [[]];

  for (const element of elements) {
    if (element.type === 'count') groups.push([]);
    else groups[groups.length - 1]!.push(element);
  }

  return groups;
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
  private consecutiveFailures = 0;
  private endpointIndex = 0;

  async findMany(points: GeoPoint[]): Promise<Map<string, Landmark | null>> {
    const resolved = new Map<string, Landmark | null>();

    // Collapse duplicates first: several clusters can round to the same key.
    const wanted = new Map<string, GeoPoint>();
    for (const point of points) {
      wanted.set(landmarkCacheKey(point.lat, point.lon), point);
    }

    const misses: Array<{ key: string; point: GeoPoint }> = [];

    for (const [key, point] of wanted) {
      // A cached miss is stored as an empty name, so a place with no landmark
      // is only ever asked about once.
      const cached = await getCachedLandmark(key).catch(() => undefined);
      if (cached) resolved.set(key, cached.name ? { name: cached.name, kind: cached.kind } : null);
      else misses.push({ key, point });
    }

    for (let start = 0; start < misses.length; start += BATCH_SIZE) {
      if (this.consecutiveFailures >= FAILURE_LIMIT) break;

      if (start > 0) await new Promise((r) => setTimeout(r, MIN_REQUEST_SPACING_MS));

      const batch = misses.slice(start, start + BATCH_SIZE);
      for (const [key, landmark] of await this.queryBatch(batch)) resolved.set(key, landmark);
    }

    return resolved;
  }

  private async queryBatch(
    batch: Array<{ key: string; point: GeoPoint }>,
  ): Promise<Map<string, Landmark | null>> {
    const results = new Map<string, Landmark | null>();

    // `pivot` turns each enclosing area back into the way or relation it came
    // from, so the original tags come back with it. `out count` after each
    // lookup emits a marker element, which is what makes the groups separable.
    const overpassQl =
      '[out:json][timeout:60];' +
      batch
        .map(
          ({ point }) =>
            `is_in(${point.lat},${point.lon})->.s;(way(pivot.s);rel(pivot.s););out tags;out count;`,
        )
        .join('');

    const elements = await this.fetchWithFallback(overpassQl);

    if (!elements) {
      this.consecutiveFailures += 1;
      // Nothing cached on failure: these places are worth asking about again.
      return results;
    }

    this.consecutiveFailures = 0;

    const groups = splitOnCountMarkers(elements);

    for (const [index, { key }] of batch.entries()) {
      const landmark = pickLandmark(groups[index] ?? []);
      results.set(key, landmark);

      await putCachedLandmark({
        key,
        name: landmark?.name ?? '',
        kind: landmark?.kind ?? '',
      }).catch(() => undefined);
    }

    return results;
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
