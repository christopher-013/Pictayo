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
const DB_VERSION = 1;

/** Runtime-only fields are stripped before persisting. */
export type PersistedPhoto = Omit<Photo, 'thumbUrl' | 'displayUrl' | 'caption'>;

interface PicturePictureDB extends DBSchema {
  photos: { key: string; value: PersistedPhoto };
  thumbs: { key: string; value: Blob };
  displays: { key: string; value: Blob };
  places: { key: string; value: Place };
}

let dbPromise: Promise<IDBPDatabase<PicturePictureDB>> | null = null;

function getDB(): Promise<IDBPDatabase<PicturePictureDB>> {
  dbPromise ??= openDB<PicturePictureDB>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      db.createObjectStore('photos', { keyPath: 'id' });
      db.createObjectStore('thumbs');
      db.createObjectStore('displays');
      db.createObjectStore('places', { keyPath: 'key' });
    },
  });
  return dbPromise;
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
