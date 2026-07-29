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

// The full logo, shown large on the empty state.
await (await snapWhite(sharp(SRC).extract(FULL).flatten({ background: '#ffffff' }).resize(760)))
  .webp({ quality: 88 })
  .toFile(`${OUT}/logo.webp`);

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

for (const f of ['mark.webp', 'favicon.png', 'apple-touch-icon.png', 'logo.webp', 'og-image.png']) {
  console.log(`${f.padEnd(22)} ${(statSync(`${OUT}/${f}`).size / 1024).toFixed(1)} KB`);
}
