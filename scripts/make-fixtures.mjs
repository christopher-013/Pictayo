/**
 * Generates test photos with known EXIF, so the whole pipeline — date grouping,
 * GPS clustering, region splitting, captions — can be exercised without using
 * anyone's real library.
 *
 * Each file is a real baseline JPEG built from scratch (grayscale, solid tone,
 * one tone per location so clusters are visually distinguishable) with a
 * hand-assembled EXIF APP1 segment carrying DateTimeOriginal,
 * OffsetTimeOriginal, Make/Model and GPS coordinates.
 *
 * Run: npm run fixtures   →   ./fixtures/*.jpg
 */

import { mkdir, writeFile, utimes, rm } from 'node:fs/promises';
import { join } from 'node:path';

const OUT_DIR = 'fixtures';

// ── Fixture definition ───────────────────────────────────────────────────────

const PLACES = {
  honolulu:      { lat:  21.30694, lon: -157.85833, tone:  40, label: 'Honolulu' },
  haneda:        { lat:  35.54930, lon:  139.76930, tone:  10, label: 'Haneda Airport' },
  takadanobaba:  { lat:  35.71350, lon:  139.70300, tone: -25, label: 'Takadanobaba' },
  shinjuku:      { lat:  35.69370, lon:  139.70050, tone: -55, label: 'Shinjuku' },
  tokyoDome:     { lat:  35.70560, lon:  139.75190, tone:  55, label: 'Tokyo Dome' },
  // Mapped in OpenStreetMap as a bare node with no footprint, so nothing
  // encloses this point — the case that only the proximity lookup can name.
  teamLab:       { lat:  35.64860, lon:  139.79060, tone: -70, label: 'teamLab Planets' },
};

const FIXTURES = [
  // A travel day that crosses the Pacific — must produce two separate maps.
  { name: 'jun05-01-honolulu',   date: '2026:06:05', time: '10:08:00', tz: '-10:00', place: 'honolulu' },
  { name: 'jun05-02-honolulu',   date: '2026:06:05', time: '10:41:00', tz: '-10:00', place: 'honolulu' },
  { name: 'jun05-03-haneda',     date: '2026:06:05', time: '17:10:00', tz: '+09:00', place: 'haneda' },
  { name: 'jun05-04-haneda',     date: '2026:06:05', time: '17:26:00', tz: '+09:00', place: 'haneda' },

  // An ordinary day with two clusters a few km apart.
  { name: 'jun06-01-takadanobaba', date: '2026:06:06', time: '16:42:00', tz: '+09:00', place: 'takadanobaba' },
  { name: 'jun06-02-takadanobaba', date: '2026:06:06', time: '17:05:00', tz: '+09:00', place: 'takadanobaba' },
  { name: 'jun06-03-takadanobaba', date: '2026:06:06', time: '17:33:00', tz: '+09:00', place: 'takadanobaba' },
  { name: 'jun06-04-shinjuku',     date: '2026:06:06', time: '19:30:00', tz: '+09:00', place: 'shinjuku' },
  { name: 'jun06-05-shinjuku',     date: '2026:06:06', time: '20:02:00', tz: '+09:00', place: 'shinjuku' },

  // A day with a single cluster, plus a photo carrying no GPS at all.
  { name: 'jun07-01-tokyodome', date: '2026:06:07', time: '13:15:00', tz: '+09:00', place: 'tokyoDome' },
  { name: 'jun07-02-tokyodome', date: '2026:06:07', time: '14:48:00', tz: '+09:00', place: 'tokyoDome' },
  { name: 'jun07-03-nogps',     date: '2026:06:07', time: '21:12:00', tz: '+09:00', place: null, tone: 90 },

  // A landmark that exists only as a point in OpenStreetMap.
  { name: 'jun08-01-teamlab', date: '2026:06:08', time: '16:43:00', tz: '+09:00', place: 'teamLab' },
  { name: 'jun08-02-teamlab', date: '2026:06:08', time: '16:44:00', tz: '+09:00', place: 'teamLab' },

  // No EXIF date at all: exercises the file-timestamp fallback and the
  // "by file date" caption. A truly undated photo needs lastModified === 0,
  // which the filesystem won't produce, so this is the realistic case.
  { name: 'nodate-01', date: null, time: null, tz: null, place: 'shinjuku', mtime: '2026-06-09T12:00:00Z' },
];

// ── JPEG encoder (grayscale, solid tone) ─────────────────────────────────────

// Standard Annex K luminance tables — the same ones nearly every encoder ships.
const DC_BITS = [0, 0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

const AC_BITS = [0, 0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_VALS = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
  0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
  0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
  0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
  0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
  0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
  0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
];

/** Builds the canonical (code, length) map from a JPEG BITS/VALS pair. */
function huffmanCodes(bits, vals) {
  const table = new Map();
  let code = 0;
  let k = 0;
  for (let length = 1; length <= 16; length++) {
    for (let i = 0; i < bits[length]; i++) table.set(vals[k++], { code: code++, length });
    code <<= 1;
  }
  return table;
}

class BitWriter {
  constructor() {
    this.bytes = [];
    this.acc = 0;
    this.count = 0;
  }

  write(code, length) {
    for (let i = length - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((code >> i) & 1);
      if (++this.count === 8) {
        this.bytes.push(this.acc);
        // 0xFF in entropy data must be byte-stuffed with a following 0x00.
        if (this.acc === 0xff) this.bytes.push(0x00);
        this.acc = 0;
        this.count = 0;
      }
    }
  }

  flush() {
    while (this.count !== 0) this.write(1, 1);
    return Uint8Array.from(this.bytes);
  }
}

/** Bit category and payload for a DC difference, per JPEG's coding scheme. */
function categoryOf(value) {
  const magnitude = Math.abs(value);
  let size = 0;
  while (magnitude >= 1 << size) size++;
  return { size, bits: value < 0 ? value + (1 << size) - 1 : value };
}

/**
 * A solid-tone 64x64 grayscale baseline JPEG.
 *
 * Every 8x8 block is flat, so only the first block carries a nonzero DC
 * difference and every block is just "DC, end-of-block".
 */
function buildJpeg(tone) {
  const size = 64;
  const blocks = (size / 8) * (size / 8);
  const quant = 16;

  const dc = huffmanCodes(DC_BITS, DC_VALS);
  const ac = huffmanCodes(AC_BITS, AC_VALS);

  const writer = new BitWriter();
  const level = Math.round(Math.max(-1023, Math.min(1023, tone * 8)) / quant);

  for (let i = 0; i < blocks; i++) {
    const diff = i === 0 ? level : 0;
    const { size: category, bits } = categoryOf(diff);
    const entry = dc.get(category);
    writer.write(entry.code, entry.length);
    if (category > 0) writer.write(bits, category);

    const eob = ac.get(0x00);
    writer.write(eob.code, eob.length);
  }

  const scan = writer.flush();

  const dqt = [0xff, 0xdb, 0x00, 0x43, 0x00, ...new Array(64).fill(quant)];
  const sof = [0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, size, 0x00, size, 0x01, 0x01, 0x11, 0x00];

  const dhtDc = [0xff, 0xc4, ...be16(2 + 1 + 16 + DC_VALS.length), 0x00, ...DC_BITS.slice(1), ...DC_VALS];
  const dhtAc = [0xff, 0xc4, ...be16(2 + 1 + 16 + AC_VALS.length), 0x10, ...AC_BITS.slice(1), ...AC_VALS];

  const sos = [0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00];

  return { head: [0xff, 0xd8], body: [...dqt, ...sof, ...dhtDc, ...dhtAc, ...sos, ...scan, 0xff, 0xd9] };
}

function be16(n) {
  return [(n >> 8) & 0xff, n & 0xff];
}

// ── EXIF (TIFF) writer ───────────────────────────────────────────────────────

const TYPE_ASCII = 2;
const TYPE_RATIONAL = 5;

function ascii(text) {
  return Uint8Array.from([...Buffer.from(`${text}`, 'latin1'), 0]);
}

function rationals(values) {
  const out = new DataView(new ArrayBuffer(values.length * 8));
  values.forEach(([num, den], i) => {
    out.setUint32(i * 8, num, false);
    out.setUint32(i * 8 + 4, den, false);
  });
  return new Uint8Array(out.buffer);
}

/** Degrees as the deg/min/sec rational triple EXIF expects. */
function dms(value) {
  const abs = Math.abs(value);
  const degrees = Math.floor(abs);
  const minutes = Math.floor((abs - degrees) * 60);
  const seconds = Math.round((abs - degrees - minutes / 60) * 3600 * 10000);
  return rationals([
    [degrees, 1],
    [minutes, 1],
    [seconds, 10000],
  ]);
}

/**
 * Lays out IFD0, the Exif sub-IFD and the GPS IFD into one TIFF block.
 * Values longer than 4 bytes go in a trailing data area and are referenced by
 * offset from the start of the TIFF header, as the spec requires.
 */
function buildTiff({ ifd0 = [], exif = [], gps = [] }) {
  const hasExif = exif.length > 0;
  const hasGps = gps.length > 0;

  const ifd0Entries = [...ifd0];
  const ifd0Count = ifd0Entries.length + (hasExif ? 1 : 0) + (hasGps ? 1 : 0);

  const ifd0Offset = 8;
  const ifd0Size = 2 + ifd0Count * 12 + 4;
  const exifOffset = ifd0Offset + ifd0Size;
  const exifSize = hasExif ? 2 + exif.length * 12 + 4 : 0;
  const gpsOffset = exifOffset + exifSize;
  const gpsSize = hasGps ? 2 + gps.length * 12 + 4 : 0;

  let dataCursor = gpsOffset + gpsSize;
  const dataChunks = [];

  const writeIfd = (view, offset, entries, extra) => {
    const all = [...entries, ...extra];
    view.setUint16(offset, all.length, false);

    all.forEach((entry, i) => {
      const at = offset + 2 + i * 12;
      view.setUint16(at, entry.tag, false);
      view.setUint16(at + 2, entry.type, false);
      view.setUint32(at + 4, entry.count, false);

      if (entry.pointer !== undefined) {
        view.setUint32(at + 8, entry.pointer, false);
        return;
      }

      if (entry.data.length <= 4) {
        // Short values sit inline, left-justified in the 4-byte field.
        for (let b = 0; b < entry.data.length; b++) view.setUint8(at + 8 + b, entry.data[b]);
      } else {
        view.setUint32(at + 8, dataCursor, false);
        dataChunks.push({ offset: dataCursor, data: entry.data });
        dataCursor += entry.data.length + (entry.data.length % 2);
      }
    });

    view.setUint32(offset + 2 + all.length * 12, 0, false);
  };

  // Two passes: the first sizes the data area, the second writes for real.
  const probe = new DataView(new ArrayBuffer(dataCursor + 4096));
  writeIfd(probe, ifd0Offset, ifd0Entries, [
    ...(hasExif ? [{ tag: 0x8769, type: 4, count: 1, pointer: exifOffset }] : []),
    ...(hasGps ? [{ tag: 0x8825, type: 4, count: 1, pointer: gpsOffset }] : []),
  ]);
  if (hasExif) writeIfd(probe, exifOffset, exif, []);
  if (hasGps) writeIfd(probe, gpsOffset, gps, []);

  const total = dataCursor;
  const buffer = new ArrayBuffer(total);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // "MM" big-endian, magic 42, offset to IFD0.
  bytes.set([0x4d, 0x4d, 0x00, 0x2a], 0);
  view.setUint32(4, ifd0Offset, false);

  dataCursor = gpsOffset + gpsSize;
  dataChunks.length = 0;

  writeIfd(view, ifd0Offset, ifd0Entries, [
    ...(hasExif ? [{ tag: 0x8769, type: 4, count: 1, pointer: exifOffset }] : []),
    ...(hasGps ? [{ tag: 0x8825, type: 4, count: 1, pointer: gpsOffset }] : []),
  ]);
  if (hasExif) writeIfd(view, exifOffset, exif, []);
  if (hasGps) writeIfd(view, gpsOffset, gps, []);

  for (const chunk of dataChunks) bytes.set(chunk.data, chunk.offset);

  return bytes;
}

function buildApp1(spec) {
  const ifd0 = [
    { tag: 0x010f, type: TYPE_ASCII, count: 0, data: ascii('PicturePicture') },
    { tag: 0x0110, type: TYPE_ASCII, count: 0, data: ascii('Fixture Camera') },
  ];

  const exif = [];
  if (spec.date) {
    const stamp = ascii(`${spec.date} ${spec.time}`);
    exif.push({ tag: 0x9003, type: TYPE_ASCII, count: 0, data: stamp });
    exif.push({ tag: 0x9004, type: TYPE_ASCII, count: 0, data: stamp });
  }
  if (spec.tz) exif.push({ tag: 0x9011, type: TYPE_ASCII, count: 0, data: ascii(spec.tz) });

  const gps = [];
  if (spec.place) {
    const { lat, lon } = PLACES[spec.place];
    gps.push({ tag: 0x0001, type: TYPE_ASCII, count: 2, data: ascii(lat >= 0 ? 'N' : 'S') });
    gps.push({ tag: 0x0002, type: TYPE_RATIONAL, count: 3, data: dms(lat) });
    gps.push({ tag: 0x0003, type: TYPE_ASCII, count: 2, data: ascii(lon >= 0 ? 'E' : 'W') });
    gps.push({ tag: 0x0004, type: TYPE_RATIONAL, count: 3, data: dms(lon) });
  }

  // ASCII counts include the terminating NUL.
  for (const entry of [...ifd0, ...exif]) if (!entry.count) entry.count = entry.data.length;

  const tiff = buildTiff({ ifd0, exif, gps });
  const payload = [...Buffer.from('Exif\0\0', 'latin1'), ...tiff];

  return [0xff, 0xe1, ...be16(payload.length + 2), ...payload];
}

// ── Main ─────────────────────────────────────────────────────────────────────

await rm(OUT_DIR, { recursive: true, force: true });
await mkdir(OUT_DIR, { recursive: true });

for (const spec of FIXTURES) {
  const tone = spec.tone ?? (spec.place ? PLACES[spec.place].tone : 0);
  const { head, body } = buildJpeg(tone);
  const jpeg = Uint8Array.from([...head, ...buildApp1(spec), ...body]);

  const path = join(OUT_DIR, `${spec.name}.jpg`);
  await writeFile(path, jpeg);

  if (spec.mtime) {
    const when = new Date(spec.mtime);
    await utimes(path, when, when);
  }
}

const located = FIXTURES.filter((f) => f.place).length;
console.log(
  `Wrote ${FIXTURES.length} fixtures to ./${OUT_DIR} ` +
    `(${located} geotagged, ${FIXTURES.length - located} without GPS)`,
);
