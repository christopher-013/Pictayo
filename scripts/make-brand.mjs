/**
 * Generates the site's brand assets from `brand/logo-source.png`.
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

const SRC = 'brand/logo-source.png';
const OUT = 'public';

/** Mascot head plus the camera it's holding. */
const MASCOT = { left: 600, top: 140, width: 450, height: 450 };

/** Full composition, trimmed of the generous whitespace around it. */
const FULL = { left: 172, top: 122, width: 1216, height: 730 };

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
async function makeTransparent(pipeline) {
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

/**
 * Ink colour for the wireframe mark, as [r, g, b] — the deep brand teal.
 */
const WIRE_INK = [12, 81, 87];

/** Multiplies the edge signal; thin pencil lines are faint without it. */
const WIRE_GAIN = 2.6;

/** Edges below this are noise from the artwork's soft shading. */
const WIRE_FLOOR = 18;

/**
 * Renders the artwork as line art.
 *
 * The header sits directly above the date strip and the photos, and the full
 * colour logo — a dog, a photo, a folded map, a two-tone wordmark — is a lot of
 * competing detail in that position. Reducing it to outlines keeps the shape
 * recognisable while letting the page below it hold the attention.
 *
 * Done with a Sobel gradient rather than a threshold, because the artwork is
 * only *partly* outlined: the mascot and the map have black linework, but the
 * wordmark is solid colour with no outline at all, and a brightness threshold
 * would either drop the letters or fill them in solid. A gradient responds to
 * any edge, so the letters come back as outlines like everything else.
 */
async function makeWireframe(pipeline) {
  // Flattened to white first, so gradients come from the drawing rather than
  // from the alpha channel's own hard edge.
  const { data, info } = await pipeline
    .clone()
    .flatten({ background: '#ffffff' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height } = info;
  const at = (x, y) => data[Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))];

  const out = Buffer.alloc(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const gx =
        -at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1) +
        at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1);
      const gy =
        -at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1) +
        at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1);

      const magnitude = Math.hypot(gx, gy) / 4;
      const alpha = magnitude < WIRE_FLOOR ? 0 : Math.min(255, Math.round(magnitude * WIRE_GAIN));

      const i = (y * width + x) * 4;
      out[i] = WIRE_INK[0];
      out[i + 1] = WIRE_INK[1];
      out[i + 2] = WIRE_INK[2];
      out[i + 3] = alpha;
    }
  }

  return sharp(out, { raw: { width, height, channels: 4 } });
}

await mkdir(OUT, { recursive: true });

const mascotAt = (size) =>
  snapWhite(sharp(SRC).extract(MASCOT).flatten({ background: '#ffffff' }).resize(size, size));

// Header brand mark. 192px covers a ~48px slot at 4x, and doubles as the
// mark inlined into exported albums.
await (await mascotAt(192)).webp({ quality: 90 }).toFile(`${OUT}/mark.webp`);

// Favicons stay PNG: still the safest bet for tab icons, and Apple's
// home-screen icon wants an opaque background rather than transparency.
await (await mascotAt(48)).png({ compressionLevel: 9 }).toFile(`${OUT}/favicon.png`);
await (await mascotAt(180)).png({ compressionLevel: 9 }).toFile(`${OUT}/apple-touch-icon.png`);

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

// Line-art version for the app header, where the full-colour logo is too busy.
await (await makeWireframe(sharp(SRC).extract(FULL).resize(760)))
  .webp({ quality: 88, alphaQuality: 100 })
  .toFile(`${OUT}/logo-wire.webp`);

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

for (const f of ['mark.webp', 'favicon.png', 'apple-touch-icon.png', 'logo.webp', 'logo-wire.webp', 'og-image.png']) {
  console.log(`${f.padEnd(22)} ${(statSync(`${OUT}/${f}`).size / 1024).toFixed(1)} KB`);
}
