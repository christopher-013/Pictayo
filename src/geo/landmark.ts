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
const BATCH_SIZE = 5;

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
  /** The venue's own mapped position, not the photo cluster centroid. */
  lat: number;
  lon: number;
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
/**
 * Dining guesses need to stay close to the recorded point while allowing for
 * the drift commonly seen in indoor phone GPS.
 *
 * Ten metres was too strict for photos taken inside Kappei Sushi; its mapped
 * point sits about 20 m from the photo cluster. Thirty metres covers that
 * normal drift without returning to the overly broad original 120 m search.
 */
const DINING_RADIUS_M = 30;
/** Empty/partial results are retried because map data and transiently empty
 * Overpass responses must not turn into permanent generic ward labels. */
const INCOMPLETE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const COMPLETE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DINING_AMENITIES = new Set(['restaurant', 'cafe', 'fast_food', 'food_court']);

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
  // Named districts are often the most useful answer for street photography.
  // Keep them below specific attractions for enclosing-area matches, then let
  // the nearby scorer weigh their broad context against smaller venues.
  { key: 'place', values: new Set(['quarter', 'neighbourhood', 'suburb']) },
  { key: 'railway', values: new Set(['station']) },
  { key: 'building', values: new Set(['stadium', 'train_station', 'cathedral', 'temple', 'castle']) },
  { key: 'landuse', values: new Set(['commercial', 'retail']) },
];

/**
 * Builds the focused nearby-landmark lookup for one point.
 *
 * Keep the requested values derived from `LANDMARK_RULES`. The old query only
 * requested a hand-maintained subset of tag keys, so `pickNearest` knew how to
 * recognize `amenity=place_of_worship` and `building=temple` but Overpass never
 * sent those features to it. That is why photos inside Sensō-ji could fall back
 * to "Taito, Tokyo" when the enclosing building outline itself had no name.
 * Value filters also avoid downloading every named amenity in a dense city.
 */
export function nearbyLandmarkQuery(point: GeoPoint): string {
  const selectors = LANDMARK_RULES.map(({ key, values }) => {
    const pattern = [...values].join('|');
    return (
      `nwr(around:${NEARBY_RADIUS_M},${point.lat},${point.lon})` +
      `["${key}"~"^(${pattern})$"][name];`
    );
  }).join('');

  return `(${selectors});`;
}

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

/**
 * Roughly metre-level precision. The dining radius is only 30 m, so the old
 * three-decimal (~110 m) cache key could reuse a venue found for a materially
 * different point.
 */
export function landmarkCacheKey(lat: number, lon: number): string {
  return `${lat.toFixed(5)},${lon.toFixed(5)}`;
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
    lat: cached.diningLat ?? lat,
    lon: cached.diningLon ?? lon,
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
      const cached = await getCachedLandmark(key).catch(() => undefined);
      if (cached && isFreshCacheEntry(cached)) {
        resolved.set(key, {
          landmark: cached.name
            ? { name: cached.name, kind: cached.kind, near: cached.near === true }
            : null,
          dining: cached.diningName
            ? {
                name: cached.diningName,
                kind: cached.diningKind ?? '',
                distanceMeters: cached.diningDistanceMeters ?? 0,
                lat: cached.diningLat ?? point.lat,
                lon: cached.diningLon ?? point.lon,
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
    const dining = (point: GeoPoint) =>
      `nwr(around:${DINING_RADIUS_M},${point.lat},${point.lon})` +
      '["amenity"~"^(restaurant|cafe|fast_food|food_court)$"][name];';

    const overpassQl =
      '[out:json][timeout:90];' +
      batch
        .map(
          ({ point }) =>
            `is_in(${point.lat},${point.lon})->.s;(way(pivot.s);rel(pivot.s););out tags;out count;` +
            `${nearbyLandmarkQuery(point)}out tags center;out count;` +
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
        diningLat: dining?.lat,
        diningLon: dining?.lon,
        checkedAt: Date.now(),
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

/**
 * Successful map matches are stable, while misses need a short retry window.
 * Records created before timestamps were introduced are intentionally stale.
 */
export function isFreshCacheEntry(
  cached: { name: string; diningName?: string; checkedAt?: number },
  now = Date.now(),
): boolean {
  if (!cached.checkedAt) return false;
  const complete = Boolean(cached.name && cached.diningName);
  const ttl = complete ? COMPLETE_CACHE_TTL_MS : INCOMPLETE_CACHE_TTL_MS;
  return now - cached.checkedAt < ttl;
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

    best = {
      name,
      kind,
      distanceMeters: Math.max(0, Math.round(distance)),
      lat: position.lat,
      lon: position.lon,
    };
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
 * Ranked by feature significance, documented notability and distance, unlike
 * the strict specificity order used by {@link pickLandmark}. The question here
 * is "what useful place name describes this photo?" — not simply which mapped
 * object has the closest centre.
 */
export function pickNearest(
  elements: OverpassElement[],
  from: GeoPoint,
  radiusMeters = NEARBY_RADIUS_M,
): Landmark | null {
  let best: { landmark: Landmark; score: number; distance: number } | null = null;

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

    const rule: LandmarkRule = LANDMARK_RULES[rank]!;
    const value = tags[rule.key]!;
    const score = nearbyLandmarkScore(tags, rule.key, value, distance, radiusMeters);

    // Prefer cultural significance and geographic context, then proximity.
    //
    // Ranking purely by distance gets this wrong in a way that matters: at
    // teamLab Planets the closest qualifying feature is a station entrance 40m
    // away, while the museum itself is 117m off — so "close to Shin-toyosu"
    // beat "close to teamLab Planets". Station entrances, memorials and the
    // like are everywhere; what someone photographed is almost never the
    // nearest mapped thing, it is the most notable one nearby.
    if (best && (score < best.score || (score === best.score && distance >= best.distance))) continue;

    best = {
      landmark: { name, kind: `${rule.key}=${value}`, near: true },
      score,
      distance,
    };
  }

  return best?.landmark ?? null;
}

/**
 * Scores a nearby feature by how useful it is as a human-readable photo
 * location. A mapped gallery or station can be physically closer than the
 * district somebody would actually name; conversely, a major museum or temple
 * should still beat the surrounding neighbourhood.
 *
 * Wikipedia/Wikidata tags are a practical, language-neutral indication that a
 * feature is independently notable. District centres receive a smaller
 * distance penalty because their mapped centre is arbitrary even when the
 * photograph is clearly inside the district.
 */
function nearbyLandmarkScore(
  tags: Record<string, string>,
  key: string,
  value: string,
  distance: number,
  radiusMeters: number,
): number {
  const baseByKey: Record<string, number> = {
    aeroway: 105,
    tourism: 90,
    historic: 85,
    leisure: 80,
    amenity: 75,
    shop: 60,
    man_made: 75,
    natural: 85,
    place: 80,
    railway: 45,
    building: 80,
    landuse: 40,
  };

  let base = baseByKey[key] ?? 0;

  if (key === 'tourism') {
    if (['attraction', 'theme_park', 'zoo', 'aquarium', 'museum'].includes(value)) base = 120;
    else if (value === 'viewpoint') base = 85;
    else if (value === 'gallery') base = 55;
  } else if (key === 'amenity' && value === 'place_of_worship') {
    base = 100;
  } else if (key === 'place') {
    base = value === 'quarter' ? 85 : value === 'neighbourhood' ? 80 : 75;
  } else if (key === 'historic' && value === 'memorial') {
    base = 60;
  }

  const documentedNotability = tags.wikipedia || tags.wikidata ? 15 : 0;
  const maximumDistancePenalty = key === 'place' ? 8 : 25;
  const distancePenalty = Math.min(1, distance / Math.max(1, radiusMeters)) * maximumDistancePenalty;
  return base + documentedNotability - distancePenalty;
}

/** Equirectangular approximation — ample over a couple of hundred metres. */
function roughDistanceMeters(a: GeoPoint, b: GeoPoint): number {
  const meanLat = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const dLat = (b.lat - a.lat) * 111_320;
  const dLon = (b.lon - a.lon) * 111_320 * Math.cos(meanLat);
  return Math.hypot(dLat, dLon);
}
