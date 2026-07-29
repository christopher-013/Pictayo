import { loadDisplay, loadVideo } from '../store/db';

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
const videoUrls = new Map<string, string>();

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

/**
 * Attaches playable sources to the videos in a freshly rendered day.
 *
 * Cards are rendered with a `data-video-id` and no `src`, so only the clips on
 * the day being viewed are ever pulled out of storage. Resolving every video in
 * a library up front would mean gigabytes of blob URLs alive at once.
 */
export async function attachVideoSources(root: ParentNode): Promise<void> {
  const elements = [...root.querySelectorAll<HTMLVideoElement>('video[data-video-id]')];

  await Promise.all(
    elements.map(async (element) => {
      const id = element.dataset.videoId;
      if (!id || element.src) return;

      const url = await videoUrlFor(id);

      if (!url) {
        element.closest('.photo-video-wrap')?.classList.add('is-missing');
        return;
      }

      // A source that attaches but will not decode — HEVC from an iPhone
      // outside Safari is the usual culprit — otherwise leaves an empty player
      // with controls that do nothing. Say so instead.
      element.addEventListener(
        'error',
        () => element.closest('.photo-video-wrap')?.classList.add('is-missing'),
        { once: true },
      );

      element.src = url;
    }),
  );
}

async function videoUrlFor(id: string): Promise<string | null> {
  const existing = videoUrls.get(id);
  if (existing) return existing;

  const blob = await loadVideo(id).catch(() => undefined);
  if (!blob) return null;

  const url = URL.createObjectURL(blob);
  videoUrls.set(id, url);
  return url;
}

export function revokeAll(): void {
  for (const url of thumbUrls.values()) URL.revokeObjectURL(url);
  for (const url of displayUrls.values()) URL.revokeObjectURL(url);
  for (const url of videoUrls.values()) URL.revokeObjectURL(url);
  thumbUrls.clear();
  displayUrls.clear();
  videoUrls.clear();
}
