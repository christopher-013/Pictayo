/**
 * Escape a value for interpolation into HTML — attribute or text.
 *
 * This is load-bearing rather than cosmetic: filenames, EXIF camera strings and
 * geocoded place names are all attacker-influencable input that flows straight
 * into innerHTML when building cards and pins. A photo named
 * `"><img onerror=...>.jpg` must not become markup.
 */
export function escapeAttr(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
