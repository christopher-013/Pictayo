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
 * Overpass accepts many lookups in a single query, and `out count` between them
 * delimits the results — so a trip usually needs one round trip rather than one
 * per place.
 *
 * This had to sit at five while the nearby lookup ran twelve filtered scans per
 * point, because six points was already enough to draw a 504. With a single
 * scan per point (see `nearbyLandmarkQuery`) the same six points answer in
 * 3.7s, so a larger batch trades a slightly longer request for materially fewer
 * round trips and fewer courtesy gaps: thirty places go from six batches to
 * three. Still capped so a very large library sends bounded queries.
 */
const BATCH_SIZE = 10;

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
const NOTABLE_PLACE_RADIUS_M = 350;
const WIKIPEDIA_ENDPOINT = 'https://en.wikipedia.org/w/api.php';
const WIKIPEDIA_TIMEOUT_MS = 8_000;

/**
 * How many extra times a batch is re-sent when Overpass does not answer.
 *
 * Overpass is the accurate source; Wikipedia is a guess about what is famous
 * nearby. Falling back the moment a request fails let a transient 429 or 504
 * put a guess on the card and into the cache. Each attempt already walks every
 * mirror, so this multiplies that: a batch gets three full passes over the
 * mirror list before Pictayo settles for the guess.
 *
 * Bounded rather than unlimited, because a name now beats an unnamed place
 * forever — the retries buy accuracy a fair chance, they do not insist on it.
 */
/**
 * The resource budget declared on every Overpass query.
 *
 * Overpass rejects a request unless it fits in about half of what the server
 * currently has free, and a query that declares no `maxsize` is charged the
 * full 512 MiB default. That is what produced the HTTP 504s: not a busy
 * server, but a query reserving half a gigabyte to read a few hundred metres
 * of map. The server waits 15 s to see whether resources free up before
 * refusing, which is why the failures were slow as well as frequent.
 *
 * Measured against overpass-api.de within the same minute, this ten-point
 * batch: `[timeout:90]` alone was refused with a 504 after 13 s, while adding
 * a `maxsize` returned all 4,449 elements. Every value from 2 Mi to 16 Mi
 * returned byte-identical results, so the real footprint is well under the
 * smallest of them; 8 Mi keeps generous headroom for a dense city and is still
 * sixty-four times smaller than the default.
 *
 * The timeout is the other half of the estimate. Ninety seconds was far more
 * than this query has ever needed — the slowest observed run is 17 s — and
 * asking for less makes acceptance likelier.
 *
 * See https://dev.overpass-api.de/overpass-doc/en/preface/commons.html
 */
export const QUERY_BUDGET = '[out:json][timeout:60][maxsize:8Mi];';

const OVERPASS_RETRY_LIMIT = 2;

/**
 * Total time the retries above may consume before the guess is allowed in.
 *
 * The retry count alone assumes failures are cheap. They are not: a busy
 * Overpass mirror answers 504 after about nine seconds rather than refusing
 * immediately, so three passes over three mirrors can take a minute and a half
 * — a long time to sit looking at raw coordinates.
 *
 * The first pass always runs, preserving the original behaviour; further passes
 * only start while there is budget left. Retries therefore happen when failure
 * is fast and cheap, and are skipped when the network is merely slow.
 */
const OVERPASS_RETRY_BUDGET_MS = 20_000;

/**
 * Ceiling on how much sheer popularity can contribute to a Wikipedia guess.
 *
 * Fame is evidence that a subject is recognizable, not that it is the place
 * the photo was taken. Uncapped, an article read a hundred thousand times a
 * month outscored every closer candidate no matter how far away it sat, so the
 * most-read article within 350 m effectively always won. Capping it keeps
 * distance meaningful: the cap is worth about as much as 145 m of separation.
 */
const MAX_FAME_SCORE = 50;
const FAME_PER_DECADE = 12;
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
  // `ferry_terminal` earns its place from a real photo: standing on the pier at
  // Hakone-machi with the Queen Ashinoko tied up alongside, the terminal one
  // metre away was invisible and the caption read "Near Hakone Ekiden museum",
  // a relay-race museum 75 m inland.
  { key: 'amenity', values: new Set(['university', 'college', 'theatre', 'arts_centre', 'place_of_worship', 'marketplace', 'library', 'hospital', 'ferry_terminal']) },
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
 * Fetches everything named around a point, in one spatial scan.
 *
 * The obvious query asks Overpass for exactly the tags `LANDMARK_RULES` cares
 * about — one `around` selector per key. That turned out to be both slower and
 * more fragile than fetching the neighbourhood wholesale:
 *
 *  - **Slower.** Twelve filtered scans per point make Overpass intersect a
 *    spatial index with a tag index twelve times. Measured over six points, the
 *    filtered form took 22.1s and this one 3.7s — six times quicker — and the
 *    filtered form outright timed out with 504s as the batch grew, which is why
 *    batches had to stay small. The saving is worth the larger response, since
 *    each place is looked up once and then cached.
 *
 *  - **More fragile.** The query and the scorer had to be kept in step by hand,
 *    and drifted: `pickNearest` recognised `amenity=place_of_worship` while the
 *    query never asked for it, so photos inside Sensō-ji fell back to "Taito,
 *    Tokyo". Fetching everything named and filtering in `pickNearest` makes that
 *    class of bug impossible — the rules are applied in exactly one place.
 *
 * Verified to pick identical landmarks to the filtered query across six test
 * locations, including the dense-street and node-mapped cases.
 *
 * Nodes and ways only. Relations are the expensive part of an `around` scan:
 * Overpass has to assemble each one's member geometry before it can decide
 * whether it falls inside the radius. Dropping them took the same sixteen-point
 * request from 24.5s to 8.8s, and a six-point one from 8.7s to 2.9s.
 *
 * Nothing is lost in practice, because the two lookups divide the work: a
 * relation that *contains* the photo still arrives through `is_in`, which
 * pivots on relations explicitly. The `around` scan only has to answer "what is
 * near here", and a landmark you are merely standing next to is essentially
 * always mapped as a node or a closed way. Checked across sixteen locations
 * chosen to stress this — Ueno Park, Yoyogi Park, Shinjuku Gyoen, the Imperial
 * Palace, Meiji Jingu — every pick was identical, dining included, though 621
 * relations had been fetched and scored under the old form.
 */
export function nearbyLandmarkQuery(point: GeoPoint): string {
  return `nw(around:${NEARBY_RADIUS_M},${point.lat},${point.lon})[name];`;
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

    // Two lookups per point, in one request.
    //
    // `is_in` finds areas the point sits inside — but it can only ever find
    // *areas*. Plenty of landmarks are mapped as a single node with no
    // footprint (teamLab Planets is `tourism=museum` on a node), and those are
    // structurally invisible to it. The `around` pass catches them, and its
    // result is marked as a guess rather than a claim.
    //
    // Nearby dining comes out of that same `around` result rather than a scan
    // of its own: it looks within 30m, the neighbourhood fetch already covers
    // 220m, so a third spatial query would only re-read a subset of what is
    // already in hand.
    //
    // `pivot` turns each enclosing area back into the way or relation it came
    // from, so the original tags come back with it. `out count` after each
    // lookup emits a marker element, which is what makes the groups separable.
    const overpassQl =
      QUERY_BUDGET +
      batch
        .map(
          ({ point }) =>
            `is_in(${point.lat},${point.lon})->.s;(way(pivot.s);rel(pivot.s););out tags;out count;` +
            `${nearbyLandmarkQuery(point)}out tags center;out count;`,
        )
        .join('');

    // Give the accurate source its retries before settling for a guess. Each
    // pass walks every mirror, so a batch only reaches Wikipedia after Overpass
    // has failed on all of them, repeatedly.
    //
    // Only the first failure is worth pressing on: once a batch has already
    // exhausted its retries, Overpass is down rather than briefly busy, and
    // making every later batch relearn that would add minutes to a large
    // import for an answer that is not coming.
    const retries = this.consecutiveFailures === 0 ? OVERPASS_RETRY_LIMIT : 0;
    const retryDeadline = Date.now() + OVERPASS_RETRY_BUDGET_MS;
    let elements: OverpassElement[] | null = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) {
        if (Date.now() >= retryDeadline) break;
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
      }
      elements = await this.fetchWithFallback(overpassQl);
      if (elements) break;
    }

    const overpassAnswered = elements !== null;
    if (!overpassAnswered) this.consecutiveFailures += 1;
    else this.consecutiveFailures = 0;

    const groups = splitOnCountMarkers(elements ?? []);
    const preliminary = batch.map(({ point }, index) => {
      // Two groups per point, in the order the query emitted them.
      const enclosing = groups[index * 2] ?? [];
      const nearby = groups[index * 2 + 1] ?? [];
      return {
        landmark: pickBestLandmark(enclosing, nearby, point),
        // Same elements: pickNearbyDining applies its own tighter radius, and
        // consults the enclosing outlines before any of them.
        dining: pickNearbyDining(nearby, point, DINING_RADIUS_M, enclosing),
      };
    });

    // Run fallbacks concurrently so a batch adds at most one Wikipedia round
    // trip to the critical path, rather than one serial request per location.
    const notableFallbacks = await Promise.all(
      preliminary.map((item, index) =>
        item.landmark ? Promise.resolve(null) : this.findNotableWikipediaPlace(batch[index]!.point),
      ),
    );

    for (const [index, { key }] of batch.entries()) {
      const landmark = preliminary[index]!.landmark ?? notableFallbacks[index] ?? null;
      const dining = preliminary[index]!.dining;
      results.set(key, { landmark, dining });

      // Show the guess now, but do not persist it: nothing here was checked
      // against map data, and caching it would keep the fallback's answer long
      // after Overpass recovered. The next run re-resolves the point properly.
      if (!overpassAnswered) continue;

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
      let rateLimited = false;

      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          body: `data=${encodeURIComponent(overpassQl)}`,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          referrerPolicy: 'strict-origin-when-cross-origin',
          credentials: 'omit',
        });

        // 429 means this server has no slot for us. Waiting will not help, and
        // the quota is per server, so move to the next mirror immediately.
        rateLimited = response.status === 429;

        if (response.ok) {
          const data = (await response.json()) as {
            elements?: OverpassElement[];
            remark?: string;
          };

          // Overpass reports a query that ran out of memory or time as HTTP 200
          // with a `remark` and no elements. Treating that as "answered, found
          // nothing" would cache an empty result and skip the retries, so it
          // has to count as a failure.
          if (data.remark && /error|exceeded|out of memory/i.test(data.remark)) {
            continue;
          }

          // Stay on whatever answered, rather than going back to a busy one.
          this.endpointIndex = (this.endpointIndex + attempt) % ENDPOINTS.length;
          return data.elements ?? [];
        }
      } catch {
        // Timeout or network error — fall through to the next mirror.
      }

      if (!rateLimited && attempt < ENDPOINTS.length - 1) {
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
      }
    }

    return null;
  }

  /** Generic fallback ranked by nearby Wikipedia article recognition. */
  private async findNotableWikipediaPlace(point: GeoPoint): Promise<Landmark | null> {
    const params = new URLSearchParams({
      action: 'query',
      generator: 'geosearch',
      ggscoord: `${point.lat}|${point.lon}`,
      ggsradius: String(NOTABLE_PLACE_RADIUS_M),
      ggslimit: '10',
      ggsnamespace: '0',
      prop: 'coordinates|pageviews|pageterms',
      pvipdays: '30',
      wbptterms: 'description',
      format: 'json',
      formatversion: '2',
      origin: '*',
    });

    try {
      const response = await fetch(`${WIKIPEDIA_ENDPOINT}?${params}`, {
        signal: AbortSignal.timeout(WIKIPEDIA_TIMEOUT_MS),
        referrerPolicy: 'no-referrer',
        credentials: 'omit',
      });
      if (!response.ok) return null;
      const data = (await response.json()) as WikipediaNearbyResponse;
      return pickNotableWikipediaPlace(data.query?.pages ?? [], point);
    } catch {
      return null;
    }
  }
}

interface WikipediaNearbyPage {
  title?: string;
  coordinates?: Array<{ lat?: number; lon?: number }>;
  pageviews?: Record<string, number | null>;
  terms?: { description?: string[] };
}

interface WikipediaNearbyResponse {
  query?: { pages?: WikipediaNearbyPage[] };
}

/** Selects a recognizable nearby subject without city-specific rules. */
export function pickNotableWikipediaPlace(
  pages: WikipediaNearbyPage[],
  from: GeoPoint,
  radiusMeters = NOTABLE_PLACE_RADIUS_M,
): Landmark | null {
  let best: { name: string; score: number; distance: number } | null = null;

  for (const page of pages) {
    const title = page.title?.trim();
    const position = page.coordinates?.[0];
    if (!title || typeof position?.lat !== 'number' || typeof position.lon !== 'number') continue;

    const distance = roughDistanceMeters(from, { lat: position.lat, lon: position.lon });
    if (distance > radiusMeters) continue;

    const description = page.terms?.description?.[0] ?? '';
    const boost = notableDescriptionBoost(description);
    if (boost === null) continue; // Not a place, or nothing saying it is one.

    const views = Object.values(page.pageviews ?? {}).reduce<number>(
      (sum, value) => sum + (typeof value === 'number' ? value : 0),
      0,
    );
    const fame = Math.min(Math.log10(views + 1) * FAME_PER_DECADE, MAX_FAME_SCORE);
    const score = fame + boost - distance / 4;
    const name = parentPlaceName(title);

    if (best && (score < best.score || (score === best.score && distance >= best.distance))) continue;
    best = { name, score, distance };
  }

  if (!best || best.score < 25) return null;
  return { name: best.name, kind: 'wikipedia=nearby', near: best.distance > 75 };
}

/**
 * Subjects that are not somewhere a photo can be taken.
 *
 * Wikipedia geotags an event at the place it happened, so a 1936 coup attempt
 * sits on the map exactly like a museum does. "February 26 incident" is tagged
 * 218 m from Shibuya PARCO and read 11,000 times a month, which was enough to
 * beat every real venue around it and caption a photo of a Pokémon store.
 * People, works and organizations get geotagged the same way.
 */
const NON_PLACE_DESCRIPTION =
  /\b(incident|coup|rebellion|revolt|uprising|riot|battle|siege|massacre|bombing|shooting|earthquake|tsunami|typhoon|disaster|fire|crash|accident|election|treaty|protest|attack|assassination|scandal|epidemic|pandemic|tournament|championship|olympics|cup|match|race|series|season|film|movie|album|song|single|novel|manga|anime|video game|band|musician|singer|actor|actress|writer|author|painter|politician|emperor|philosopher|clan|dynasty|company|corporation|conglomerate|manufacturer|publisher|airline|broadcaster|chain|brand|store|shop|office)\b/i;

/**
 * Vocabulary that positively identifies a place, most specific tier first.
 *
 * A description has to land in one of these to be usable. The old scorer only
 * *boosted* place words and returned a neutral zero for anything it did not
 * recognize, which meant an unrecognized subject was treated as no worse than
 * an unremarkable building — so anything sufficiently famous sailed through.
 */
const PLACE_DESCRIPTION_TIERS: ReadonlyArray<{ pattern: RegExp; boost: number }> = [
  {
    pattern: /\b(temple|shrine|castle|palace|museum|stadium|market|park|monument|memorial|landmark|tourist attraction|aquarium|zoo|theme park|amusement park|cathedral|church|mosque|pagoda|observatory)\b/i,
    boost: 38,
  },
  {
    pattern: /\b(district|neighbou?rhood|quarter|town|village|ward|suburb|borough)\b/i,
    boost: 32,
  },
  {
    pattern: /\b(station|airport|bridge|tower|garden|gallery|theatre|theater|university|college|school|library|hospital|hall|arena|venue|hotel|complex|building|mall|shopping cent(?:re|er)|plaza|square|street|avenue|crossing|campus|port|harbou?r|island|mountain|lake|river|waterfall|beach|forest|cemetery|zoo)\b/i,
    boost: 18,
  },
];

/**
 * Scores how strongly a description reads as a place, or rejects it outright.
 *
 * Returns null when the subject is not a place, or when nothing in the text
 * says that it is. Refusing is the right answer here: this is a fallback, and
 * leaving a photo labelled with its reverse-geocoded city beats labelling it
 * with a confident, specific, wrong name.
 */
export function notableDescriptionBoost(description: string): number | null {
  if (!description.trim()) return null;
  if (NON_PLACE_DESCRIPTION.test(description)) return null;

  for (const tier of PLACE_DESCRIPTION_TIERS) {
    if (tier.pattern.test(description)) return tier.boost;
  }

  return null;
}

/** "Main Hall (Sensō-ji)" should describe the location as Sensō-ji. */
function parentPlaceName(title: string): string {
  const parent = title.match(/\(([^)]+)\)$/)?.[1]?.trim();
  if (!parent || /^(district|building|station|Tokyo|Japan)$/i.test(parent)) return title;
  return parent;
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

/**
 * Picks the food venue a photo was taken at.
 *
 * `enclosing` comes first and wins outright when it holds one, because being
 * inside a restaurant is not a guess the way "nearest centroid" is. Photos of
 * an Eggs'n Things breakfast in Harajuku were captioned "Burn side st café", a
 * different cafe 29 m up the street: the restaurant is mapped as a building
 * with `amenity=restaurant`, `is_in` returns it, and nothing looked. Ranking by
 * distance alone means a few metres of indoor drift hands the credit to a
 * neighbour.
 */
export function pickNearbyDining(
  elements: OverpassElement[],
  from: GeoPoint,
  radiusMeters = DINING_RADIUS_M,
  enclosing: OverpassElement[] = [],
): NearbyDining | null {
  for (const element of enclosing) {
    const tags = element.tags;
    const kind = tags?.amenity;
    if (!tags || !kind || !DINING_AMENITIES.has(kind)) continue;

    const name = (tags['name:en'] ?? tags.name ?? '').trim();
    if (!name) continue;

    // The camera is within the outline, so there is no distance to report and
    // no position to link to beyond the photo's own.
    return { name, kind, distanceMeters: 0, lat: from.lat, lon: from.lon };
  }

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

/**
 * Picks the most specific interesting feature out of everything enclosing a point.
 *
 * Districts are excluded here even though they are a landmark class, because a
 * match in this function wins outright. Standing in Odaiba is true of a very
 * large area, and it short-circuited the search: a photo of the Fuji TV sphere,
 * with the observation deck 54 m away and outscoring everything else, was
 * captioned "Daiba" because a `place=quarter` outline happened to contain the
 * camera. Districts are still used — see {@link bestEnclosingDistrict} — but
 * they have to win on score rather than by arriving first.
 */
export function pickLandmark(elements: OverpassElement[]): Landmark | null {
  for (const rule of LANDMARK_RULES) {
    if (rule.key === 'place') continue;

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
  return bestNearbyCandidate(elements, from, radiusMeters)?.landmark ?? null;
}

/**
 * The nearby winner together with its score, so other sources of a name can be
 * compared against it rather than merely ordered ahead of or behind it.
 */
function bestNearbyCandidate(
  elements: OverpassElement[],
  from: GeoPoint,
  radiusMeters = NEARBY_RADIUS_M,
): { landmark: Landmark; score: number; distance: number } | null {
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

  return best;
}

/**
 * Tags that turn a building outline into somewhere you would say you had been.
 * A bare `building=yes` is a structure; the same outline with `amenity` or
 * `shop` on it is a place with a door and a name.
 *
 * `office` is deliberately absent. It is a workplace rather than a destination,
 * and admitting it renamed a photo of the Fuji TV sphere after the office block
 * behind it — trading a landmark for the name of a corporate tenant.
 */
const VENUE_KEYS = ['amenity', 'shop', 'tourism', 'leisure'] as const;

/**
 * What containment inside a named venue is worth.
 *
 * Set alongside a shopping centre's 100, deliberately below a strong nearby
 * attraction: standing in Shibuya Scramble Square should still yield "Shibuya
 * Sky" when the deck is ten metres away, but standing in a restaurant with
 * nothing notable nearby should yield the restaurant.
 */
const VENUE_CONTAINMENT_SCORE = 100;

/**
 * The most recognizable building the point sits inside.
 *
 * `is_in` returns the whole administrative stack — country, prefecture, ward —
 * and every one of those is named and carries a Wikidata id, so notability
 * alone would confidently answer "Japan". Requiring a `building` tag keeps
 * this to structures; requiring Wikipedia or Wikidata keeps it to the ones
 * people have heard of, rather than naming an arbitrary apartment block.
 *
 * `pickLandmark` deliberately still refuses these: its whitelist encodes
 * "you are inside a landmark", and `building=retail` does not mean that on its
 * own. Shibuya Scramble Square is 47 storeys, 229 m tall and tagged exactly
 * that way, so the whitelist alone discarded it entirely.
 */
function bestEnclosingBuilding(
  elements: OverpassElement[],
): { landmark: Landmark; score: number } | null {
  let best: { landmark: Landmark; score: number } | null = null;

  for (const element of elements) {
    const tags = element.tags;
    if (!tags?.building) continue;

    const name = (tags['name:en'] ?? tags.name ?? '').trim();
    if (!name) continue;

    // A building that is also a named venue — a restaurant, a shop, a gallery —
    // is where the photographer was, which is stronger evidence than anything
    // merely close by. Breakfast inside Eggs'n Things in Harajuku was captioned
    // "Near Ota Memorial Museum of Art", a museum up the road, because a plain
    // `building=yes` with `amenity=restaurant` cleared no bar at all.
    const venue = VENUE_KEYS.some((key) => tags[key]);
    const documented = Boolean(tags.wikipedia || tags.wikidata);
    if (!venue && !documented) continue;

    // Standing inside it, so there is no distance to penalize. A venue scores
    // like a mall — recognisable, and specific to the photo — while a building
    // that is only famous keeps the lower structural base.
    const score = venue
      ? VENUE_CONTAINMENT_SCORE + (documented ? 15 : 0)
      : nearbyLandmarkScore(tags, 'building', tags.building, 0, NEARBY_RADIUS_M);
    if (best && score <= best.score) continue;

    best = { landmark: { name, kind: `building=${tags.building}`, near: false }, score };
  }

  return best;
}

/**
 * The district a point sits in, scored rather than taken as given.
 *
 * A district is real information — "Ginza" is a fine answer for a street photo
 * with nothing notable in frame — but it describes a large area, so it should
 * lose to a specific venue the camera is actually next to.
 */
function bestEnclosingDistrict(
  elements: OverpassElement[],
): { landmark: Landmark; score: number } | null {
  const districts = LANDMARK_RULES.find((r) => r.key === 'place')!.values;
  let best: { landmark: Landmark; score: number } | null = null;

  for (const element of elements) {
    const tags = element.tags;
    const value = tags?.place;
    if (!tags || !value || !districts.has(value)) continue;

    const name = (tags['name:en'] ?? tags.name ?? '').trim();
    if (!name) continue;

    const score = nearbyLandmarkScore(tags, 'place', value, 0, NEARBY_RADIUS_M);
    if (best && score <= best.score) continue;

    best = { landmark: { name, kind: `place=${value}`, near: false }, score };
  }

  return best;
}

/**
 * Picks the best name available for a point from both Overpass lookups.
 *
 * Containment inside a mapped landmark wins outright — being inside Tokyo Dome
 * is not a guess. Everything else competes on score at the same table: the
 * nearby venues, the building overhead, and the district underfoot. So a
 * well-known tower answers when nothing nearby is more specific, a named
 * viewpoint a few metres away still beats it, and a district answers only when
 * it genuinely is the most useful thing to say.
 */
export function pickBestLandmark(
  enclosing: OverpassElement[],
  nearby: OverpassElement[],
  point: GeoPoint,
): Landmark | null {
  const contained = pickLandmark(enclosing);
  if (contained) return contained;

  const candidates = [
    bestNearbyCandidate(nearby, point),
    bestEnclosingBuilding(enclosing),
    bestEnclosingDistrict(enclosing),
  ].filter((c): c is { landmark: Landmark; score: number } => c != null);

  if (candidates.length === 0) return null;

  return candidates.reduce((a, b) => (b.score > a.score ? b : a)).landmark;
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
    // A named viewpoint is a destination, not scenery. Shibuya Sky sits 10 m
    // from a photo taken on its deck, tagged with a fee, opening hours and a
    // Wikipedia article — and at base 85 it lost to a node called "front of
    // Shibuya station" 202 m away, purely because that one is tagged
    // `attraction`. Observation decks are exactly what people photograph.
    if (['attraction', 'theme_park', 'zoo', 'aquarium', 'museum', 'viewpoint'].includes(value)) base = 120;
    else if (value === 'gallery') base = 55;
  } else if (key === 'amenity' && value === 'place_of_worship') {
    base = 100;
  } else if (key === 'amenity' && value === 'ferry_terminal') {
    // The maritime equivalent of `aeroway=terminal`, and scored like one. Where
    // boats matter to visitors the pier is the destination: at Hakone-machi the
    // terminal is one metre from the photo and the nearest museum is 75 m
    // inland, so it has to be able to outrank one.
    base = 105;
  } else if (key === 'place') {
    base = value === 'quarter' ? 85 : value === 'neighbourhood' ? 80 : 75;
  } else if (key === 'historic' && value === 'memorial') {
    // A memorial can be a useful answer when the camera is actually beside
    // it, but dense city maps also contain memorials for events that are not
    // visible destinations. Do not let a documented event marker outrank the
    // shopping centre, station or attraction containing the photographer.
    base = 40;
  } else if (key === 'shop' && ['mall', 'department_store'].includes(value)) {
    // Large named complexes are often the human-recognisable destination (and
    // indoor GPS commonly drifts toward an edge of their mapped footprint).
    base = 100;
  }

  const documentedNotability = tags.wikipedia || tags.wikidata ? 15 : 0;
  /**
   * Distance has to actually count. At 25 across the whole radius, being 192 m
   * closer was worth only 22 points — less than the gap between two tourism
   * values — so category noise decided every match and a feature 10 m away
   * routinely lost to one 200 m away.
   *
   * Districts keep a gentler penalty because their mapped centre is arbitrary:
   * a photo can be well inside one and still be far from its centroid. Only
   * gentler, though, not exempt. At 8 they were effectively immune to distance,
   * and a photo inside the Pokémon Center resolved to "Udagawachō" rather than
   * to Shibuya Parco, the building around it.
   */
  const maximumDistancePenalty = key === 'place' ? 20 : 60;
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
