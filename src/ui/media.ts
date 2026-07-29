import { loadDisplay } from '../store/db';

/**
 * Object URL bookkeeping.
 *
 * Every URL handed out here is tracked so it can be revoked on clear or
 * re-render. Blob URLs pin their blob in memory until revoked, so leaking them
 * across a few re-renders of a large library is a real leak, not a tidiness
 * concern.
 */

const thumbUrls = new Map<string, string>();
const displayUrls = new Map<string, string>();

export function thumbUrlFor(id: string, blob: Blob): string {
  const existing = thumbUrls.get(id);
  if (existing) return existing;

  const url = URL.createObjectURL(blob);
  thumbUrls.set(id, url);
  return url;
}

/** Full-size blobs are fetched only when the lightbox actually needs one. */
export async function displayUrlFor(id: string): Promise<string | null> {
  const existing = displayUrls.get(id);
  if (existing) return existing;

  const blob = await loadDisplay(id).catch(() => undefined);
  if (!blob) return null;

  const url = URL.createObjectURL(blob);
  displayUrls.set(id, url);
  return url;
}

export function revokeAll(): void {
  for (const url of thumbUrls.values()) URL.revokeObjectURL(url);
  for (const url of displayUrls.values()) URL.revokeObjectURL(url);
  thumbUrls.clear();
  displayUrls.clear();
}
