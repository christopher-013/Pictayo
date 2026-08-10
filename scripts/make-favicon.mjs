/*
 * make-favicon.mjs — builds public/favicon.ico from the 512px mascot icon.
 *
 * Google reads the <link rel="icon"> PNGs, which is why pictayo.com already
 * shows a favicon there. Bing's icon service goes looking for /favicon.ico at
 * the site root and falls back to a generic globe when it 404s — so the root
 * file is what puts the mascot next to a Bing result. Declaring the .ico in the
 * head is not enough on its own; the convention is the path.
 *
 * Three entries at 16, 32 and 48 px. 48 is what Bing and Google render at on a
 * high-density screen, and without it the 32 gets upscaled and looks soft.
 *
 * The entries are PNG-compressed rather than BMP. That is legal ICO and is
 * understood by every browser and crawler that matters, and it keeps the file
 * a few hundred bytes instead of a few thousand.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const PUBLIC = join(process.cwd(), 'public');
const SOURCE = join(PUBLIC, 'icon-512.png');
const OUTPUT = join(PUBLIC, 'favicon.ico');
const SIZES = [16, 32, 48];

/**
 * Wraps already-encoded PNGs in an ICO container.
 *
 * The directory is fixed-width, so every image offset is known before any image
 * is written: six bytes of header, then sixteen per entry, then the payloads in
 * the same order.
 */
function icoFromPngs(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);            // reserved
  header.writeUInt16LE(1, 2);            // 1 = icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;

  images.forEach(({ size, data }, index) => {
    const at = index * 16;
    // 256 is stored as 0; nothing here is that large, but the rule is the rule.
    directory.writeUInt8(size >= 256 ? 0 : size, at);
    directory.writeUInt8(size >= 256 ? 0 : size, at + 1);
    directory.writeUInt8(0, at + 2);     // palette size, 0 for truecolour
    directory.writeUInt8(0, at + 3);     // reserved
    directory.writeUInt16LE(1, at + 4);  // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });

  return Buffer.concat([header, directory, ...images.map((image) => image.data)]);
}

const source = readFileSync(SOURCE);
const images = [];
for (const size of SIZES) {
  images.push({
    size,
    data: await sharp(source)
      .resize(size, size, { fit: 'cover', kernel: 'lanczos3' })
      .png({ compressionLevel: 9 })
      .toBuffer(),
  });
}

writeFileSync(OUTPUT, icoFromPngs(images));
console.log(`favicon.ico written: ${SIZES.join(', ')}px entries, ${readFileSync(OUTPUT).length} bytes.`);
