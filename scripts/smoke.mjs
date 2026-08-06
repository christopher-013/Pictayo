/**
 * Smoke tests for the release process.
 *
 * Run: npm run smoke   (after `npm run fixtures` and `npm run build`)
 *
 * These import the real modules rather than reimplementing them, which Node 24
 * allows directly from TypeScript source. Coverage is deliberately weighted
 * towards the things that have actually broken here: the map projection, day
 * grouping across timezones, caption wording, landmark ranking, and whether the
 * built output still uses relative paths so a GitHub Pages sub-path works.
 *
 * Anything needing a DOM or IndexedDB is out of scope — that is what the manual
 * browser pass in the release checklist is for.
 */

import './dom-shims.mjs';

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import sharp from 'sharp';

import { screenPosition, fitZoom, centerOf, mercatorY, latitudeFromMercator } from '../src/geo/mercator.ts';
import {
  DEFAULT_CLUSTER_RADIUS_M, distanceMeters, clusterPhotos, splitIntoRegions,
} from '../src/geo/cluster.ts';
import {
  isFreshCacheEntry, landmarkCacheKey, nearbyLandmarkQuery, pickLandmark, pickNearest,
  pickNearbyDining, pickNotableWikipediaPlace, splitOnCountMarkers,
} from '../src/geo/landmark.ts';
import {
  parseExifDateTime, parseExifOffset, wallClockToInstant,
  dayKeyOf, formatCaptured, formatDayLabel, timeOfDayPhrase,
} from '../src/meta/datetime.ts';
import { MetadataDescriber, wikipediaLocationInfo } from '../src/meta/describe.ts';
import { readMeta } from '../src/meta/exif.ts';
import { escapeAttr } from '../src/util/escape.ts';
import { parseIso6709, parseAppleCreationDate, findBox, parseMoov } from '../src/meta/videoMeta.ts';
import { sampledPhotoId } from '../src/import/contentHash.ts';
import { compareDays } from '../src/library.ts';
import { dayHeading, placesFor } from '../src/ui/dayChip.ts';
import { photoCardHtml } from '../src/ui/photoCard.ts';
import { exportSite, EXPORT_JS, scriptSafeJson } from '../src/export/exportSite.ts';
import feedbackWorker from '../feedback-worker.js';

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function near(name, actual, expected, tolerance) {
  check(name, Math.abs(actual - expected) <= tolerance, `got ${actual}, expected ~${expected}`);
}

// ── Map projection ───────────────────────────────────────────────────────────
// The highest-risk code in the project: pins are positioned by maths alone
// against an opaque Google iframe, so a regression here is silently wrong
// rather than broken. These are the values verified by hand against the live
// map for the Jun 6 fixture day.

{
  const centre = { lat: 35.703601, lon: 139.70175 };
  const takadanobaba = screenPosition({ lat: 35.7135, lon: 139.703 }, centre, 14, 697, 392);
  const shinjuku = screenPosition({ lat: 35.6937, lon: 139.7005 }, centre, 14, 697, 392);

  near('projection: north pin x', takadanobaba.left, 363.1, 0.5);
  near('projection: north pin y', takadanobaba.top, 54.0, 0.5);
  near('projection: south pin x', shinjuku.left, 333.9, 0.5);
  near('projection: south pin y', shinjuku.top, 338.0, 0.5);
  check('projection: both pins visible', takadanobaba.visible && shinjuku.visible);

  // A point far outside the canvas must report itself hidden, or stray pins
  // pile up on the edges of the map.
  const offscreen = screenPosition({ lat: 21.3, lon: -157.8 }, centre, 14, 697, 392);
  check('projection: distant pin hidden', !offscreen.visible);

  near('mercator: round-trips', latitudeFromMercator(mercatorY(35.7135)), 35.7135, 1e-9);

  // Latitude must be averaged in Mercator space, not degrees.
  const centred = centerOf([{ lat: 0, lon: 0 }, { lat: 60, lon: 0 }]);
  check('mercator: centre is not the degree mean', Math.abs(centred.lat - 30) > 0.5,
    `got ${centred.lat}`);

  check('fitZoom: single point stays close', fitZoom([{ lat: 35.7, lon: 139.7 }], 800, 450) >= 15);
  const wide = fitZoom([{ lat: 21.3, lon: -157.8 }, { lat: 35.7, lon: 139.7 }], 800, 450);
  check('fitZoom: transpacific zooms out', wide <= 3, `got ${wide}`);
  check('fitZoom: narrower canvas zooms out further',
    fitZoom([{ lat: 35.71, lon: 139.70 }, { lat: 35.69, lon: 139.70 }], 349, 262) <=
    fitZoom([{ lat: 35.71, lon: 139.70 }, { lat: 35.69, lon: 139.70 }], 697, 392));
}

// ── Distance and clustering ──────────────────────────────────────────────────

{
  near('distance: one degree at equator',
    distanceMeters({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }), 111195, 50);
  near('distance: same point is zero',
    distanceMeters({ lat: 35.7, lon: 139.7 }, { lat: 35.7, lon: 139.7 }), 0, 0.001);

  const photo = (id, lat, lon, takenAt) => ({
    id, name: `${id}.jpg`, bytes: 1, previewUnavailable: false,
    meta: { takenAt, tzOffsetMinutes: 540, dayKey: '2026-06-06', gps: { lat, lon },
            width: 1, height: 1, make: null, model: null, dateSource: 'exif' },
  });

  // Two photos metres apart, one several kilometres away.
  const clusters = clusterPhotos([
    photo('a', 35.7135, 139.7030, 1),
    photo('b', 35.7136, 139.7031, 2),
    photo('c', 35.6937, 139.7005, 3),
  ]);
  check('cluster: nearby photos merge, distant one splits', clusters.length === 2,
    `got ${clusters.length}`);
  check('cluster: merged cluster holds both photos',
    clusters.some((c) => c.photoIds.length === 2));

  // Regression from Jun 13: the old 250 m default averaged separate Tokyo
  // destinations into one lookup point. These coordinates are representative
  // rather than copied from a user's private photo metadata.
  const denseCity = clusterPhotos([
    photo('temple', 35.6670, 139.7720, 1),
    photo('market', 35.6660, 139.7705, 2),
  ]);
  check('cluster: distinct city-block destinations stay separate', denseCity.length === 2,
    `got ${denseCity.length} with ${DEFAULT_CLUSTER_RADIUS_M} m radius`);

  // A day spanning the Pacific must yield two maps, not one useless one.
  const regions = splitIntoRegions(clusters.concat(clusterPhotos([
    photo('d', 21.30694, -157.85833, 4),
  ])));
  check('regions: transpacific day splits', regions.length === 2, `got ${regions.length}`);
  check('regions: nearby clusters stay together',
    splitIntoRegions(clusters).length === 1);
}

// ── Reverse geocoding ────────────────────────────────────────────────────────
// Lookups run a few at a time rather than one after another. Unbounded would
// open a connection per cluster on a large import; serial cost about a second
// for six places, nearly all of it spent waiting.

{
  const { CachedGeocoder } = await import('../src/geo/geocode.ts');

  const realFetch = globalThis.fetch;
  let active = 0;
  let peak = 0;
  let calls = 0;

  globalThis.fetch = async (url) => {
    if (!String(url).includes('bigdatacloud')) return realFetch(url);
    calls += 1;
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 20));
    active -= 1;
    return new Response(JSON.stringify({ locality: 'Testville', countryName: 'Testland' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  };

  // Distinct coordinates so nothing is de-duplicated by cache key.
  const geocoder = new CachedGeocoder();
  const points = Array.from({ length: 10 }, (_, i) => ({ lat: 35 + i * 0.01, lon: 139 + i * 0.01 }));
  const results = await Promise.all(points.map((p) => geocoder.lookup(p.lat, p.lon)));

  globalThis.fetch = realFetch;

  check('geocode: resolves every point', results.every((r) => r?.name?.includes('Testville')),
    `got ${results.filter(Boolean).length}/10`);
  check('geocode: runs lookups concurrently', peak > 1, `peak concurrency ${peak}`);
  check('geocode: bounds concurrency', peak <= 4, `peak concurrency ${peak}`);
  check('geocode: one request per distinct point', calls === 10, `made ${calls} requests`);
}

// ── Landmark selection ───────────────────────────────────────────────────────

{
  // The stadium must win over the commercial estate that also contains it, and
  // administrative boundaries must never be chosen.
  const enclosing = [
    { tags: { landuse: 'commercial', name: 'Tokyo Dome City' } },
    { tags: { boundary: 'administrative', name: 'Bunkyō' } },
    { tags: { leisure: 'stadium', building: 'yes', name: '東京ドーム', 'name:en': 'Tokyo Dome' } },
  ];
  const picked = pickLandmark(enclosing);
  check('landmark: picks the stadium over the estate', picked?.name === 'Tokyo Dome',
    `got ${picked?.name}`);
  check('landmark: reports the matching tag', picked?.kind === 'leisure=stadium');

  check('landmark: ignores boundaries alone',
    pickLandmark([{ tags: { boundary: 'administrative', name: 'Tokyo' } }]) === null);
  check('landmark: needs a name',
    pickLandmark([{ tags: { leisure: 'stadium' } }]) === null);
  check('landmark: empty input is a miss', pickLandmark([]) === null);

  // Regression from two photos taken at Sensō-ji. Reverse geocoding only
  // returned Taito, Tokyo; the enclosing place of worship is the useful label.
  const sensoJi = pickLandmark([
    { tags: { boundary: 'administrative', name: 'Taito' } },
    {
      tags: {
        amenity: 'place_of_worship',
        name: '浅草寺',
        'name:en': 'Sensō-ji',
      },
    },
  ]);
  check('landmark: identifies an enclosing temple', sensoJi?.name === 'Sensō-ji',
    `got ${sensoJi?.name}`);
  check('landmark: ranks the temple above its district',
    sensoJi?.kind === 'amenity=place_of_worship');

  // Batched responses are split on the count markers Overpass emits.
  const groups = splitOnCountMarkers([
    { type: 'way', tags: { name: 'A' } },
    { type: 'count' },
    { type: 'way', tags: { name: 'B' } },
    { type: 'relation', tags: { name: 'C' } },
    { type: 'count' },
  ]);
  check('landmark: batch splits into groups', groups.length === 3, `got ${groups.length}`);
  check('landmark: first group correct', groups[0].length === 1);
  check('landmark: second group correct', groups[1].length === 2);

  check('landmark: enclosing results are not marked as guesses', picked?.near === false);

  check('landmark cache: legacy untimestamped misses are retried',
    !isFreshCacheEntry({ name: '', diningName: '' }));
  check('landmark cache: recent incomplete results avoid immediate repeat requests',
    isFreshCacheEntry({ name: '', diningName: '', checkedAt: 1_000 }, 1_001));
  check('landmark cache: incomplete results expire for retry',
    !isFreshCacheEntry({ name: '', diningName: '', checkedAt: 1_000 }, 7 * 60 * 60 * 1000));

  const notableFromWikipedia = pickNotableWikipediaPlace([
    {
      title: 'Nearby Retail Company',
      coordinates: [{ lat: 35.67121, lon: 139.76321 }],
      pageviews: { a: 500 },
      terms: { description: ['Japanese retail company'] },
    },
    {
      title: 'Ginza',
      coordinates: [{ lat: 35.6717, lon: 139.7649 }],
      pageviews: { a: 32_000 },
      terms: { description: ['district of Chūō, Tokyo, Japan'] },
    },
  ], { lat: 35.6712, lon: 139.7632 });
  check('notable place: popularity and place type beat the nearest business',
    notableFromWikipedia?.name === 'Ginza', notableFromWikipedia?.name);

  const templeParent = pickNotableWikipediaPlace([{
    title: 'Main Hall (Sensō-ji)',
    coordinates: [{ lat: 35.71475, lon: 139.79655 }],
    pageviews: { a: 10_000 },
    terms: { description: ['Buddhist temple building in Tokyo'] },
  }], { lat: 35.7147, lon: 139.7966 });
  check('notable place: a landmark subplace uses its recognizable parent name',
    templeParent?.name === 'Sensō-ji', templeParent?.name);
  check('notable place: distant articles are rejected',
    pickNotableWikipediaPlace([{
      title: 'Far Away', coordinates: [{ lat: 35.8, lon: 139.9 }], pageviews: { a: 1_000_000 },
    }], { lat: 35.7, lon: 139.7 }) === null);

  // Wikipedia geotags an event where it happened, so a coup or a fatal fire
  // sits on the map exactly like a museum. Both of these really were returned
  // for real photo coordinates: "February 26 incident" captioned a photo taken
  // inside the Pokémon Center in Shibuya PARCO, and "Myojo 56 building fire"
  // was the pick for Kabukichō. Fame alone must never name a place.
  const shibuyaPages = [
    {
      title: 'February 26 incident',
      coordinates: [{ lat: 35.66405, lon: 139.69845 }],
      pageviews: { a: 11_332 },
      terms: { description: ["failed 1936 coup d'état in Japan"] },
    },
    {
      title: 'Shibuya Public Hall',
      coordinates: [{ lat: 35.66425, lon: 139.69766 }],
      pageviews: { a: 259 },
      terms: { description: ['music venue in Udagawachō, Japan'] },
    },
  ];
  check('notable place: a famous event is not a place',
    pickNotableWikipediaPlace(shibuyaPages, { lat: 35.6624, lon: 139.698 }) === null,
    'an event geotagged nearby must never caption a photo');
  check('notable place: a fatal fire is not a place',
    pickNotableWikipediaPlace([{
      title: 'Myojo 56 building fire',
      coordinates: [{ lat: 35.6949, lon: 139.7025 }],
      pageviews: { a: 9_000 },
      terms: { description: ['2001 building fire in Tokyo, Japan'] },
    }], { lat: 35.6937, lon: 139.7005 }) === null);
  check('notable place: an organization is not a place',
    pickNotableWikipediaPlace([{
      title: 'Hawaii Senate',
      coordinates: [{ lat: 21.3079, lon: -157.8574 }],
      pageviews: { a: 4_000 },
      terms: { description: ['upper house of the Hawaii State Legislature'] },
    }], { lat: 21.30694, lon: -157.85833 }) === null);
  check('notable place: an unexplained subject is refused, not assumed',
    pickNotableWikipediaPlace([{
      title: 'Something Famous', coordinates: [{ lat: 35.7001, lon: 139.7001 }],
      pageviews: { a: 500_000 },
    }], { lat: 35.7, lon: 139.7 }) === null,
    'no description means no evidence it is somewhere you can stand');

  // Fame is evidence of recognition, not of proximity. Uncapped, the most-read
  // article inside the radius won regardless of how much closer a rival sat.
  const fameVsDistance = pickNotableWikipediaPlace([
    {
      title: 'World Famous Tower',
      coordinates: [{ lat: 35.70279, lon: 139.7 }], // ~310m
      pageviews: { a: 2_000_000 },
      terms: { description: ['observation tower in Tokyo, Japan'] },
    },
    {
      title: 'Local Shrine',
      coordinates: [{ lat: 35.70018, lon: 139.7 }], // ~20m
      pageviews: { a: 300 },
      terms: { description: ['Shinto shrine in Tokyo, Japan'] },
    },
  ], { lat: 35.7, lon: 139.7 });
  check('notable place: fame cannot outrun a much closer landmark',
    fameVsDistance?.name === 'Local Shrine', fameVsDistance?.name);
}

// ── Overpass outage handling ─────────────────────────────────────────────────
// A transient Overpass failure used to fall straight through to the Wikipedia
// guess and cache it, so one 429 could bake a wrong landmark in for six hours.
// Overpass now gets retried first, and a guess made during an outage is shown
// but never persisted.

{
  const { OverpassLandmarkFinder } = await import('../src/geo/landmark.ts');

  const realFetch = globalThis.fetch;
  // The retry backoffs are real seconds; the test cares about the sequence of
  // attempts, not about waiting them out.
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => realSetTimeout(fn, 0);

  let overpassAttempts = 0;
  let wikipediaCalls = 0;

  globalThis.fetch = async (url) => {
    const target = String(url?.url ?? url);
    if (target.includes('/api/interpreter')) {
      overpassAttempts += 1;
      throw new Error('simulated Overpass outage');
    }
    if (target.includes('wikipedia.org')) {
      wikipediaCalls += 1;
      return new Response(JSON.stringify({ query: { pages: [{
        title: 'Kabukichō',
        coordinates: [{ lat: 35.6949, lon: 139.7025 }],
        pageviews: { a: 5_000 },
        terms: { description: ['entertainment district in Shinjuku, Tokyo'] },
      }] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(url);
  };

  const finder = new OverpassLandmarkFinder();
  const resolved = await finder.findMany([{ lat: 35.6949, lon: 139.7025 }]);
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realSetTimeout;

  const entry = [...resolved.values()][0];
  // Three passes over three mirrors before the guess is allowed to speak.
  check('outage: Overpass is retried before falling back',
    overpassAttempts === 9, `made ${overpassAttempts} attempts`);
  check('outage: the fallback still answers rather than leaving it blank',
    entry?.landmark?.name === 'Kabukichō', JSON.stringify(entry?.landmark));
  check('outage: the fallback is consulted once, not per retry',
    wikipediaCalls === 1, `made ${wikipediaCalls} calls`);
}

// ── Nearby landmarks ─────────────────────────────────────────────────────────
// teamLab Planets is mapped as a bare node, so nothing encloses the photo and
// `is_in` can never find it. The proximity pass is what rescues that case.

{
  const at = { lat: 35.6486, lon: 139.7906 };
  const teamLab = {
    type: 'node', lat: 35.64938, lon: 139.78973,
    tags: { tourism: 'museum', name: 'teamLab Planets' },
  };
  // ~90m away, and the sort of thing naive nearest-POI would have chosen.
  const cafe = { type: 'node', lat: 35.6485, lon: 139.7896, tags: { amenity: 'cafe', name: 'A Cafe' } };

  const nearby = pickNearest([cafe, teamLab], at);
  check('nearby: finds a node-mapped landmark', nearby?.name === 'teamLab Planets', `got ${nearby?.name}`);
  check('nearby: flags it as a guess', nearby?.near === true);
  check('nearby: ignores un-notable neighbours',
    pickNearest([cafe], at) === null, 'a cafe should not qualify');

  // Distance breaks ties within the same category.
  const far = { type: 'node', lat: 35.6496, lon: 139.7885, tags: { tourism: 'attraction', name: 'Further Away' } };
  check('nearby: closer wins within a category',
    pickNearest([far, teamLab], at)?.name === 'teamLab Planets');

  // Regression: ranking purely by distance picked the station entrance 40m away
  // over the museum 117m away, which is the wrong answer for a photo.
  const station = { type: 'node', lat: 35.64893, lon: 139.79095, tags: { railway: 'station', name: 'Shin-toyosu' } };
  const chosen = pickNearest([station, teamLab], at);
  check('nearby: notability beats proximity', chosen?.name === 'teamLab Planets',
    `got ${chosen?.name} — a nearer station must not outrank a museum`);

  // Anything beyond the radius is not a credible guess.
  const distant = { type: 'node', lat: 35.66, lon: 139.80, tags: { tourism: 'museum', name: 'Too Far' } };
  check('nearby: rejects anything past the radius', pickNearest([distant], at) === null);

  // Ways and relations arrive with a `center` rather than lat/lon.
  const viaCenter = { type: 'way', center: { lat: 35.6487, lon: 139.7905 }, tags: { leisure: 'park', name: 'A Park' } };
  check('nearby: reads `center` for ways', pickNearest([viaCenter], at)?.name === 'A Park');

  check('nearby: empty input is a miss', pickNearest([], at) === null);

  // Regression from photos jun-13-165/166 at Sensō-ji Hondō. The picker
  // supported temple tags, but the Overpass proximity query omitted them, so
  // the real feature could never reach the picker when its enclosing outline
  // was unnamed.
  //
  // The query now fetches everything named nearby and lets `pickNearest` apply
  // the rules, so the two cannot drift apart again. These assert that shape
  // rather than a list of tags to keep in sync by hand.
  const sensoJiQuery = nearbyLandmarkQuery({
    lat: 35.714644444444446,
    lon: 139.79649444444445,
  });
  check('nearby query: one spatial scan per point',
    (sensoJiQuery.match(/around:/g) || []).length === 1, sensoJiQuery);
  check('nearby query: asks only for named features',
    sensoJiQuery.includes('[name]'));
  check('nearby query: cannot omit a tag the picker understands',
    !/\[["~]?(amenity|tourism|building|place|leisure)/.test(sensoJiQuery),
    'a tag filter here would reintroduce query/scorer drift');

  const sensoJiNode = {
    type: 'node', lat: 35.71475, lon: 139.79655,
    tags: { amenity: 'place_of_worship', name: '浅草寺', 'name:en': 'Sensō-ji' },
  };
  check('nearby: identifies Sensō-ji from its named temple feature',
    pickNearest([sensoJiNode], {
      lat: 35.714644444444446,
      lon: 139.79649444444445,
    })?.name === 'Sensō-ji');

  // Regression from jun-13-233/234: both photos are geotagged in Ginza, but a
  // nearby gallery was selected solely because `tourism` used to outrank every
  // other category. A documented district is more useful context for street
  // photography, while the museum regression above still protects specific
  // major attractions.
  const ginzaPoint = { lat: 35.67117361111111, lon: 139.76323055555556 };
  const leForum = {
    type: 'node', lat: 35.67135, lon: 139.76305,
    tags: { tourism: 'gallery', name: 'Le Forum – Hermès', wikidata: 'Q3229326' },
  };
  const ginza = {
    type: 'node', lat: 35.6717, lon: 139.7649,
    tags: { place: 'quarter', name: '銀座', 'name:en': 'Ginza', wikipedia: 'en:Ginza' },
  };
  check('nearby: notable district beats a small nearby gallery',
    pickNearest([leForum, ginza], ginzaPoint)?.name === 'Ginza');

  // Regression from the Pokémon Center photos at Shibuya PARCO. A nearby
  // documented event memorial used to tie the mall's score and win on
  // proximity, producing the unrelated "February 26 incident" caption.
  const shibuyaParcoPoint = { lat: 35.66238333333333, lon: 139.69868472222223 };
  const february26Memorial = {
    type: 'node', lat: 35.66242, lon: 139.69867,
    tags: {
      historic: 'memorial', name: '二・二六事件',
      'name:en': 'February 26 incident', wikidata: 'Q871121',
    },
  };
  const shibuyaParco = {
    type: 'way', center: { lat: 35.66215, lon: 139.69884 },
    tags: { shop: 'mall', name: '渋谷PARCO', 'name:en': 'Shibuya PARCO' },
  };
  check('nearby: a destination venue outranks an unrelated event memorial',
    pickNearest([february26Memorial, shibuyaParco], shibuyaParcoPoint)?.name ===
      'Shibuya PARCO');
}

// ── Nearby dining ────────────────────────────────────────────────────────────

{
  const at = { lat: 35.6486, lon: 139.7906 };
  const restaurant = {
    type: 'node', lat: 35.64865, lon: 139.7906,
    tags: { amenity: 'restaurant', name: '寿司大', 'name:en': 'Sushi Dai' },
  };
  const cafe = {
    type: 'node', lat: 35.6486, lon: 139.7912,
    tags: { amenity: 'cafe', name: 'A Cafe' },
  };
  const bar = {
    type: 'node', lat: 35.64861, lon: 139.7906,
    tags: { amenity: 'bar', name: 'Nearest Bar' },
  };

  const dining = pickNearbyDining([cafe, bar, restaurant], at);
  check('dining: chooses the nearest supported food venue', dining?.name === 'Sushi Dai',
    `got ${dining?.name}`);
  check('dining: reports the venue kind', dining?.kind === 'restaurant');
  check('dining: reports an approximate distance',
    typeof dining?.distanceMeters === 'number' && dining.distanceMeters > 0);
  check('dining: preserves the venue mapped position',
    dining?.lat === restaurant.lat && dining?.lon === restaurant.lon);
  check('dining: ignores unsupported amenities', pickNearbyDining([bar], at) === null);
  check('dining: requires a name',
    pickNearbyDining([{ ...restaurant, tags: { amenity: 'restaurant' } }], at) === null);

  const indoorDrift = {
    ...restaurant, lat: 35.6488, tags: { amenity: 'restaurant', name: 'Indoor GPS match' },
  };
  check('dining: allows normal indoor GPS drift',
    pickNearbyDining([indoorDrift], at)?.name === 'Indoor GPS match');

  const outsideRange = {
    ...restaurant, lat: 35.6489, tags: { amenity: 'restaurant', name: 'Outside focused range' },
  };
  check('dining: rejects a venue beyond the focused range',
    pickNearbyDining([outsideRange], at) === null);

  check('dining cache: distinguishes points about a metre apart',
    landmarkCacheKey(35.24590, 139.05099) !== landmarkCacheKey(35.24591, 139.05099));

  const distant = {
    ...restaurant, lat: 35.651, tags: { amenity: 'restaurant', name: 'Too Far' },
  };
  check('dining: rejects venues beyond the tight radius', pickNearbyDining([distant], at) === null);
  check('dining: empty input is a miss', pickNearbyDining([], at) === null);
}

// ── Capture times ────────────────────────────────────────────────────────────

{
  const wall = parseExifDateTime('2026:06:06 16:42:00');
  check('datetime: parses EXIF timestamps', wall?.year === 2026 && wall?.hour === 16);
  check('datetime: rejects blank clocks', parseExifDateTime('0000:00:00 00:00:00') === null);
  check('datetime: rejects nonsense', parseExifDateTime('not a date') === null);

  check('datetime: parses positive offsets', parseExifOffset('+09:00') === 540);
  check('datetime: parses negative offsets', parseExifOffset('-07:00') === -420);
  check('datetime: rejects bad offsets', parseExifOffset('nope') === null);

  const instant = wallClockToInstant(wall);
  check('datetime: day key uses the camera clock', dayKeyOf(instant) === '2026-06-06',
    dayKeyOf(instant));

  // A late-evening photo must not slide into the next or previous day.
  const lateNight = wallClockToInstant(parseExifDateTime('2026:06:06 23:50:00'));
  check('datetime: late evening stays on its day', dayKeyOf(lateNight) === '2026-06-06');
  const earlyHours = wallClockToInstant(parseExifDateTime('2026:06:06 00:10:00'));
  check('datetime: small hours stay on their day', dayKeyOf(earlyHours) === '2026-06-06');

  const captured = formatCaptured(instant, 540);
  check('datetime: caption shows the camera clock', captured.includes('4:42 PM'), captured);
  check('datetime: caption shows the offset', captured.includes('UTC+09:00'), captured);
  check('datetime: offset omitted when unknown', !formatCaptured(instant, null).includes('UTC'));

  check('datetime: day label', formatDayLabel('2026-06-06') === 'Sat, Jun 6, 2026',
    formatDayLabel('2026-06-06'));
  check('datetime: time of day', timeOfDayPhrase(instant) === 'afternoon', timeOfDayPhrase(instant));
}

// ── Captions ─────────────────────────────────────────────────────────────────

{
  const describer = new MetadataDescriber();
  const photo = (dateSource = 'exif') => ({
    id: 'p', name: 'p.jpg', bytes: 1, previewUnavailable: false,
    meta: { takenAt: Date.UTC(2026, 5, 7, 13, 46), tzOffsetMinutes: 540, dayKey: '2026-06-07',
            gps: { lat: 35.7056, lon: 139.7519 }, width: 1, height: 1,
            make: 'Apple', model: 'iPhone', dateSource },
  });
  const cluster = {
    id: 'c0', lat: 35.7056, lon: 139.7519, photoIds: ['p', 'q'],
    place: 'Tokyo Dome', area: 'Bunkyo-ku, Tokyo', landmark: 'Tokyo Dome',
    landmarkNearby: false, nearbyDining: null, nearbyDiningDistanceMeters: null,
    nearbyDiningLat: null, nearbyDiningLon: null,
    mapsUrl: '', firstAt: 1, lastAt: 2,
  };

  const withLandmark = describer.describe({ photo: photo(), cluster, clusterSize: 2 });
  check('caption: names the landmark and the area',
    withLandmark.desc === 'Midday at Tokyo Dome, Bunkyo-ku, Tokyo.', withLandmark.desc);
  check('caption: location line is the landmark', withLandmark.location === 'Tokyo Dome');
  check('caption: landmark links to its own article',
    withLandmark.infoLabel === 'Tokyo Dome' &&
      withLandmark.infoUrl === 'https://en.wikipedia.org/wiki/Tokyo_Dome');

  const sensoJiInfo = wikipediaLocationInfo('Sensō-ji');
  check('caption: Sensō-ji links to the correct article, not Taito',
    sensoJiInfo?.label === 'Sensō-ji' &&
      sensoJiInfo.url === 'https://en.wikipedia.org/wiki/Sens%C5%8D-ji');

  const hakoneInfo = wikipediaLocationInfo('Hakone, Kanagawa');
  check('caption: Hakone links directly to its English Wikipedia article',
    hakoneInfo?.label === 'Hakone' && hakoneInfo.url === 'https://en.wikipedia.org/wiki/Hakone');
  check('caption: unresolved coordinates do not get an information link',
    wikipediaLocationInfo('35.1894°N, 139.0247°E') === null);

  // Regression: the photo-count and time-span sentence was removed as
  // redundant with the timestamp shown directly beneath it.
  check('caption: no photo count', !/One of \d+ photos/.test(withLandmark.desc), withLandmark.desc);
  check('caption: no time span', !/\d+:\d+[–-]/.test(withLandmark.desc), withLandmark.desc);

  // With no landmark the area must not be printed twice.
  const areaOnly = { ...cluster, place: 'Bunkyo-ku, Tokyo', landmark: null };
  const plain = describer.describe({ photo: photo(), cluster: areaOnly, clusterSize: 2 });
  check('caption: area not repeated', plain.desc === 'Midday at Bunkyo-ku, Tokyo.', plain.desc);

  const coordinateFallback = '35.6624°N, 139.6987°E';
  const parcoWithCoordinateArea = describer.describe({
    photo: photo(),
    cluster: {
      ...cluster,
      place: 'Shibuya PARCO',
      area: coordinateFallback,
      landmark: 'Shibuya PARCO',
      landmarkNearby: true,
    },
    clusterSize: 2,
  });
  check('caption: coordinate fallback is hidden when a landmark is known',
    parcoWithCoordinateArea.desc === 'Midday close to Shibuya PARCO.' &&
      !parcoWithCoordinateArea.desc.includes('35.6624'),
    parcoWithCoordinateArea.desc);

  const coordinatesOnly = describer.describe({
    photo: photo(),
    cluster: {
      ...cluster,
      place: coordinateFallback,
      area: coordinateFallback,
      landmark: null,
      landmarkNearby: false,
    },
    clusterSize: 1,
  });
  check('caption: raw GPS coordinates are never visible copy',
    coordinatesOnly.location === 'Mapped location' &&
      coordinatesOnly.desc === 'Midday at this mapped location.' &&
      !coordinatesOnly.desc.includes('35.6624'),
    `${coordinatesOnly.location} / ${coordinatesOnly.desc}`);

  // A guessed landmark must read as a guess, in both the sentence and the
  // location line — never as a claim that you were inside it.
  const nearby = { ...cluster, place: 'teamLab Planets', area: 'Koto-ku, Tokyo',
    landmark: 'teamLab Planets', landmarkNearby: true };
  const guessedPlace = describer.describe({ photo: photo(), cluster: nearby, clusterSize: 2 });
  check('caption: hedges a nearby landmark',
    guessedPlace.desc === 'Midday close to teamLab Planets, Koto-ku, Tokyo.', guessedPlace.desc);
  check('caption: location line says Near', guessedPlace.location === 'Near teamLab Planets',
    guessedPlace.location);
  check('caption: nearby matched landmark links to itself',
    guessedPlace.infoLabel === 'teamLab Planets' &&
      guessedPlace.infoUrl === 'https://en.wikipedia.org/wiki/teamLab_Planets');
  check('caption: enclosing landmark is not hedged', !withLandmark.desc.includes('close to'));

  const diningCluster = {
    ...cluster, nearbyDining: 'Sushi Dai', nearbyDiningDistanceMeters: 42,
    nearbyDiningLat: 35.64865, nearbyDiningLon: 139.7906,
  };
  const withDining = describer.describe({ photo: photo(), cluster: diningCluster, clusterSize: 2 });
  check('caption: nearby dining omits uncertain GPS distance',
    withDining.dining === 'Nearby place: Sushi Dai.',
    withDining.dining);
  check('caption: nearby dining links to an area-scoped Maps search',
    withDining.diningUrl?.startsWith('https://www.google.com/maps/search/?api=1&query=') &&
      withDining.diningUrl.includes('Sushi%20Dai') &&
      withDining.diningUrl.includes('Bunkyo-ku%2C%20Tokyo') &&
      !withDining.diningUrl.includes('35.648650'));

  const takenouchi = describer.describe({
    photo: photo(),
    cluster: {
      ...diningCluster,
      area: 'Shibuya, Tokyo',
      nearbyDining: 'Teuchi Soba Takenouchi',
      nearbyDiningDistanceMeters: 8,
    },
    clusterSize: 2,
  });
  check('caption: Takenouchi regression omits 8 m distance',
    takenouchi.dining === 'Nearby place: Teuchi Soba Takenouchi.');
  check('caption: Takenouchi regression searches by venue and Shibuya',
    takenouchi.diningUrl?.includes(
      'query=Teuchi%20Soba%20Takenouchi%2C%20Shibuya%2C%20Tokyo',
    ));

  const diningCard = photoCardHtml({
    photo: { ...photo(), kind: 'photo', thumbUrl: 'blob:test', caption: withDining },
    lightboxIndex: 0,
  });
  check('photo card: nearby dining line links to restaurant details',
    diningCard.includes('View restaurant details in Google Maps') &&
      diningCard.includes('target="_blank"'));

  const guessed = describer.describe({ photo: photo('file'), cluster, clusterSize: 1 });
  check('caption: flags file-date fallback', guessed.desc.includes('file date'), guessed.desc);

  const noGps = describer.describe({ photo: photo(), cluster: null, clusterSize: 0 });
  check('caption: handles missing GPS', noGps.desc.includes('no location recorded'), noGps.desc);
  check('caption: no location line without GPS', noGps.location === '');

  const card = photoCardHtml({
    photo: {
      ...photo(), kind: 'photo', name: '<temple>.jpg', thumbUrl: 'blob:test',
      caption: withLandmark,
    },
    lightboxIndex: 0,
  });
  check('photo card: includes a local-remove control',
    card.includes('data-remove-photo="p"'));
  check('photo card: remove control has an escaped accessible name',
    card.includes('aria-label="Remove &lt;temple&gt;.jpg from Pictayo"'));
  check('photo card: remove control sits in the date footer',
    card.indexOf('photo-card-footer') < card.indexOf('data-remove-photo'));
  check('photo card: remove control uses a monochrome SVG icon',
    card.includes('<svg aria-hidden="true"'));
  check('photo card: description links to landmark information',
    card.includes('Learn about Tokyo Dome') && card.includes('en.wikipedia.org/wiki/Tokyo_Dome'));
}

// ── Day navigation ───────────────────────────────────────────────────────────
// Day-navigation regressions.
{
  const day = (dayKey) => ({
    dayKey, label: dayKey, photos: [], regions: [], taggedCount: 0,
  });
  const ordered = [day('2026-06-06'), day('undated'), day('2026-06-08')].sort(compareDays);
  check('day nav: oldest day first',
    ordered.map((item) => item.dayKey).join(',') === '2026-06-06,2026-06-08,undated',
    ordered.map((item) => item.dayKey).join(','));

  const nearbyDay = {
    ...day('2026-06-06'),
    photos: [{ id: 'p' }],
    regions: [{
      id: 'r0', centerLat: 0, centerLon: 0, zoom: 1, taggedCount: 1,
      clusters: [{
        id: 'c0', lat: 35.7135, lon: 139.703, photoIds: ['p'],
        place: 'Natsuge Museum', area: 'Toshima-ku, Tokyo',
        landmark: 'Natsuge Museum', landmarkNearby: true,
        nearbyDining: null, nearbyDiningDistanceMeters: null,
        nearbyDiningLat: null, nearbyDiningLon: null, mapsUrl: '',
        firstAt: 1, lastAt: 1,
      }],
    }],
    taggedCount: 1,
  };
  check('day nav: reflects the matched landmark',
    placesFor(nearbyDay).label === 'Natsuge Museum', placesFor(nearbyDay).label);
  nearbyDay.label = 'Sat, Jun 6, 2026';
  check('day heading: date followed by location without media type',
    dayHeading(nearbyDay) === 'Sat, Jun 6, 2026 · Natsuge Museum',
    dayHeading(nearbyDay));

  const sensoJiDay = {
    ...nearbyDay,
    regions: [{
      ...nearbyDay.regions[0],
      taggedCount: 6,
      clusters: [
        {
          ...nearbyDay.regions[0].clusters[0],
          id: 'near-kaminarimon', place: 'Kaminarimon', landmark: 'Kaminarimon',
          landmarkNearby: true, photoIds: ['a', 'b', 'c'],
        },
        {
          ...nearbyDay.regions[0].clusters[0],
          id: 'at-sensoji', place: 'Sensō-ji', landmark: 'Sensō-ji',
          landmarkNearby: false, photoIds: ['d', 'e', 'f'],
        },
      ],
    }],
  };
  check('day nav: enclosing Sensō-ji wins a tie with nearby Kaminarimon',
    placesFor(sensoJiDay).label === 'Sensō-ji', placesFor(sensoJiDay).label);
}

// ── Video metadata ───────────────────────────────────────────────────────────
// Videos carry none of this in EXIF, so the QuickTime container is walked
// directly. See src/meta/videoMeta.ts.

{
  // ISO 6709, as iPhones write it.
  const gps = parseIso6709('©xyz+35.7056+139.7519+012.345/');
  check('video: reads ISO 6709 location', gps?.lat === 35.7056 && gps?.lon === 139.7519,
    JSON.stringify(gps));
  check('video: reads southern/western signs',
    parseIso6709('-33.8688+151.2093/')?.lat === -33.8688);
  check('video: rejects a null-island fix', parseIso6709('+00.0000+000.0000/') === null);
  check('video: ignores text with no coordinates', parseIso6709('no location here') === null);

  // Apple's creationdate is the only source that knows the local offset.
  const withZone = parseAppleCreationDate('com.apple.quicktime.creationdate2026-06-08T16:43:00+0900');
  check('video: reads Apple creation date', withZone !== null);
  check('video: keeps the local wall clock',
    new Date(withZone.instant).toISOString().startsWith('2026-06-08T16:43'),
    new Date(withZone?.instant ?? 0).toISOString());
  check('video: reads the offset', withZone?.offsetMinutes === 540, String(withZone?.offsetMinutes));
  check('video: handles a Z suffix',
    parseAppleCreationDate('2026-06-08T16:43:00Z')?.offsetMinutes === 0);
  check('video: handles a colon in the offset',
    parseAppleCreationDate('2026-06-08T16:43:00-07:00')?.offsetMinutes === -420);
  check('video: rejects implausible years', parseAppleCreationDate('1899-01-01T00:00:00Z') === null);

  // Box walking, against a hand-built container.
  const box = (type, payload) => {
    const bytes = new Uint8Array(8 + payload.length);
    new DataView(bytes.buffer).setUint32(0, bytes.length);
    bytes.set([...type].map((c) => c.charCodeAt(0)), 4);
    bytes.set(payload, 8);
    return bytes;
  };

  // mvhd v0: version/flags, created, modified, timescale, duration.
  const mvhdPayload = new Uint8Array(24);
  const mvhdView = new DataView(mvhdPayload.buffer);
  const created1904 = 2_082_844_800 + Math.floor(Date.UTC(2026, 5, 8, 7, 43) / 1000);
  mvhdView.setUint32(0, 0);              // version 0 + flags
  mvhdView.setUint32(4, created1904);    // creation time
  mvhdView.setUint32(8, created1904);    // modification time
  mvhdView.setUint32(12, 1000);          // timescale
  mvhdView.setUint32(16, 12_000);        // duration → 12s
  const mvhd = box('mvhd', mvhdPayload);

  const xyz = box('udta', new TextEncoder().encode('©xyz+35.6486+139.7906/'));
  const moovPayload = new Uint8Array(mvhd.length + xyz.length);
  moovPayload.set(mvhd, 0);
  moovPayload.set(xyz, mvhd.length);
  const container = box('moov', moovPayload);

  const moov = findBox(container, 'moov');
  check('video: finds a box by type', moov !== null);
  check('video: ignores a box that is not there', findBox(container, 'ftyp') === null);

  const parsed = parseMoov(moov);
  check('video: reads duration from mvhd', parsed.durationMs === 12_000, String(parsed.durationMs));
  check('video: reads mvhd creation time', parsed.mvhdCreatedAt !== null);
  check('video: finds GPS inside moov',
    parsed.gps?.lat === 35.6486 && parsed.gps?.lon === 139.7906, JSON.stringify(parsed.gps));
}

// ── Escaping ─────────────────────────────────────────────────────────────────

{
  const nasty = escapeAttr('"><img src=x onerror=alert(1)>');
  check('escape: neutralises quotes and brackets',
    !nasty.includes('<') && !nasty.includes('>') && !nasty.includes('"'), nasty);
  check('escape: ampersands first', escapeAttr('&lt;') === '&amp;lt;');
  check('escape: handles null', escapeAttr(null) === '');
}

// ── Bounded content hashing ─────────────────────────────────────────────────

{
  const first = new Uint8Array(1024 * 1024).fill(7);
  const second = first.slice();
  second[second.length - 1] = 8;
  const firstId = await sampledPhotoId(new Blob([first]));
  const duplicateId = await sampledPhotoId(new Blob([first]));
  const changedId = await sampledPhotoId(new Blob([second]));
  check('hash: identical photo content keeps a stable id', firstId === duplicateId);
  check('hash: a changed tail produces a different id', firstId !== changedId);
  check('hash: includes exact byte length in the id', firstId.endsWith(first.length.toString(16)));
}

// ── EXIF, against the generated fixtures ─────────────────────────────────────

const fixturesDir = 'fixtures';

if (!existsSync(fixturesDir)) {
  failures.push('fixtures/ missing — run `npm run fixtures` first');
} else {
  const asFile = (name) => {
    const path = join(fixturesDir, name);
    return new File([readFileSync(path)], name, {
      type: 'image/jpeg',
      lastModified: statSync(path).mtimeMs,
    });
  };

  const dome = await readMeta(asFile('jun07-01-tokyodome.jpg'));
  near('exif: latitude', dome.gps?.lat ?? 0, 35.7056, 0.0005);
  near('exif: longitude', dome.gps?.lon ?? 0, 139.7519, 0.0005);
  check('exif: day key', dome.dayKey === '2026-06-07', dome.dayKey);
  check('exif: timezone offset', dome.tzOffsetMinutes === 540, String(dome.tzOffsetMinutes));
  check('exif: date came from the camera', dome.dateSource === 'exif');

  const noGps = await readMeta(asFile('jun07-03-nogps.jpg'));
  check('exif: absent GPS reported as null', noGps.gps === null);
  check('exif: undated-GPS photo still has a day', noGps.dayKey === '2026-06-07');

  const noDate = await readMeta(asFile('nodate-01.jpg'));
  check('exif: falls back to the file timestamp', noDate.dateSource === 'file', noDate.dateSource);
  check('exif: fallback still yields a day', typeof noDate.dayKey === 'string');
}

// ── Built output ─────────────────────────────────────────────────────────────

{
  const mainSource = readFileSync(join('src', 'main.ts'), 'utf8');
  const styleSource = readFileSync(join('src', 'styles.css'), 'utf8');
  const feedbackSource = readFileSync(join('src', 'ui', 'feedback.ts'), 'utf8');
  const ingestWorkerSource = readFileSync(join('src', 'import', 'ingest.worker.ts'), 'utf8');
  const feedbackWorkerSource = readFileSync('feedback-worker.js', 'utf8');
  const externalLinkSources = [
    join('src', 'ui', 'photoCard.ts'),
    join('src', 'ui', 'photoMap.ts'),
    join('src', 'ui', 'lightbox.ts'),
    join('src', 'export', 'exportSite.ts'),
  ].map((path) => readFileSync(path, 'utf8')).join('\n');
  const provisional = mainSource.indexOf('await refresh(true, localOnlyGeocoder);');
  const status = mainSource.indexOf("showLocationProgress('Locations are processing", provisional);
  const resolve = mainSource.indexOf('await refresh(false);', provisional);
  const enrich = mainSource.indexOf('await enrichInBackground(false);', resolve);
  const finalRender = mainSource.indexOf('await refresh();', enrich);
  check('import: renders local photos before network-backed place enrichment',
    provisional >= 0 && status > provisional && resolve > status && enrich > resolve && finalRender > enrich);
  check('import: delays the location-processing status to avoid a warm-cache flash',
    mainSource.includes('LOCATION_STATUS_DELAY_MS') && mainSource.includes('window.setTimeout'));
  check('import: provisional render preserves cached place names without network requests',
    mainSource.includes('new CacheOnlyGeocoder()'));
  check('navigation: date and Show All chips share one responsive width',
    styleSource.includes('flex: 0 0 var(--day-chip-width)') &&
      styleSource.includes('width: var(--day-chip-width)'));
  check('navigation: app controls and date strip stay pinned without overlap',
    styleSource.includes('.app-header {\n  position: sticky;') &&
      styleSource.includes('top: var(--app-header-height)'));
  check('navigation: long place names truncate with an ellipsis',
    styleSource.includes('text-overflow: ellipsis'));
  check('dialog: destructive action uses a compact bounded column',
    styleSource.includes('grid-template-columns: 126px minmax(210px, 250px)') &&
      styleSource.includes('justify-content: end'));
  check('feedback: submits to the server-side Worker without a GitHub redirect',
    feedbackSource.includes('picturepicture-feedback.cch13.workers.dev/api/feedback') &&
      !feedbackSource.includes('github.com'));
  check('feedback: does not collect or submit an email address',
    !feedbackSource.includes('feedback-email') && !feedbackSource.includes('email:'));
  check('import: photo worker never buffers a whole original for hashing',
    ingestWorkerSource.includes('sampledPhotoId(file)') && !ingestWorkerSource.includes('file.arrayBuffer()'));
  check('security: no committed GitHub token pattern',
    !/\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/.test(
      `${mainSource}\n${feedbackSource}\n${feedbackWorkerSource}`,
    ));
  check('security: new-window links always suppress opener and referrer',
    !externalLinkSources.includes('rel="noopener"') &&
      !externalLinkSources.includes(".rel = 'noopener';") &&
      !externalLinkSources.includes("a.rel='noopener';"));
}

{
  const botRequest = new Request('https://picturepicture-feedback.cch13.workers.dev/api/feedback', {
    method: 'POST',
    headers: { Origin: 'https://christopher-013.github.io', 'Content-Type': 'application/json' },
    body: JSON.stringify({ website: 'filled-by-bot', summary: 'spam' }),
  });
  const botResponse = await feedbackWorker.fetch(botRequest, {});
  check('feedback worker: quietly traps honeypot submissions',
    botResponse.status === 201 && (await botResponse.json()).ok === true);

  const deniedRequest = new Request('https://picturepicture-feedback.cch13.workers.dev/api/feedback', {
    method: 'POST',
    headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' },
    body: JSON.stringify({ summary: 'not allowed' }),
  });
  const deniedResponse = await feedbackWorker.fetch(deniedRequest, {});
  check('feedback worker: rejects unapproved origins', deniedResponse.status === 403);

  // Rate limiting is required, so every test past this point has to supply the
  // binding a real deployment gets from wrangler.jsonc.
  const withLimiter = (success = true) => ({
    FEEDBACK_RATE_LIMITER: { limit: async () => ({ success }) },
  });

  const feedbackRequest = (body) =>
    new Request('https://picturepicture-feedback.cch13.workers.dev/api/feedback', {
      method: 'POST',
      headers: { Origin: 'https://christopher-013.github.io', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  const unsafeResponse = await feedbackWorker.fetch(
    feedbackRequest({ summary: '<script>alert(1)</script>', message: '' }), withLimiter());
  check('feedback worker: rejects active-content payloads', unsafeResponse.status === 422);

  const unconfiguredResponse = await feedbackWorker.fetch(
    feedbackRequest({ summary: 'Valid report', message: 'No secret details here.' }), withLimiter());
  const unconfiguredBody = await unconfiguredResponse.json();
  check('feedback worker: fails closed with a generic missing-secret response',
    unconfiguredResponse.status === 503 &&
      !JSON.stringify(unconfiguredBody).toLowerCase().includes('secret') &&
      !JSON.stringify(unconfiguredBody).toLowerCase().includes('configured'));

  // A deploy that loses the rate-limit binding must refuse to file issues
  // rather than quietly accepting an unlimited stream of them.
  const unlimitedResponse = await feedbackWorker.fetch(
    feedbackRequest({ summary: 'Valid report', message: 'No limiter bound.' }),
    { GITHUB_TOKEN: 'test-token-never-used' });
  check('feedback worker: fails closed when the rate limiter is missing',
    unlimitedResponse.status === 503, `got ${unlimitedResponse.status}`);
  check('feedback worker: missing limiter does not name the cause',
    !JSON.stringify(await unlimitedResponse.json()).toLowerCase().includes('rate'));

  const throttledResponse = await feedbackWorker.fetch(
    feedbackRequest({ summary: 'Valid report', message: 'Too many.' }),
    { GITHUB_TOKEN: 'test-token-never-used', ...withLimiter(false) });
  check('feedback worker: throttles once the limiter says no',
    throttledResponse.status === 429, `got ${throttledResponse.status}`);

  // A limiter that throws is an absent control, not a reason to proceed.
  const brokenResponse = await feedbackWorker.fetch(
    feedbackRequest({ summary: 'Valid report', message: 'Limiter down.' }),
    {
      GITHUB_TOKEN: 'test-token-never-used',
      FEEDBACK_RATE_LIMITER: { limit: async () => { throw new Error('limiter unavailable'); } },
    });
  check('feedback worker: treats a failing limiter as throttled',
    brokenResponse.status === 429, `got ${brokenResponse.status}`);
}

const dist = 'dist';

if (!existsSync(dist)) {
  failures.push('dist/ missing — run `npm run build` first');
} else {
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:href|src)="([^"]+\.(?:js|css|png|webp))"/g)].map((m) => m[1]);

  check('build: has asset references', refs.length > 0);
  // Absolute paths break a GitHub Pages project sub-path.
  const absolute = refs.filter((r) => r.startsWith('/'));
  check('build: all asset paths relative', absolute.length === 0, absolute.join(', '));

  for (const required of ['favicon.png', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png',
    'logo.webp', 'mark.webp', 'assets/branding/pictayo-logo.png',
    'assets/branding/pictayo-mascot.png',
    'robots.txt', 'sitemap.xml', 'site.webmanifest', 'privacy.html', 'privacy.css']) {
    check(`build: ships ${required}`, existsSync(join(dist, required)));
  }

  const logoRaw = await sharp(join(dist, 'logo.webp'))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const alphaValues = [];
  for (let i = 3; i < logoRaw.data.length; i += logoRaw.info.channels) alphaValues.push(logoRaw.data[i]);
  check('brand: transparent logo background is preserved',
    alphaValues.filter((alpha) => alpha === 0).length > alphaValues.length * 0.25);
  const alphaAt = (x, y) => logoRaw.data[(y * logoRaw.info.width + x) * logoRaw.info.channels + 3];
  check('brand: mascot whites remain opaque', alphaAt(380, 120) > 250);
  const markRaw = await sharp(join(dist, 'mark.webp')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const markAlpha = [];
  for (let i = 3; i < markRaw.data.length; i += markRaw.info.channels) markAlpha.push(markRaw.data[i]);
  check('brand: compact mobile mascot has a transparent background',
    markAlpha.filter((alpha) => alpha === 0).length > markAlpha.length * 0.2);

  const assets = readdirSync(join(dist, 'assets'));
  check('build: emits the ingest worker', assets.some((f) => f.startsWith('ingest.worker')));
  check('build: emits one js bundle', assets.some((f) => f.startsWith('index-') && f.endsWith('.js')));
  check('build: emits css', assets.some((f) => f.endsWith('.css')));
  const appBundleName = assets.find((f) => f.startsWith('index-') && f.endsWith('.js'));
  const appBundle = appBundleName ? readFileSync(join(dist, 'assets', appBundleName), 'utf8') : '';

  check('build: title present', /<title>[^<]+<\/title>/.test(html));
  check('build: Pictayo public-release brand is present',
    html.includes('<title>Pictayo — Your Memories, Mapped by Time and Place</title>') &&
      html.includes('name="pictayo-version" content="1.0.0"') &&
      html.includes('Your memories, mapped by time and place.') &&
      html.includes('Your private photo map'));
  check('build: charset declared', html.includes('charset="utf-8"'));
  check('build: Open Graph image is absolute',
    html.includes('content="https://christopher-013.github.io/Pictayo/og-image.png"'));
  check('build: canonical URL and crawl directives are present',
    html.includes('rel="canonical"') && html.includes('name="robots"'));
  check('build: restrictive CSP excludes unsafe script execution',
    html.includes('http-equiv="Content-Security-Policy"') &&
      html.includes("object-src 'none'") && html.includes("form-action 'none'") &&
      !html.includes("script-src 'self' 'unsafe-inline'") && !html.includes("'unsafe-eval'"));
  // The dev server relaxes style-src so Vite's injected styles render; that
  // relaxation lives in vite.config.ts and must never reach the built page.
  check('build: shipped CSP keeps style-src strict',
    !html.includes("'unsafe-inline'"), 'the dev-only style relaxation leaked into the build');
  check('build: no inline styles need relaxing',
    !/<style[\s>]/i.test(html) && !/\sstyle="/i.test(html));
  check('build: CSP allowlists every application network service',
    ['api.bigdatacloud.net', 'overpass-api.de', 'overpass.kumi.systems',
      'overpass.private.coffee', 'en.wikipedia.org',
      'picturepicture-feedback.cch13.workers.dev']
      .every((host) => html.includes(host)));
  // Reverse geocoding 307s from the documented host to api-bdc.io. A redirect
  // to an unlisted origin is blocked outright, which silently turns every
  // place name back into raw coordinates — so the target has to be allowed too.
  check('build: CSP allows the reverse-geocode redirect target',
    html.includes('https://api-bdc.io'),
    'api.bigdatacloud.net redirects to api-bdc.io; both origins must be listed');
  check('build: social preview metadata is complete',
    html.includes('property="og:url"') && html.includes('name="twitter:image"'));
  check('build: structured data describes the web application',
    html.includes('application/ld+json') && html.includes('SoftwareApplication') &&
      html.includes('PhotographyApplication') && html.includes('"operatingSystem": "Web"'));
  const appStyle = readFileSync(join('src', 'styles.css'), 'utf8');
  check('build: feedback has a top-right bubble, footer link, and in-app dialog',
    html.includes('class="btn btn-feedback header-feedback"') &&
      html.includes('class="footer-link" data-open-feedback') &&
      (html.match(/data-open-feedback/g) || []).length === 2 &&
      html.includes('id="feedback-dialog"'));
  check('build: mobile header uses compact actions without folder or feedback clutter',
    html.includes('<span class="mobile-action-label">Add</span>') &&
      html.includes('<span class="mobile-action-label">Export</span>') &&
      appStyle.includes('#btn-add-folder-more,') &&
      appStyle.includes('.header-feedback,') &&
      appStyle.includes('.desktop-action-label { display: none; }') &&
      appStyle.includes('.mobile-action-label { display: inline; }'));
  check('build: footer opens the in-app privacy dialog',
    html.includes('class="site-footer"') && html.includes('data-open-info="privacy"'));
  check('build: landing keeps one tagline and opens details from Learn More',
    html.includes('<h1 class="landing-tagline">') &&
      !html.includes('class="landing-heading"') &&
      html.includes('Choose Photos') && html.includes('See How It Works') &&
      html.includes('<span class="landing-learn" id="landing-learn">') &&
      html.includes('data-open-info="learn-more"') &&
      html.indexOf('class="site-footer-line"') < html.indexOf('id="landing-learn"') &&
      !html.includes('Learn More <span aria-hidden="true">↗</span>'));
  check('build: About copy explains the name, pronunciation, and broad audience',
    html.includes('pic-TAH-yo') && html.includes('“Pic tayo,”') &&
      html.includes('Pictayo is made for everyone.'));
  check('build: responsive header has accessible Pictayo text outside the logo artwork',
    html.includes('class="app-logo-mobile" aria-label="Pictayo"') &&
      html.includes('<strong>Pic</strong>tayo'));
  check('build: informational content uses native modal dialogs',
    html.includes('id="learn-more-dialog"') && html.includes('id="privacy-dialog"'));
  check('build: privacy dialog uses a compact non-scrolling desktop flow',
    html.includes('privacy-dialog-grid') &&
      appStyle.includes('.privacy-dialog-grid { display: block; }') &&
      appStyle.includes('overflow-y: visible'));
  const privacyHtml = readFileSync(join(dist, 'privacy.html'), 'utf8');
  check('build: privacy page documents local media and external location services',
    privacyHtml.includes('does not upload your library') &&
      privacyHtml.includes('BigDataCloud') && privacyHtml.includes('OpenStreetMap') &&
      privacyHtml.includes('Google Maps'));
  check('build: privacy page has its own restrictive CSP',
    privacyHtml.includes('Content-Security-Policy') && privacyHtml.includes("script-src 'none'"));
  const manifest = JSON.parse(readFileSync(join(dist, 'site.webmanifest'), 'utf8'));
  check('build: web manifest uses the Pictayo launch identity',
    manifest.name === 'Pictayo' && manifest.short_name === 'Pictayo' &&
      manifest.description === 'Your memories, mapped by time and place.' &&
      manifest.theme_color === '#0b326b' && manifest.background_color === '#ffffff');
  check('build: feedback bundle never sends the visitor to GitHub',
    appBundle.includes('picturepicture-feedback.cch13.workers.dev/api/feedback') &&
      !appBundle.includes('github.com'));
  check('build: lightbox includes zoom controls', html.includes('photo-lightbox-zoom-in'));
  check('build: includes the styled confirmation dialog',
    html.includes('id="action-dialog"') && html.includes('action-dialog-note'));
  check('build: includes the Everywhere navigation page',
    appBundle.includes('Show all photo locations') && appBundle.includes('#everywhere'));
  check('build: Show All includes every item in oldest-to-newest date groups',
    appBundle.includes('All photos by date · oldest to newest') &&
      appBundle.includes('everywhere-day-group'));
  check('build: Show All omits the redundant Everywhere I Have Been heading',
    !appBundle.includes('Everywhere I Have Been'));
  check('build: includes interactive map zoom controls',
    appBundle.includes('data-map-zoom-in') && appBundle.includes('mapUserZoom'));
  check('build: uses the custom modal confirmation flow', appBundle.includes('showModal'));
  check('build: nearby restaurant details are linked',
    appBundle.includes('View restaurant details in Google Maps'));
  check('build: descriptions link to destination information',
    appBundle.includes('Learn about'));
  let exportScriptParses = true;
  try {
    new Function(EXPORT_JS);
  } catch {
    exportScriptParses = false;
  }
  check('export: generated script parses', exportScriptParses);
  check('export: includes image zoom controls', EXPORT_JS.includes("el('lb-zoom-in')"));
  check('export: includes mobile pinch handling', EXPORT_JS.includes("addEventListener('touchmove'"));
  check('export: includes coordinated map wheel zoom',
    EXPORT_JS.includes("addEventListener('wheel'") && EXPORT_JS.includes('mapPosition(c)'));
  check('export: lightbox links nearby restaurant details', EXPORT_JS.includes('it.diningUrl'));
  check('export: lightbox links destination information', EXPORT_JS.includes('it.infoUrl'));
  // Mojibake check: the em-dash must survive the build as real UTF-8.
  check('build: text encoded correctly', !html.includes('�'));
}

// ── Exported Everywhere page ────────────────────────────────────────────────

{
  const cluster = {
    id: 'c0', lat: 35.68, lon: 139.76, photoIds: ['p1'], place: 'Tokyo', area: 'Tokyo',
    landmark: null, landmarkNearby: false, nearbyDining: null,
    nearbyDiningDistanceMeters: null, nearbyDiningLat: null, nearbyDiningLon: null,
    mapsUrl: '', firstAt: null, lastAt: null,
  };
  const exportDay = {
    dayKey: '2026-06-10', label: 'Wed, Jun 10, 2026', photos: [], taggedCount: 1,
    regions: [{
      id: 'r0', clusters: [cluster], centerLat: cluster.lat, centerLon: cluster.lon,
      zoom: 8, taggedCount: 1,
    }],
  };
  const archive = unzipSync(new Uint8Array(await (await exportSite([exportDay])).arrayBuffer()));
  const dayPage = strFromU8(archive['index.html']);
  const everywherePage = strFromU8(archive['everywhere.html']);
  const exportedCss = strFromU8(archive['assets/site.css']);
  check('export: Pictayo logo dimensions match the generated asset',
    readFileSync(join('src', 'export', 'exportSite.ts'), 'utf8')
      .includes('width="760" height="608"'));
  check('export: creates everywhere.html', Boolean(archive['everywhere.html']));
  check('export: appends Everywhere after the date links',
    dayPage.indexOf('everywhere.html') > dayPage.indexOf('day-chip-dow'));
  check('export: lightbox metadata is inert JSON',
    dayPage.includes('<script type="application/json" id="lb-data">') &&
      !dayPage.includes('<script>var LB='));
  const hostileTitle = '</script><script>alert("export injection")</script>&';
  const safeJson = scriptSafeJson({ title: hostileTitle });
  check('export: script-safe JSON contains no HTML delimiters',
    !safeJson.includes('<') && !safeJson.includes('>') && !safeJson.includes('&'));
  check('export: script-safe JSON preserves the original value',
    JSON.parse(safeJson).title === hostileTitle);
  check('export: date and Show All chips share one responsive width',
    exportedCss.includes('flex:0 0 var(--day-chip-width);width:var(--day-chip-width)'));
  check('export: Everywhere page contains the world map and a day link',
    everywherePage.includes('World map of all photo locations') && everywherePage.includes('href="index.html"'));
  check('export: Everywhere page includes the date-sorted photo timeline',
    everywherePage.includes('All photos by date &middot; oldest to newest') &&
      everywherePage.includes('everywhere-day-group'));
  check('export: Show All omits the redundant Everywhere I Have Been heading',
    !everywherePage.includes('Everywhere I Have Been'));
}

// ── Report ───────────────────────────────────────────────────────────────────

const total = passed + failures.length;
if (failures.length > 0) {
  console.error(`\nSMOKE FAILED — ${failures.length} of ${total} checks failed:\n`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  console.error('');
  process.exit(1);
}

console.log(`Smoke passed — ${passed} checks.`);
