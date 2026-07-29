/**
 * File selection: the button inputs, the dropzone, and folder import.
 *
 * All of it funnels through {@link imageFilesFrom}, because a folder drop or a
 * `webkitdirectory` pick sweeps up plenty of things that are not photos.
 */

/** Extensions worth trying when the OS reports no MIME type — Windows commonly
 *  leaves `type` empty for HEIC, and browsers vary on RAW formats. */
const IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'jpe', 'png', 'webp', 'gif', 'bmp', 'avif',
  'heic', 'heif', 'tif', 'tiff', 'dng',
]);

const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'm4v', 'webm', 'avi', '3gp', 'mkv']);

export function isVideoFile(file: File): boolean {
  if (file.type.startsWith('video/')) return true;
  if (file.type) return false;

  const ext = file.name.split('.').pop()?.toLowerCase();
  return ext ? VIDEO_EXTENSIONS.has(ext) : false;
}

export function isImageFile(file: File): boolean {
  if (file.type.startsWith('image/')) return true;
  if (file.type) return false;

  const ext = file.name.split('.').pop()?.toLowerCase();
  return ext ? IMAGE_EXTENSIONS.has(ext) : false;
}

export function isMediaFile(file: File): boolean {
  return isImageFile(file) || isVideoFile(file);
}

export function imageFilesFrom(files: Iterable<File>): File[] {
  const seen = new Set<string>();
  const out: File[] = [];

  for (const file of files) {
    if (!isMediaFile(file)) continue;
    // macOS resource forks and Windows thumbnail caches ride along in folders.
    if (file.name.startsWith('._') || file.name === 'Thumbs.db') continue;
    if (file.size === 0) continue;

    // Cheap in-batch dedupe; the content hash in the worker catches the rest.
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push(file);
  }

  return out;
}

export interface PickerHandles {
  fileInput: HTMLInputElement;
  folderInput: HTMLInputElement;
  /** Every control that should open the file picker. */
  addButtons: HTMLElement[];
  addFolderButtons: HTMLElement[];
  /** Shown while a drag is over the window. */
  dropOverlay: HTMLElement;
}

export function wirePicker(handles: PickerHandles, onFiles: (files: File[]) => void): void {
  const { fileInput, folderInput, addButtons, addFolderButtons, dropOverlay } = handles;

  const emit = (list: FileList | null) => {
    const files = imageFilesFrom(list ?? []);
    if (files.length > 0) onFiles(files);
  };

  fileInput.addEventListener('change', () => {
    emit(fileInput.files);
    // Reset so picking the same files again still fires a change event.
    fileInput.value = '';
  });

  folderInput.addEventListener('change', () => {
    emit(folderInput.files);
    folderInput.value = '';
  });

  for (const button of addButtons) button.addEventListener('click', () => fileInput.click());
  for (const button of addFolderButtons) button.addEventListener('click', () => folderInput.click());

  // The whole window is the drop target, so photos can be dropped from either
  // the start screen or the library view without aiming at a particular box.
  //
  // dragenter/dragleave fire for every element the cursor crosses, so a plain
  // toggle flickers constantly. Counting entries against leaves is what keeps
  // the overlay steady.
  let dragDepth = 0;

  const showOverlay = (visible: boolean) => {
    dropOverlay.classList.toggle('is-active', visible);
    dropOverlay.setAttribute('aria-hidden', String(!visible));
  };

  const carriesFiles = (event: DragEvent) =>
    Array.from(event.dataTransfer?.types ?? []).includes('Files');

  window.addEventListener('dragenter', (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
    showOverlay(true);
  });

  // Without preventDefault on dragover the browser refuses the drop and
  // navigates to the file instead.
  window.addEventListener('dragover', (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
  });

  window.addEventListener('dragleave', (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) showOverlay(false);
  });

  window.addEventListener('drop', async (event) => {
    event.preventDefault();
    dragDepth = 0;
    showOverlay(false);

    const items = event.dataTransfer?.items;
    const files = items
      ? await filesFromDataTransfer(items)
      : Array.from(event.dataTransfer?.files ?? []);

    const images = imageFilesFrom(files);
    if (images.length > 0) onFiles(images);
  });
}

/**
 * Expands dropped directories. `DataTransfer.files` flattens to nothing for a
 * dropped folder, so the entries API is the only way to get at its contents.
 */
async function filesFromDataTransfer(items: DataTransferItemList): Promise<File[]> {
  const entries: FileSystemEntry[] = [];
  const plainFiles: File[] = [];

  // The item list is neutered after the first await, so read it synchronously.
  for (const item of Array.from(items)) {
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry) entries.push(entry);
    else {
      const file = item.getAsFile();
      if (file) plainFiles.push(file);
    }
  }

  const collected: File[] = [...plainFiles];
  for (const entry of entries) await walkEntry(entry, collected);
  return collected;
}

async function walkEntry(entry: FileSystemEntry, out: File[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File | null>((resolve) => {
      (entry as FileSystemFileEntry).file(resolve, () => resolve(null));
    });
    if (file) out.push(file);
    return;
  }

  if (!entry.isDirectory) return;

  const reader = (entry as FileSystemDirectoryEntry).createReader();

  // readEntries returns at most ~100 per call and must be drained.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve) => {
      reader.readEntries(resolve, () => resolve([]));
    });
    if (batch.length === 0) return;
    for (const child of batch) await walkEntry(child, out);
  }
}
