/**
 * Generates Pictayo's production assets from the approved source artwork.
 *
 * The source is a 1536x1024 PNG weighing 1.25MB — an order of magnitude larger
 * than the entire app bundle — so nothing references it directly. This script
 * produces the derivatives that actually ship, into `public/`.
 *
 * Run: npm run brand   (requires the `sharp` devDependency)
 *
 * The mascot crop was chosen by rendering candidates and checking each at
 * favicon size: the head fills the frame and stays legible at 40px, which
 * framings that included the whole photo-and-map composition did not.
 */

import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
import { statSync } from 'node:fs';

const SRC = 'brand/pictayo-logo-source.png';
const OUT = 'public';
const BRAND_OUT = `${OUT}/assets/branding`;

/** Mascot head plus the camera it's holding. */
const MASCOT = { left: 365, top: 160, width: 570, height: 570 };

/** Full composition, trimmed of the generous whitespace around it. */
const FULL = { left: 58, top: 165, width: 1138, height: 910 };

/** Anything at least this bright in every channel counts as background. */
const WHITE_SNAP_THRESHOLD = 250;

/**
 * Snaps the near-white field to pure white.
 *
 * The source art's background is rgb(254,254,254), not #ffffff. That single
 * step is invisible on its own, but it draws a faint rectangle around the logo
 * wherever it sits on a genuinely white surface — which is exactly where the
 * empty state puts it. Encoder settings can't fix this: even lossless WebP
 * faithfully preserved the 254. Normalising the pixels first does, and costs
 * nothing at the same quality setting.
 */
async function snapWhite(pipeline) {
  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });

  for (let i = 0; i < data.length; i += info.channels) {
    if (
      data[i] >= WHITE_SNAP_THRESHOLD &&
      data[i + 1] >= WHITE_SNAP_THRESHOLD &&
      data[i + 2] >= WHITE_SNAP_THRESHOLD
    ) {
      data[i] = data[i + 1] = data[i + 2] = 255;
    }
  }

  return sharp(data, {
    raw: { width: info.width, height: info.height, channels: info.channels },
  });
}

/**
 * Makes the artwork's background transparent.
 *
 * A flood fill inward from the border, not a "delete every white pixel" pass —
 * the mascot is itself white, and a colour-keyed removal would punch holes
 * straight through the dog. The artwork is fully enclosed by dark outlines, so
 * a fill starting outside it stops at those edges and never gets in.
 *
 * The second pass softens the boundary: pixels the fill stopped against are
 * part of the anti-aliased ramp the art was drawn with against white, so they
 * get partial alpha instead of staying fully opaque. Without it the logo wears
 * a pale fringe wherever it sits on something that isn't white.
 */
async function makeTransparent(pipeline, includeWordmarkCounters = true) {
  const { data, info } = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;

  const FILL_THRESHOLD = 242;
  const RAMP_FLOOR = 205;

  const background = new Uint8Array(width * height);
  const stack = [];

  for (let x = 0; x < width; x++) {
    stack.push(x, x + (height - 1) * width);
  }
  for (let y = 0; y < height; y++) {
    stack.push(y * width, width - 1 + y * width);
  }

  const brightnessAt = (index) => {
    const i = index * channels;
    return Math.min(data[i], data[i + 1], data[i + 2]);
  };

  while (stack.length > 0) {
    const index = stack.pop();
    if (background[index]) continue;
    if (brightnessAt(index) < FILL_THRESHOLD) continue;

    background[index] = 1;

    const x = index % width;
    const y = (index / width) | 0;
    if (x > 0) stack.push(index - 1);
    if (x < width - 1) stack.push(index + 1);
    if (y > 0) stack.push(index - width);
    if (y < height - 1) stack.push(index + width);
  }

  // The border fill cannot reach counters enclosed by letter strokes. Limit a
  // second component pass to the wordmark band so the holes in both `p` and
  // both `e` letters become transparent without touching the mascot, photo,
  // map, or pin artwork above it.
  const WORDMARK_TOP = Math.floor(height * 0.58);
  const MIN_COUNTER_PIXELS = 50;
  const visited = new Uint8Array(width * height);

  for (let start = includeWordmarkCounters ? WORDMARK_TOP * width : background.length;
    start < background.length; start++) {
    if (background[start] || visited[start] || brightnessAt(start) < FILL_THRESHOLD) continue;

    const component = [];
    const componentStack = [start];
    visited[start] = 1;
    let touchesBandEdge = false;

    while (componentStack.length > 0) {
      const index = componentStack.pop();
      if (background[index] || brightnessAt(index) < FILL_THRESHOLD) continue;

      component.push(index);
      const x = index % width;
      const y = (index / width) | 0;
      if (x === 0 || x === width - 1 || y === WORDMARK_TOP || y === height - 1) {
        touchesBandEdge = true;
      }

      const neighbours = [];
      if (x > 0) neighbours.push(index - 1);
      if (x < width - 1) neighbours.push(index + 1);
      if (y > WORDMARK_TOP) neighbours.push(index - width);
      if (y < height - 1) neighbours.push(index + width);

      for (const neighbour of neighbours) {
        if (visited[neighbour]) continue;
        visited[neighbour] = 1;
        componentStack.push(neighbour);
      }
    }

    if (!touchesBandEdge && component.length >= MIN_COUNTER_PIXELS) {
      for (const index of component) background[index] = 1;
    }
  }

  for (let index = 0; index < background.length; index++) {
    if (background[index]) {
      data[index * channels + 3] = 0;
      continue;
    }

    // Only soften pixels the fill actually reached, so interior whites are safe.
    const x = index % width;
    const y = (index / width) | 0;
    const touchesBackground =
      (x > 0 && background[index - 1]) ||
      (x < width - 1 && background[index + 1]) ||
      (y > 0 && background[index - width]) ||
      (y < height - 1 && background[index + width]);

    if (!touchesBackground) continue;

    const brightness = brightnessAt(index);
    if (brightness <= RAMP_FLOOR) continue;

    const ramp = (FILL_THRESHOLD - brightness) / (FILL_THRESHOLD - RAMP_FLOOR);
    data[index * channels + 3] = Math.round(255 * Math.max(0, Math.min(1, ramp)));
  }

  return sharp(data, { raw: { width, height, channels } });
}

await mkdir(BRAND_OUT, { recursive: true });

const mascotAt = (size) =>
  snapWhite(sharp(SRC).extract(MASCOT).flatten({ background: '#ffffff' }).resize(size, size));
const transparentMascotAt = (size) =>
  makeTransparent(sharp(SRC).extract(MASCOT).resize(size, size), false);

// Header brand mark. 192px covers a ~48px slot at 4x, and doubles as the
// mark inlined into exported albums.
await (await transparentMascotAt(192)).webp({ quality: 90, alphaQuality: 100 }).toFile(`${OUT}/mark.webp`);
await (await transparentMascotAt(512)).png({ compressionLevel: 9 }).toFile(`${BRAND_OUT}/pictayo-mascot.png`);

// Favicons stay PNG: still the safest bet for tab icons, and Apple's
// home-screen icon wants an opaque background rather than transparency.
await (await mascotAt(48)).png({ compressionLevel: 9 }).toFile(`${OUT}/favicon.png`);
await (await mascotAt(180)).png({ compressionLevel: 9 }).toFile(`${OUT}/apple-touch-icon.png`);
await (await mascotAt(192)).png({ compressionLevel: 9 }).toFile(`${OUT}/icon-192.png`);
await (await mascotAt(512)).png({ compressionLevel: 9 }).toFile(`${OUT}/icon-512.png`);

// The full logo, on a transparent background so it can sit on the landing
// gradient and the app header without carrying a white rectangle around.
//
// Lossy colour with a lossless alpha channel: WebP stores the two separately,
// so `alphaQuality: 100` keeps the soft edge ramp exact while the artwork
// itself compresses normally. Fully lossless would be 219KB for no visible
// gain over 50KB.
await (await makeTransparent(sharp(SRC).extract(FULL).resize(760)))
  .webp({ quality: 82, alphaQuality: 100 })
  .toFile(`${OUT}/logo.webp`);

await (await makeTransparent(sharp(SRC).extract(FULL).resize(1000)))
  .png({ compressionLevel: 9 })
  .toFile(`${BRAND_OUT}/pictayo-logo.png`);

// Open Graph / link previews want a wide, opaque, absolutely-sized image.
await (
  await snapWhite(
    sharp(SRC)
      .extract(FULL)
      .flatten({ background: '#ffffff' })
      .resize(1200, 630, { fit: 'contain', background: '#ffffff' }),
  )
)
  .png({ compressionLevel: 9, palette: true })
  .toFile(`${OUT}/og-image.png`);

for (const f of [
  'mark.webp',
  'favicon.png',
  'apple-touch-icon.png',
  'icon-192.png',
  'icon-512.png',
  'logo.webp',
  'assets/branding/pictayo-logo.png',
  'assets/branding/pictayo-mascot.png',
  'og-image.png',
]) {
  console.log(`${f.padEnd(22)} ${(statSync(`${OUT}/${f}`).size / 1024).toFixed(1)} KB`);
}
