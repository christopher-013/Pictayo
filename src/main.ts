import './styles.css';

import type { DayGroup, Photo } from './types';
import { wirePicker } from './import/picker';
import { ingestFiles } from './import/ingest';
import { buildLibrary, enrichLandmarks } from './library';
import { CachedGeocoder, CacheOnlyGeocoder, type Geocoder } from './geo/geocode';
import { OverpassLandmarkFinder } from './geo/landmark';
import {
  clearLibrary,
  deletePhotos,
  loadPhotos,
  loadThumbs,
  requestPersistence,
  savePhotos,
  type PersistedPhoto,
  type PhotoRecord,
} from './store/db';
import { initLightbox } from './ui/lightbox';
import { initDayView, setDays } from './ui/dayView';
import { revokeAll, revokePhoto, thumbUrlFor } from './ui/media';
import { exportSite } from './export/exportSite';
import { confirmAction, initConfirmDialog } from './ui/confirmDialog';
import { initFeedback } from './ui/feedback';

/** Flush to IndexedDB in batches so a large import survives an early tab close. */
const SAVE_BATCH_SIZE = 24;
const LANDING_PRIVACY =
  'Media stays on this device. Location coordinates are shared with map and place-name services when geotags are available.';

const photos = new Map<string, PersistedPhoto>();
const thumbs = new Map<string, Blob>();
const geocoder = new CachedGeocoder();
/** Builds the first gallery pass without waiting for any network requests. */
const localOnlyGeocoder = new CacheOnlyGeocoder();
const landmarkFinder = new OverpassLandmarkFinder();
const LOCATION_STATUS_DELAY_MS = 450;

let days: DayGroup[] = [];
let busy = false;
let enriching = false;

const el = {
  landing: must('landing'),
  landingNote: must('landing-note'),
  landingProgress: must('landing-progress'),
  landingProgressBar: must('landing-progress-bar'),
  landingProgressFill: must('landing-progress-fill'),
  landingProgressLabel: must('landing-progress-label'),
  landingLearn: must<HTMLDetailsElement>('landing-learn'),

  header: must('app-header'),
  main: must('app-main'),
  page: must('day-page'),
  nav: must('day-nav'),

  progress: must('progress'),
  progressBar: must('progress-bar'),
  progressFill: must('progress-fill'),
  progressLabel: must('progress-label'),
  summary: must('library-summary'),

  add: must('btn-add'),
  addFolder: must('btn-add-folder'),
  addMore: must('btn-add-more'),
  addFolderMore: must('btn-add-folder-more'),
  export: must<HTMLButtonElement>('btn-export'),
  clear: must<HTMLButtonElement>('btn-clear'),

  dropOverlay: must('drop-overlay'),
  fileInput: must<HTMLInputElement>('file-input'),
  folderInput: must<HTMLInputElement>('folder-input'),
};

void start();

async function start(): Promise<void> {
  initConfirmDialog();
  initFeedback();
  initLightbox();
  initDayView(el.nav, el.page, (photoId) => void handleRemovePhoto(photoId));

  wirePicker(
    {
      fileInput: el.fileInput,
      folderInput: el.folderInput,
      addButtons: [el.add, el.addMore],
      addFolderButtons: [el.addFolder, el.addFolderMore],
      dropOverlay: el.dropOverlay,
    },
    (files) => void handleFiles(files),
  );

  el.export.addEventListener('click', () => void handleExport());
  el.clear.addEventListener('click', () => void handleClear());

  await restore();
}

/** Rehydrates the library saved by a previous visit. */
async function restore(): Promise<void> {
  try {
    const [saved, savedThumbs] = await Promise.all([loadPhotos(), loadThumbs()]);
    for (const photo of saved) photos.set(photo.id, photo);
    for (const [id, blob] of savedThumbs) thumbs.set(id, blob);
  } catch (error) {
    console.warn('Could not read the saved library', error);
  }

  if (photos.size > 0) {
    await refresh();
    void enrichInBackground();
  } else {
    updateChrome();
  }
}

async function handleFiles(files: File[]): Promise<void> {
  if (busy) return;
  busy = true;
  el.landingNote.textContent = LANDING_PRIVACY;
  el.landingNote.hidden = true;
  setProgress(0, files.length, 'Reading photos…');

  const pending: PhotoRecord[] = [];
  let failures = 0;
  let storageFailures = 0;
  let locationStatusTimer: number | null = null;

  const persistPending = async (): Promise<void> => {
    if (pending.length === 0) return;
    const batch = pending.splice(0);

    try {
      await savePhotos(batch);
      for (const record of batch) {
        photos.set(record.photo.id, record.photo);
        if (record.thumb) thumbs.set(record.photo.id, record.thumb);
      }
    } catch (error) {
      storageFailures += batch.length;
      console.warn('Could not save imported media', error);
    }
  };

  try {
    await ingestFiles(files, {
      onResult: async (result) => {
        if (result.error) {
          failures += 1;
          return;
        }

        const photo: PersistedPhoto = {
          id: result.id,
          name: result.name,
          bytes: result.bytes,
          kind: result.kind,
          durationMs: result.durationMs ?? null,
          meta: result.meta,
          previewUnavailable: result.previewUnavailable,
        };

        pending.push({
          photo,
          thumb: result.thumb,
          display: result.display,
          video: result.video ?? null,
        });
        if (pending.length >= SAVE_BATCH_SIZE) {
          await persistPending();
        }
      },
      onProgress: ({ done, total, currentName }) => setProgress(done, total, currentName),
    });

    await persistPending();

    // Asked only after a real import, when the browser is most likely to grant it.
    void requestPersistence();

    setProgress(files.length, files.length, 'Preparing gallery…');

    // Paint photos and dates from local data immediately. Network-backed place
    // naming continues below, but can no longer leave the upload screen looking
    // frozen. Cached landmark and dining names still appear in this first pass.
    await refresh(true, localOnlyGeocoder);
    hideProgress();

    // Avoid flashing a status card for a warm-cache lookup. If the work takes
    // long enough to notice, keep the user informed until captions are updated.
    locationStatusTimer = window.setTimeout(
      () => showLocationProgress('Locations are processing… Photos and dates are ready.'),
      LOCATION_STATUS_DELAY_MS,
    );

    await refresh(false);
    await enrichInBackground(false);
    await refresh();
    window.clearTimeout(locationStatusTimer);
    locationStatusTimer = null;
    hideProgress();

    const notices: string[] = [];
    if (failures > 0) {
      notices.push(
        `${failures} file${failures === 1 ? '' : 's'} could not be read and ${failures === 1 ? 'was' : 'were'} skipped.`,
      );
    }
    if (storageFailures > 0) {
      notices.push(
        `${storageFailures} item${storageFailures === 1 ? '' : 's'} could not be saved locally and ${storageFailures === 1 ? 'was' : 'were'} not added. Check available browser storage and try again.`,
      );
    }
    if (notices.length > 0) setNotice(notices.join(' '));
  } finally {
    if (locationStatusTimer !== null) window.clearTimeout(locationStatusTimer);
    busy = false;
    hideProgress();
  }
}

async function refresh(render = true, locationGeocoder: Geocoder = geocoder): Promise<void> {
  const list: Photo[] = [...photos.values()].map((photo) => {
    const blob = thumbs.get(photo.id);
    return blob ? { ...photo, thumbUrl: thumbUrlFor(photo.id, blob) } : { ...photo };
  });

  days = await buildLibrary(list, locationGeocoder);
  if (!render) return;
  setDays(days);
  updateChrome();
}

/**
 * Names landmarks and possible nearby dining, then optionally rebuilds so
 * captions and pin labels pick them up.
 *
 * Restore and fresh imports use the background mode so photos remain usable
 * while the slower place-name services update their captions automatically.
 */
async function enrichInBackground(refreshAfter = true): Promise<void> {
  if (enriching || days.length === 0) return;
  enriching = true;

  try {
    const changed = await enrichLandmarks(days, landmarkFinder);
    if (changed && refreshAfter) await refresh();
  } catch (error) {
    // Enrichment is a nicety; area names are already on screen.
    console.warn('Place enrichment lookup failed', error);
  } finally {
    enriching = false;
  }
}

async function handleExport(): Promise<void> {
  if (busy || days.length === 0) return;
  busy = true;

  const label = el.export.textContent;
  el.export.disabled = true;
  el.export.textContent = 'Exporting…';

  try {
    const blob = await exportSite(days, {
      title: 'My Photo Map',
      onProgress: (done, total) => setProgress(done, total, 'Packaging photos…'),
    });

    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'picturepicture-site.zip';
    link.click();
    // Revoke on the next turn so the download has taken the reference.
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  } catch (error) {
    console.error('Export failed', error);
    setNotice('Export failed — see the browser console for details.');
  } finally {
    busy = false;
    hideProgress();
    el.export.disabled = false;
    el.export.textContent = label;
  }
}

async function handleClear(): Promise<void> {
  if (busy || photos.size === 0) return;

  const confirmed = await confirmAction({
    eyebrow: 'LOCAL LIBRARY',
    title: 'Clear PicturePicture?',
    message: `Remove all ${photos.size} imported item${photos.size === 1 ? '' : 's'} from this device?`,
    note: 'Your original files are untouched. This only clears the copies PicturePicture has stored in this browser.',
    confirmLabel: 'Clear imported items',
    icon: '🧹',
  });
  if (!confirmed) return;

  await clearLibrary().catch((e) => console.warn('Clear failed', e));

  revokeAll();
  photos.clear();
  thumbs.clear();
  days = [];

  setDays(days);
  updateChrome();
}

async function handleRemovePhoto(photoId: string): Promise<void> {
  if (busy) return;

  const photo = photos.get(photoId);
  if (!photo) return;

  const confirmed = await confirmAction({
    eyebrow: 'REMOVE IMPORT',
    title: 'Remove this item?',
    message: photo.name,
    note: 'Your original file will not be deleted. You can add it to PicturePicture again later.',
    confirmLabel: 'Remove from PicturePicture',
    icon: photo.kind === 'video' ? '🎬' : '🖼️',
  });
  if (!confirmed) return;

  busy = true;
  try {
    await deletePhotos([photoId]);
    revokePhoto(photoId);
    photos.delete(photoId);
    thumbs.delete(photoId);
    await refresh();
  } catch (error) {
    console.warn('Could not remove imported media', error);
    setNotice('Could not remove that item from PicturePicture. Please try again.');
  } finally {
    busy = false;
  }
}

/**
 * Swaps between the start screen and the library.
 *
 * Which one shows is derived from whether anything has been imported, so a
 * return visit with a saved library lands straight in the library and clearing
 * it goes back to the start screen.
 */
function updateChrome(): void {
  const count = photos.size;
  const hasPhotos = count > 0;

  el.landing.hidden = hasPhotos;
  el.landingLearn.hidden = hasPhotos;
  el.header.hidden = !hasPhotos;
  el.main.hidden = !hasPhotos;

  el.export.disabled = !hasPhotos;
  el.clear.disabled = !hasPhotos;

  // Normal library statistics were useful during development but added noise
  // to the public header. Keep this element only for exceptional notices.
  el.summary.textContent = '';
  el.summary.hidden = true;
}

/** Writes to whichever view is on screen — the start screen or the library. */
function setProgress(done: number, total: number, label: string): void {
  const value = total > 0 ? Math.round((done / total) * 100) : 0;
  const percent = `${value}%`;
  const text = `${label} — ${done} of ${total}`;

  if (!el.landing.hidden) {
    el.landingProgress.hidden = false;
    el.landingProgressBar.setAttribute('aria-valuenow', String(value));
    el.landingProgressBar.setAttribute('aria-valuetext', text);
    el.landingProgressFill.style.width = percent;
    el.landingProgressLabel.textContent = text;
  } else {
    el.progress.classList.remove('is-indeterminate');
    el.progress.hidden = false;
    el.progressBar.setAttribute('aria-valuenow', String(value));
    el.progressBar.setAttribute('aria-valuetext', text);
    el.progressFill.style.width = percent;
    el.progressLabel.textContent = text;
  }
}

function showLocationProgress(label: string): void {
  el.progress.hidden = false;
  el.progress.classList.add('is-indeterminate');
  el.progressBar.removeAttribute('aria-valuenow');
  el.progressBar.setAttribute('aria-valuetext', label);
  el.progressFill.style.width = '';
  el.progressLabel.textContent = label;
}

function hideProgress(): void {
  el.progress.classList.remove('is-indeterminate');
  el.progress.hidden = true;
  el.landingProgress.hidden = true;
}

/** Puts a message wherever the user is currently looking. */
function setNotice(text: string): void {
  if (!el.landing.hidden) {
    el.landingNote.hidden = false;
    el.landingNote.textContent = text;
  }
  else {
    el.summary.hidden = false;
    el.summary.textContent = text;
  }
}

function must<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}
