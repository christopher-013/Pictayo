/**
 * Produces a stable content id without reading a multi-megabyte original into
 * memory. The beginning, middle, and end distinguish edited/burst images while
 * the exact byte length further reduces collisions between sampled files.
 */
const SAMPLE_BYTES = 256 * 1024;

export async function sampledPhotoId(file: Blob): Promise<string> {
  const slices = sampleSlices(file.size);
  const buffers = await Promise.all(
    slices.map(({ start, end }) => file.slice(start, end).arrayBuffer()),
  );
  const totalBytes = buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
  const sample = new Uint8Array(totalBytes);

  let offset = 0;
  for (const buffer of buffers) {
    sample.set(new Uint8Array(buffer), offset);
    offset += buffer.byteLength;
  }

  const digest = await crypto.subtle.digest('SHA-256', sample);
  const hex = [...new Uint8Array(digest).slice(0, 8)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

  return `${hex}${file.size.toString(16)}`;
}

function sampleSlices(size: number): Array<{ start: number; end: number }> {
  if (size <= SAMPLE_BYTES * 3) return [{ start: 0, end: size }];

  const middle = Math.max(0, Math.floor((size - SAMPLE_BYTES) / 2));
  return [
    { start: 0, end: SAMPLE_BYTES },
    { start: middle, end: middle + SAMPLE_BYTES },
    { start: size - SAMPLE_BYTES, end: size },
  ];
}
