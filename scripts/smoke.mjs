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

import { screenPosition, fitZoom, centerOf, mercatorY, latitudeFromMercator } from '../src/geo/mercator.ts';
import { distanceMeters, clusterPhotos, splitIntoRegions } from '../src/geo/cluster.ts';
import { pickLandmark, pickNearest, splitOnCountMarkers } from '../src/geo/landmark.ts';
import {
  parseExifDateTime, parseExifOffset, wallClockToInstant,
  dayKeyOf, formatCaptured, formatDayLabel, timeOfDayPhrase,
} from '../src/meta/datetime.ts';
import { MetadataDescriber } from '../src/meta/describe.ts';
import { readMeta } from '../src/meta/exif.ts';
import { escapeAttr } from '../src/util/escape.ts';

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
    landmarkNearby: false, mapsUrl: '', firstAt: 1, lastAt: 2,
  };

  const withLandmark = describer.describe({ photo: photo(), cluster, clusterSize: 2 });
  check('caption: names the landmark and the area',
    withLandmark.desc === 'Midday at Tokyo Dome, Bunkyo-ku, Tokyo.', withLandmark.desc);
  check('caption: location line is the landmark', withLandmark.location === 'Tokyo Dome');

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

  const guessed = describer.describe({ photo: photo('file'), cluster, clusterSize: 1 });
  check('caption: flags file-date fallback', guessed.desc.includes('file date'), guessed.desc);

  const noGps = describer.describe({ photo: photo(), cluster: null, clusterSize: 0 });
  check('caption: handles missing GPS', noGps.desc.includes('no location recorded'), noGps.desc);
  check('caption: no location line without GPS', noGps.location === '');
}

// ── Escaping ─────────────────────────────────────────────────────────────────

{
  const nasty = escapeAttr('"><img src=x onerror=alert(1)>');
  check('escape: neutralises quotes and brackets',
    !nasty.includes('<') && !nasty.includes('>') && !nasty.includes('"'), nasty);
  check('escape: ampersands first', escapeAttr('&lt;') === '&amp;lt;');
  check('escape: handles null', escapeAttr(null) === '');
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

  for (const required of ['favicon.png', 'apple-touch-icon.png', 'logo.webp', 'mark.webp']) {
    check(`build: ships ${required}`, existsSync(join(dist, required)));
  }

  const assets = readdirSync(join(dist, 'assets'));
  check('build: emits the ingest worker', assets.some((f) => f.startsWith('ingest.worker')));
  check('build: emits one js bundle', assets.some((f) => f.startsWith('index-') && f.endsWith('.js')));
  check('build: emits css', assets.some((f) => f.endsWith('.css')));

  check('build: title present', /<title>[^<]+<\/title>/.test(html));
  check('build: charset declared', html.includes('charset="utf-8"'));
  // Mojibake check: the em-dash must survive the build as real UTF-8.
  check('build: text encoded correctly', !html.includes('�'));
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
