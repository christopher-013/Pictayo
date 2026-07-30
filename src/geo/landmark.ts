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
  /**
   * False when the point sits inside the landmark's mapped outline, true when
   * it was merely the nearest one. Drives "at Tokyo Dome" versus "close to
   * teamLab Planets" — the app should never claim you were inside somewhere it
   * only guessed at.
   */
  near: boolean;
}

export interface NearbyDining {
  name: string;
  /** OSM amenity value, such as "restaurant" or "cafe". */
  kind: string;
  /** Approximate distance from the photo cluster centroid. */
  distanceMeters: number;
}

export interface LocationEnrichment {
  landmark: Landmark | null;
  dining: NearbyDining | null;
}

/**
 * How far away a point of interest can be and still be worth naming.
 *
 * Small enough that the guess stays credible in a dense city, generous enough
 * to absorb the GPS drift you get indoors — which is exactly the situation
 * where this fallback matters.
 */
const NEARBY_RADIUS_M = 220;
/** Kept tighter than landmarks so a food suggestion remains credible. */
const DINING_RADIUS_M = 120;
const DINING_AMENITIES = new Set(['restaurant', 'cafe', 'fast_food', 'food_court']);

/**
 * Tags searched for nearby landmarks.
 *
 * Narrower than the enclosing-area rules on purpose. A 220m circle in central
 * Tokyo contains hundreds of shops and restaurants, and pulling them all back
 * for every place would be slow and pointless — none of them would survive the
 * filter anyway.
 */
const NEARBY_KEYS = ['tourism', 'leisure', 'historic', 'aeroway', 'man_made', 'railway'];

export interface GeoPoint {
  lat: number;
  lon: number;
}

export interface LandmarkFinder {
  /** Resolves many points at once, keyed by {@link landmarkCacheKey}. */
  findMany(points: GeoPoint[]): Promise<Map<string, LocationEnrichment>>;
}

/**
 * Feature classes worth naming, most specific first.
 *
 * Order is priority: a point inside Tokyo Dome is also inside "Tokyo Dome City"
 * (landuse=commercial), and the stadium is the better answer. Administrative
 * boundaries are deliberately absent — country, prefecture, ward and the rest
 * all contain the point too, and reverse geocoding already covers them.
 */
interface LandmarkRule {
  key: string;
  values: ReadonlySet<string>;
}

const LANDMARK_RULES: readonly LandmarkRule[] = [
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
  /** Nodes carry their position directly… */
  lat?: number;
  lon?: number;
  /** …while `out center` gives ways and relations a representative point. */
  center?: { lat?: number; lon?: number };
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
export async function cachedLandmark(lat: number, lon: number): Promise<Landmark | null> {
  const cached = await getCachedLandmark(landmarkCacheKey(lat, lon)).catch(() => undefined);
  if (!cached?.name) return null;
  return { name: cached.name, kind: cached.kind, near: cached.near === true };
}

export async function cachedDining(lat: number, lon: number): Promise<NearbyDining | null> {
  const cached = await getCachedLandmark(landmarkCacheKey(lat, lon)).catch(() => undefined);
  if (!cached?.diningName) return null;
  return {
    name: cached.diningName,
    kind: cached.diningKind ?? '',
    distanceMeters: cached.diningDistanceMeters ?? 0,
  };
}

export class OverpassLandmarkFinder implements LandmarkFinder {
  private consecutiveFailures = 0;
  private endpointIndex = 0;

  async findMany(points: GeoPoint[]): Promise<Map<string, LocationEnrichment>> {
    const resolved = new Map<string, LocationEnrichment>();

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
      if (cached) {
        resolved.set(key, {
          landmark: cached.name
            ? { name: cached.name, kind: cached.kind, near: cached.near === true }
            : null,
          dining: cached.diningName
            ? {
                name: cached.diningName,
                kind: cached.diningKind ?? '',
                distanceMeters: cached.diningDistanceMeters ?? 0,
              }
            : null,
        });
      } else {
        misses.push({ key, point });
      }
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
  ): Promise<Map<string, LocationEnrichment>> {
    const results = new Map<string, LocationEnrichment>();

    // Three lookups per point, in one request.
    //
    // `is_in` finds areas the point sits inside — but it can only ever find
    // *areas*. Plenty of landmarks are mapped as a single node with no
    // footprint (teamLab Planets is `tourism=museum` on a node), and those are
    // structurally invisible to it. The first `around` pass catches them, and
    // its result is marked as a guess rather than a claim. The final pass finds
    // the nearest named place to eat within a deliberately tight radius.
    //
    // `pivot` turns each enclosing area back into the way or relation it came
    // from, so the original tags come back with it. `out count` after each
    // lookup emits a marker element, which is what makes the groups separable.
    // A union of plain `[key][name]` filters, one per tag of interest.
    //
    // The compact key-regex form — `[~"^(tourism|leisure|…)$"~"."]` — is valid
    // Overpass QL but is rejected outright by the main instance with a 406, so
    // it is not usable in practice. This spells the same thing out longhand
    // using only syntax the servers actually accept.
    const nearby = (point: GeoPoint) =>
      '(' +
      NEARBY_KEYS.map(
        (key) => `nwr(around:${NEARBY_RADIUS_M},${point.lat},${point.lon})[${key}][name];`,
      ).join('') +
      ');';

    const dining = (point: GeoPoint) =>
      `nwr(around:${DINING_RADIUS_M},${point.lat},${point.lon})` +
      '["amenity"~"^(restaurant|cafe|fast_food|food_court)$"][name];';

    const overpassQl =
      '[out:json][timeout:90];' +
      batch
        .map(
          ({ point }) =>
            `is_in(${point.lat},${point.lon})->.s;(way(pivot.s);rel(pivot.s););out tags;out count;` +
            `${nearby(point)}out tags center;out count;` +
            `${dining(point)}out tags center;out count;`,
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

    for (const [index, { key, point }] of batch.entries()) {
      // Three groups per point, in the order the query emitted them.
      const enclosing = groups[index * 3] ?? [];
      const nearby = groups[index * 3 + 1] ?? [];
      const diningCandidates = groups[index * 3 + 2] ?? [];

      // Being inside somewhere always beats being near it.
      const landmark = pickLandmark(enclosing) ?? pickNearest(nearby, point);
      const dining = pickNearbyDining(diningCandidates, point);
      results.set(key, { landmark, dining });

      await putCachedLandmark({
        key,
        name: landmark?.name ?? '',
        kind: landmark?.kind ?? '',
        near: landmark?.near ?? false,
        diningName: dining?.name ?? '',
        diningKind: dining?.kind ?? '',
        diningDistanceMeters: dining?.distanceMeters ?? 0,
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

/** Picks the nearest named food venue inside the deliberately small radius. */
export function pickNearbyDining(
  elements: OverpassElement[],
  from: GeoPoint,
  radiusMeters = DINING_RADIUS_M,
): NearbyDining | null {
  let best: NearbyDining | null = null;

  for (const element of elements) {
    const tags = element.tags;
    const kind = tags?.amenity;
    if (!tags || !kind || !DINING_AMENITIES.has(kind)) continue;

    const name = (tags['name:en'] ?? tags.name ?? '').trim();
    if (!name) continue;

    const position = element.center ?? { lat: element.lat, lon: element.lon };
    if (typeof position.lat !== 'number' || typeof position.lon !== 'number') continue;

    const distance = roughDistanceMeters(from, { lat: position.lat, lon: position.lon });
    if (distance > radiusMeters || (best && distance >= best.distanceMeters)) continue;

    best = { name, kind, distanceMeters: Math.max(0, Math.round(distance)) };
  }

  return best;
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

      return { name, kind: `${rule.key}=${value}`, near: false };
    }
  }

  return null;
}

/**
 * Nearest notable place to a point, for when nothing encloses it.
 *
 * Ranked by distance rather than by category, unlike {@link pickLandmark}. The
 * question here is "what is this photo near?", and the nearest thing that
 * cleared the notability filter is the honest answer — the filter has already
 * thrown out the shops and restaurants that made naive nearest-POI lookup
 * useless.
 */
export function pickNearest(
  elements: OverpassElement[],
  from: GeoPoint,
  radiusMeters = NEARBY_RADIUS_M,
): Landmark | null {
  let best: { landmark: Landmark; rank: number; distance: number } | null = null;

  for (const element of elements) {
    const tags = element.tags;
    if (!tags) continue;

    const position = element.center ?? { lat: element.lat, lon: element.lon };
    if (typeof position.lat !== 'number' || typeof position.lon !== 'number') continue;

    const distance = roughDistanceMeters(from, { lat: position.lat, lon: position.lon });
    if (distance > radiusMeters) continue;

    const rank = LANDMARK_RULES.findIndex(
      (candidate) => tags[candidate.key] && candidate.values.has(tags[candidate.key]!),
    );
    if (rank < 0) continue;

    const name = (tags['name:en'] ?? tags.name ?? '').trim();
    if (!name) continue;

    // Category first, distance only as a tie-break.
    //
    // Ranking purely by distance gets this wrong in a way that matters: at
    // teamLab Planets the closest qualifying feature is a station entrance 40m
    // away, while the museum itself is 117m off — so "close to Shin-toyosu"
    // beat "close to teamLab Planets". Station entrances, memorials and the
    // like are everywhere; what someone photographed is almost never the
    // nearest mapped thing, it is the most notable one nearby.
    if (best && (rank > best.rank || (rank === best.rank && distance >= best.distance))) continue;

    const rule: LandmarkRule = LANDMARK_RULES[rank]!;
    best = {
      landmark: { name, kind: `${rule.key}=${tags[rule.key]}`, near: true },
      rank,
      distance,
    };
  }

  return best?.landmark ?? null;
}

/** Equirectangular approximation — ample over a couple of hundred metres. */
function roughDistanceMeters(a: GeoPoint, b: GeoPoint): number {
  const meanLat = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const dLat = (b.lat - a.lat) * 111_320;
  const dLon = (b.lon - a.lon) * 111_320 * Math.cos(meanLat);
  return Math.hypot(dLat, dLon);
}
