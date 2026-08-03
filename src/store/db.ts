import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Photo, Place } from '../types';

/**
 * Local library storage.
 *
 * Blobs live in their own stores rather than on the photo record, so the
 * timeline can load every photo's metadata and thumbnail without pulling
 * hundreds of megabytes of full-size images into memory. `display` blobs are
 * fetched one at a time, only when the lightbox opens.
 */

// Keep the original database key so the Pictayo rebrand does not strand an
// existing user's locally imported library.
const DB_NAME = 'picturepicture';
/**
 * v2 added the landmark cache; v3 discards it so nearby landmarks get found;
 * v4 added video storage; v5 added nearby dining suggestions; v6 tightened the
 * cache precision; v7 allows a moderate amount of indoor GPS drift; v8 allows
 * dining cache records to retain the matched venue position for detail links;
 * v9 refreshes misses after expanding nearby landmark feature coverage; v10
 * refreshes matches after adding named districts and notability-based ranking;
 * v11 refreshes results after correcting overly broad photo clustering and
 * adds lookup timestamps so incomplete results can be retried; v12 refreshes
 * generic misses after adding the adaptable notable-place fallback; v13
 * refreshes results after correcting nearby memorial-versus-venue ranking.
 */
const DB_VERSION = 13;

/** A cached Overpass answer. An empty name records "asked, nothing there". */
export interface CachedLandmark {
  key: string;
  name: string;
  kind: string;
  /** True when this was the nearest landmark rather than an enclosing one. */
  near?: boolean;
  diningName?: string;
  diningKind?: string;
  diningDistanceMeters?: number;
  diningLat?: number;
  diningLon?: number;
  /** When Overpass last completed this lookup. */
  checkedAt?: number;
}

/** Runtime-only fields are stripped before persisting. */
export type PersistedPhoto = Omit<
  Photo,
  'thumbUrl' | 'displayUrl' | 'videoUrl' | 'caption' | 'clusterId'
>;

interface PictayoDB extends DBSchema {
  photos: { key: string; value: PersistedPhoto };
  thumbs: { key: string; value: Blob };
  displays: { key: string; value: Blob };
  places: { key: string; value: Place };
  landmarks: { key: string; value: CachedLandmark };
  /**
   * Videos are stored whole. Photos keep a small derivative instead, but a
   * video has no cheap equivalent — re-encoding one in the browser is out of
   * scope — and without the bytes it cannot be played back after a reload.
   */
  videos: { key: string; value: Blob };
}

let dbPromise: Promise<IDBPDatabase<PictayoDB>> | null = null;

/**
 * A version upgrade blocked by another connection never resolves *and never
 * errors* — IndexedDB simply waits. Every read and write in the app funnels
 * through here, so without a deadline the whole page appears to freeze with no
 * clue why. This turns that into a normal failure.
 */
const OPEN_TIMEOUT_MS = 10_000;

function getDB(): Promise<IDBPDatabase<PictayoDB>> {
  dbPromise ??= openWithDeadline();
  return dbPromise;
}

function openWithDeadline(): Promise<IDBPDatabase<PictayoDB>> {
  const open = openDB<PictayoDB>(DB_NAME, DB_VERSION, {
    // Guarded per version so an existing v1 library upgrades in place rather
    // than failing on stores that already exist.
    upgrade(db, oldVersion, _newVersion, transaction) {
      if (oldVersion < 1) {
        db.createObjectStore('photos', { keyPath: 'id' });
        db.createObjectStore('thumbs');
        db.createObjectStore('displays');
        db.createObjectStore('places', { keyPath: 'key' });
      }
      if (oldVersion < 2) {
        db.createObjectStore('landmarks', { keyPath: 'key' });
      }
      if (oldVersion === 2) {
        // v2 only looked for enclosing areas, so it recorded a miss for every
        // landmark mapped as a bare point. Those cached misses would block the
        // proximity lookup forever; drop them and ask again.
        transaction.objectStore('landmarks').clear();
      }
      if (oldVersion < 4) {
        db.createObjectStore('videos');
      }
      if (oldVersion < 5 && oldVersion >= 2) {
        // Older records cannot distinguish "no dining result" from "dining was
        // never queried". This store contains only disposable lookup cache data.
        transaction.objectStore('landmarks').clear();
      }
      if (oldVersion < 6 && oldVersion >= 2) {
        // v5 dining results used a 120 m radius and a ~110 m cache key. Clear
        // them so the stricter 10 m rule is applied immediately after upgrade.
        transaction.objectStore('landmarks').clear();
      }
      if (oldVersion < 7 && oldVersion >= 2) {
        // v6 cached misses from its overly strict 10 m dining search. Ask again
        // using the 30 m range while retaining the precise cache coordinates.
        transaction.objectStore('landmarks').clear();
      }
      if (oldVersion < 9 && oldVersion >= 2) {
        // v8's proximity query never requested amenity or building features,
        // even though its result picker supported them. Clear cached misses so
        // places such as Sensō-ji are resolved with the corrected query.
        transaction.objectStore('landmarks').clear();
      }
      if (oldVersion < 10 && oldVersion >= 2) {
        // v9 ranked a small gallery above every district regardless of context.
        // Re-run disposable lookups so street photos can resolve to a notable
        // district such as Ginza while major attractions remain preferred.
        transaction.objectStore('landmarks').clear();
      }
      if (oldVersion < 11 && oldVersion >= 2) {
        // Old 250 m cluster centroids could sit between distinct destinations
        // and cached those misses forever. Re-run from the corrected points.
        transaction.objectStore('landmarks').clear();
      }
      if (oldVersion < 12 && oldVersion >= 2) {
        // Retry generic ward fallbacks with nearby Wikipedia recognition.
        transaction.objectStore('landmarks').clear();
      }
      if (oldVersion < 13 && oldVersion >= 2) {
        // v12 could let a nearby documented memorial outrank the large venue
        // containing the camera. These lookups are disposable and must be
        // resolved again with the corrected destination ranking.
        transaction.objectStore('landmarks').clear();
      }
    },

    /**
     * Another tab is holding the old version open, so this upgrade can't run.
     * Nothing to do but say so — the deadline below turns it into an error.
     */
    blocked(currentVersion, blockedVersion) {
      console.warn(
        `Pictayo: upgrade from v${currentVersion} to v${blockedVersion} is blocked ` +
          'by another tab. Close other Pictayo tabs and reload.',
      );
    },

    /**
     * The mirror image: *this* connection is holding the old version open while
     * another tab tries to upgrade. Step aside so that tab isn't stuck the way
     * this one would have been.
     */
    blocking(_currentVersion, _blockedVersion, event) {
      (event.target as IDBPDatabase<PictayoDB>).close();
      dbPromise = null;
    },

    terminated() {
      dbPromise = null;
    },
  });

  return Promise.race([
    open,
    new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              'Timed out opening the local database. Another Pictayo tab may be ' +
                'holding an older version open — close it and reload.',
            ),
          ),
        OPEN_TIMEOUT_MS,
      ),
    ),
  ]).catch((error: unknown) => {
    // Let the next call try again rather than caching the failure forever.
    dbPromise = null;
    throw error;
  });
}

export interface PhotoRecord {
  photo: PersistedPhoto;
  thumb: Blob | null;
  display: Blob | null;
  video?: Blob | null;
}

export async function savePhotos(records: PhotoRecord[]): Promise<void> {
  if (records.length === 0) return;
  const db = await getDB();
  const tx = db.transaction(['photos', 'thumbs', 'displays', 'videos'], 'readwrite');

  for (const { photo, thumb, display, video } of records) {
    void tx.objectStore('photos').put(photo);
    if (thumb) void tx.objectStore('thumbs').put(thumb, photo.id);
    if (display) void tx.objectStore('displays').put(display, photo.id);
    if (video) void tx.objectStore('videos').put(video, photo.id);
  }

  await tx.done;
}

export async function loadVideo(id: string): Promise<Blob | undefined> {
  const db = await getDB();
  return db.get('videos', id);
}

export async function loadPhotos(): Promise<PersistedPhoto[]> {
  const db = await getDB();
  return db.getAll('photos');
}

/** Thumbnails for the whole library — small enough to hold all at once. */
export async function loadThumbs(): Promise<Map<string, Blob>> {
  const db = await getDB();
  const tx = db.transaction('thumbs', 'readonly');
  const store = tx.objectStore('thumbs');
  const [keys, values] = await Promise.all([store.getAllKeys(), store.getAll()]);

  const map = new Map<string, Blob>();
  keys.forEach((key, i) => {
    const value = values[i];
    if (value) map.set(String(key), value);
  });
  return map;
}

export async function loadDisplay(id: string): Promise<Blob | undefined> {
  const db = await getDB();
  return db.get('displays', id);
}

export async function deletePhotos(ids: string[]): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['photos', 'thumbs', 'displays', 'videos'], 'readwrite');
  for (const id of ids) {
    void tx.objectStore('photos').delete(id);
    void tx.objectStore('thumbs').delete(id);
    void tx.objectStore('displays').delete(id);
    void tx.objectStore('videos').delete(id);
  }
  await tx.done;
}

/** Clears media but keeps the geocode cache — place names never go stale. */
export async function clearLibrary(): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['photos', 'thumbs', 'displays', 'videos'], 'readwrite');
  await Promise.all([
    tx.objectStore('photos').clear(),
    tx.objectStore('thumbs').clear(),
    tx.objectStore('displays').clear(),
    tx.objectStore('videos').clear(),
    tx.done,
  ]);
}

export async function getCachedPlace(key: string): Promise<Place | undefined> {
  const db = await getDB();
  return db.get('places', key);
}

export async function putCachedPlace(place: Place): Promise<void> {
  const db = await getDB();
  await db.put('places', place);
}

export async function getCachedLandmark(key: string): Promise<CachedLandmark | undefined> {
  const db = await getDB();
  return db.get('landmarks', key);
}

export async function putCachedLandmark(landmark: CachedLandmark): Promise<void> {
  const db = await getDB();
  await db.put('landmarks', landmark);
}

/**
 * Ask the browser not to evict the library under storage pressure. Best effort —
 * some browsers grant it silently, others only after a user engagement signal.
 */
export async function requestPersistence(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export async function estimateUsageBytes(): Promise<number | null> {
  if (!navigator.storage?.estimate) return null;
  try {
    const { usage } = await navigator.storage.estimate();
    return usage ?? null;
  } catch {
    return null;
  }
}
