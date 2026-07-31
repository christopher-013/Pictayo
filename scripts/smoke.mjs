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

import { screenPosition, fitZoom, centerOf, mercatorY, latitudeFromMercator } from '../src/geo/mercator.ts';
import { distanceMeters, clusterPhotos, splitIntoRegions } from '../src/geo/cluster.ts';
import {
  landmarkCacheKey, pickLandmark, pickNearest, pickNearbyDining, splitOnCountMarkers,
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

  // A day spanning the Pacific must yield two maps, not one useless one.
  const regions = splitIntoRegions(clusters.concat(clusterPhotos([
    photo('d', 21.30694, -157.85833, 4),
  ])));
  check('regions: transpacific day splits', regions.length === 2, `got ${regions.length}`);
  check('regions: nearby clusters stay together',
    splitIntoRegions(clusters).length === 1);
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
  check('caption: nearby landmark uses its surrounding destination article',
    withLandmark.infoLabel === 'Bunkyo' &&
      withLandmark.infoUrl === 'https://en.wikipedia.org/wiki/Bunkyo%2C_Tokyo');

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

  // A guessed landmark must read as a guess, in both the sentence and the
  // location line — never as a claim that you were inside it.
  const nearby = { ...cluster, place: 'teamLab Planets', area: 'Koto-ku, Tokyo',
    landmark: 'teamLab Planets', landmarkNearby: true };
  const guessedPlace = describer.describe({ photo: photo(), cluster: nearby, clusterSize: 2 });
  check('caption: hedges a nearby landmark',
    guessedPlace.desc === 'Midday close to teamLab Planets, Koto-ku, Tokyo.', guessedPlace.desc);
  check('caption: location line says Near', guessedPlace.location === 'Near teamLab Planets',
    guessedPlace.location);
  check('caption: enclosing landmark is not hedged', !withLandmark.desc.includes('close to'));

  const diningCluster = {
    ...cluster, nearbyDining: 'Sushi Dai', nearbyDiningDistanceMeters: 42,
    nearbyDiningLat: 35.64865, nearbyDiningLon: 139.7906,
  };
  const withDining = describer.describe({ photo: photo(), cluster: diningCluster, clusterSize: 2 });
  check('caption: nearby dining uses a compact distance',
    withDining.dining === 'Nearby place: Sushi Dai · 42 m.',
    withDining.dining);
  check('caption: nearby dining links to a coordinate-scoped Maps search',
    withDining.diningUrl?.startsWith('https://www.google.com/maps/search/?api=1&query=') &&
      withDining.diningUrl.includes('Sushi%20Dai') &&
      withDining.diningUrl.includes('35.648650'));

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
    card.includes('aria-label="Remove &lt;temple&gt;.jpg from PicturePicture"'));
  check('photo card: remove control sits in the date footer',
    card.indexOf('photo-card-footer') < card.indexOf('data-remove-photo'));
  check('photo card: remove control uses a monochrome SVG icon',
    card.includes('<svg aria-hidden="true"'));
  check('photo card: description links to destination information',
    card.includes('Learn about Bunkyo') && card.includes('en.wikipedia.org'));
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
  check('day nav: nearby landmark keeps reliable area',
    placesFor(nearbyDay).label === 'Toshima-ku', placesFor(nearbyDay).label);
  nearbyDay.label = 'Sat, Jun 6, 2026';
  check('day heading: date followed by location without media type',
    dayHeading(nearbyDay) === 'Sat, Jun 6, 2026 · Toshima-ku',
    dayHeading(nearbyDay));
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

  const unsafeRequest = new Request('https://picturepicture-feedback.cch13.workers.dev/api/feedback', {
    method: 'POST',
    headers: { Origin: 'https://christopher-013.github.io', 'Content-Type': 'application/json' },
    body: JSON.stringify({ summary: '<script>alert(1)</script>', message: '' }),
  });
  const unsafeResponse = await feedbackWorker.fetch(unsafeRequest, {});
  check('feedback worker: rejects active-content payloads', unsafeResponse.status === 422);

  const unconfiguredRequest = new Request('https://picturepicture-feedback.cch13.workers.dev/api/feedback', {
    method: 'POST',
    headers: { Origin: 'https://christopher-013.github.io', 'Content-Type': 'application/json' },
    body: JSON.stringify({ summary: 'Valid report', message: 'No secret details here.' }),
  });
  const unconfiguredResponse = await feedbackWorker.fetch(unconfiguredRequest, {});
  const unconfiguredBody = await unconfiguredResponse.json();
  check('feedback worker: fails closed with a generic missing-secret response',
    unconfiguredResponse.status === 503 &&
      !JSON.stringify(unconfiguredBody).toLowerCase().includes('secret') &&
      !JSON.stringify(unconfiguredBody).toLowerCase().includes('configured'));
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

  for (const required of ['favicon.png', 'apple-touch-icon.png', 'logo.webp', 'mark.webp',
    'robots.txt', 'sitemap.xml', 'site.webmanifest']) {
    check(`build: ships ${required}`, existsSync(join(dist, required)));
  }

  const assets = readdirSync(join(dist, 'assets'));
  check('build: emits the ingest worker', assets.some((f) => f.startsWith('ingest.worker')));
  check('build: emits one js bundle', assets.some((f) => f.startsWith('index-') && f.endsWith('.js')));
  check('build: emits css', assets.some((f) => f.endsWith('.css')));
  const appBundleName = assets.find((f) => f.startsWith('index-') && f.endsWith('.js'));
  const appBundle = appBundleName ? readFileSync(join(dist, 'assets', appBundleName), 'utf8') : '';

  check('build: title present', /<title>[^<]+<\/title>/.test(html));
  check('build: charset declared', html.includes('charset="utf-8"'));
  check('build: Open Graph image is absolute',
    html.includes('content="https://christopher-013.github.io/PicturePicture/og-image.png"'));
  check('build: canonical URL and crawl directives are present',
    html.includes('rel="canonical"') && html.includes('name="robots"'));
  check('build: restrictive CSP excludes unsafe script execution',
    html.includes('http-equiv="Content-Security-Policy"') &&
      html.includes("object-src 'none'") && html.includes("form-action 'none'") &&
      !html.includes("script-src 'self' 'unsafe-inline'") && !html.includes("'unsafe-eval'"));
  check('build: CSP allowlists every application network service',
    ['api.bigdatacloud.net', 'overpass-api.de', 'overpass.kumi.systems',
      'overpass.private.coffee', 'picturepicture-feedback.cch13.workers.dev']
      .every((host) => html.includes(host)));
  check('build: social preview metadata is complete',
    html.includes('property="og:url"') && html.includes('name="twitter:image"'));
  check('build: structured data describes the web application',
    html.includes('application/ld+json') && html.includes('PhotographyApplication'));
  check('build: public-beta feedback has two entry points and an in-app dialog',
    (html.match(/data-open-feedback/g) || []).length >= 2 && html.includes('id="feedback-dialog"'));
  check('build: feedback bundle never sends the visitor to GitHub',
    appBundle.includes('picturepicture-feedback.cch13.workers.dev/api/feedback') &&
      !appBundle.includes('github.com'));
  check('build: lightbox includes zoom controls', html.includes('photo-lightbox-zoom-in'));
  check('build: includes the styled confirmation dialog',
    html.includes('id="action-dialog"') && html.includes('action-dialog-note'));
  check('build: includes the Everywhere navigation page',
    appBundle.includes('Show all photo locations') && appBundle.includes('#everywhere'));
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
