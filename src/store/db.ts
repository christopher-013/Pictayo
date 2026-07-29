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

const DB_NAME = 'picturepicture';
/** v2 added the landmark cache; v3 discards it so nearby landmarks get found. */
const DB_VERSION = 3;

/** A cached Overpass answer. An empty name records "asked, nothing there". */
export interface CachedLandmark {
  key: string;
  name: string;
  kind: string;
  /** True when this was the nearest landmark rather than an enclosing one. */
  near?: boolean;
}

/** Runtime-only fields are stripped before persisting. */
export type PersistedPhoto = Omit<Photo, 'thumbUrl' | 'displayUrl' | 'caption'>;

interface PicturePictureDB extends DBSchema {
  photos: { key: string; value: PersistedPhoto };
  thumbs: { key: string; value: Blob };
  displays: { key: string; value: Blob };
  places: { key: string; value: Place };
  landmarks: { key: string; value: CachedLandmark };
}

let dbPromise: Promise<IDBPDatabase<PicturePictureDB>> | null = null;

/**
 * A version upgrade blocked by another connection never resolves *and never
 * errors* — IndexedDB simply waits. Every read and write in the app funnels
 * through here, so without a deadline the whole page appears to freeze with no
 * clue why. This turns that into a normal failure.
 */
const OPEN_TIMEOUT_MS = 10_000;

function getDB(): Promise<IDBPDatabase<PicturePictureDB>> {
  dbPromise ??= openWithDeadline();
  return dbPromise;
}

function openWithDeadline(): Promise<IDBPDatabase<PicturePictureDB>> {
  const open = openDB<PicturePictureDB>(DB_NAME, DB_VERSION, {
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
    },

    /**
     * Another tab is holding the old version open, so this upgrade can't run.
     * Nothing to do but say so — the deadline below turns it into an error.
     */
    blocked(currentVersion, blockedVersion) {
      console.warn(
        `PicturePicture: upgrade from v${currentVersion} to v${blockedVersion} is blocked ` +
          'by another tab. Close other PicturePicture tabs and reload.',
      );
    },

    /**
     * The mirror image: *this* connection is holding the old version open while
     * another tab tries to upgrade. Step aside so that tab isn't stuck the way
     * this one would have been.
     */
    blocking(_currentVersion, _blockedVersion, event) {
      (event.target as IDBPDatabase<PicturePictureDB>).close();
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
              'Timed out opening the local database. Another PicturePicture tab may be ' +
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
}

export async function savePhotos(records: PhotoRecord[]): Promise<void> {
  if (records.length === 0) return;
  const db = await getDB();
  const tx = db.transaction(['photos', 'thumbs', 'displays'], 'readwrite');

  for (const { photo, thumb, display } of records) {
    void tx.objectStore('photos').put(photo);
    if (thumb) void tx.objectStore('thumbs').put(thumb, photo.id);
    if (display) void tx.objectStore('displays').put(display, photo.id);
  }

  await tx.done;
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
  const tx = db.transaction(['photos', 'thumbs', 'displays'], 'readwrite');
  for (const id of ids) {
    void tx.objectStore('photos').delete(id);
    void tx.objectStore('thumbs').delete(id);
    void tx.objectStore('displays').delete(id);
  }
  await tx.done;
}

/** Clears photos but keeps the geocode cache — place names never go stale. */
export async function clearLibrary(): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['photos', 'thumbs', 'displays'], 'readwrite');
  await Promise.all([
    tx.objectStore('photos').clear(),
    tx.objectStore('thumbs').clear(),
    tx.objectStore('displays').clear(),
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
