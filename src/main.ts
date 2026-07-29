import './styles.css';

import type { DayGroup, Photo } from './types';
import { wirePicker } from './import/picker';
import { ingestFiles } from './import/ingest';
import { buildLibrary } from './library';
import { CachedGeocoder } from './geo/geocode';
import {
  clearLibrary,
  estimateUsageBytes,
  loadPhotos,
  loadThumbs,
  requestPersistence,
  savePhotos,
  type PersistedPhoto,
  type PhotoRecord,
} from './store/db';
import { initLightbox } from './ui/lightbox';
import { initDayView, setDays } from './ui/dayView';
import { revokeAll, thumbUrlFor } from './ui/media';
import { exportSite } from './export/exportSite';

/** Flush to IndexedDB in batches so a large import survives an early tab close. */
const SAVE_BATCH_SIZE = 24;

const photos = new Map<string, PersistedPhoto>();
const thumbs = new Map<string, Blob>();
const geocoder = new CachedGeocoder();

let days: DayGroup[] = [];
let busy = false;

const el = {
  page: must('day-page'),
  nav: must('day-nav'),
  dropzone: must('dropzone'),
  empty: must('library-empty'),
  progress: must('progress'),
  progressFill: must('progress-fill'),
  progressLabel: must('progress-label'),
  summary: must('library-summary'),
  add: must('btn-add'),
  addFolder: must('btn-add-folder'),
  export: must<HTMLButtonElement>('btn-export'),
  clear: must<HTMLButtonElement>('btn-clear'),
  fileInput: must<HTMLInputElement>('file-input'),
  folderInput: must<HTMLInputElement>('folder-input'),
};

void start();

async function start(): Promise<void> {
  initLightbox();
  initDayView(el.nav, el.page);

  wirePicker(
    {
      fileInput: el.fileInput,
      folderInput: el.folderInput,
      dropzone: el.dropzone,
      addButton: el.add,
      addFolderButton: el.addFolder,
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

  if (photos.size > 0) await refresh();
  else updateChrome();
}

async function handleFiles(files: File[]): Promise<void> {
  if (busy) return;
  busy = true;
  setProgress(0, files.length, 'Reading photos…');

  const pending: PhotoRecord[] = [];
  let failures = 0;

  try {
    await ingestFiles(files, {
      onResult: async (result) => {
        if (result.error) failures += 1;

        const photo: PersistedPhoto = {
          id: result.id,
          name: result.name,
          bytes: result.bytes,
          meta: result.meta,
          previewUnavailable: result.previewUnavailable,
        };

        photos.set(photo.id, photo);
        if (result.thumb) thumbs.set(photo.id, result.thumb);

        pending.push({ photo, thumb: result.thumb, display: result.display });
        if (pending.length >= SAVE_BATCH_SIZE) {
          await savePhotos(pending.splice(0)).catch((e) => console.warn('Save failed', e));
        }
      },
      onProgress: ({ done, total, currentName }) => setProgress(done, total, currentName),
    });

    if (pending.length > 0) {
      await savePhotos(pending).catch((e) => console.warn('Save failed', e));
    }

    // Asked only after a real import, when the browser is most likely to grant it.
    void requestPersistence();

    setProgress(files.length, files.length, 'Looking up places…');
    await refresh();

    if (failures > 0) {
      el.summary.textContent = `${failures} file${failures === 1 ? '' : 's'} could not be read and ${failures === 1 ? 'was' : 'were'} skipped.`;
    }
  } finally {
    busy = false;
    el.progress.hidden = true;
  }
}

async function refresh(): Promise<void> {
  const list: Photo[] = [...photos.values()].map((photo) => {
    const blob = thumbs.get(photo.id);
    return blob ? { ...photo, thumbUrl: thumbUrlFor(photo.id, blob) } : { ...photo };
  });

  days = await buildLibrary(list, geocoder);
  setDays(days);
  updateChrome();
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
    el.summary.textContent = 'Export failed — see the browser console for details.';
  } finally {
    busy = false;
    el.progress.hidden = true;
    el.export.disabled = false;
    el.export.textContent = label;
  }
}

async function handleClear(): Promise<void> {
  if (busy || photos.size === 0) return;

  const confirmed = confirm(
    `Remove all ${photos.size} photos from this device?\n\n` +
      'Your original files are untouched — this only clears what PicturePicture ' +
      'has stored in this browser.',
  );
  if (!confirmed) return;

  await clearLibrary().catch((e) => console.warn('Clear failed', e));

  revokeAll();
  photos.clear();
  thumbs.clear();
  days = [];

  setDays(days);
  updateChrome();
}

function updateChrome(): void {
  const count = photos.size;
  const hasPhotos = count > 0;

  el.empty.hidden = hasPhotos;
  el.export.disabled = !hasPhotos;
  el.clear.disabled = !hasPhotos;
  el.dropzone.classList.toggle('is-compact', hasPhotos);

  if (!hasPhotos) {
    el.summary.textContent = 'Photos are read in your browser and never uploaded.';
    return;
  }

  const located = [...photos.values()].filter((p) => p.meta.gps).length;
  const dayCount = days.length;

  void estimateUsageBytes().then((bytes) => {
    const size = bytes ? ` · ${formatBytes(bytes)} stored locally` : '';
    el.summary.textContent =
      `${count} photo${count === 1 ? '' : 's'} across ${dayCount} day${dayCount === 1 ? '' : 's'} · ` +
      `${located} with location${size}`;
  });
}

function setProgress(done: number, total: number, label: string): void {
  el.progress.hidden = false;
  el.progressFill.style.width = `${total > 0 ? (done / total) * 100 : 0}%`;
  el.progressLabel.textContent = `${label} — ${done} of ${total}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function must<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}
