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

export function isImageFile(file: File): boolean {
  if (file.type.startsWith('image/')) return true;
  if (file.type) return false;

  const ext = file.name.split('.').pop()?.toLowerCase();
  return ext ? IMAGE_EXTENSIONS.has(ext) : false;
}

export function imageFilesFrom(files: Iterable<File>): File[] {
  const seen = new Set<string>();
  const out: File[] = [];

  for (const file of files) {
    if (!isImageFile(file)) continue;
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
  dropzone: HTMLElement;
  addButton: HTMLElement;
  addFolderButton: HTMLElement;
}

export function wirePicker(
  handles: PickerHandles,
  onFiles: (files: File[]) => void,
): void {
  const { fileInput, folderInput, dropzone, addButton, addFolderButton } = handles;

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

  addButton.addEventListener('click', () => fileInput.click());
  addFolderButton.addEventListener('click', () => folderInput.click());

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      fileInput.click();
    }
  });

  // Dragover must be cancelled on both the zone and the document, otherwise the
  // browser navigates away to the dropped file.
  const stop = (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };

  document.addEventListener('dragover', (event) => event.preventDefault());
  document.addEventListener('drop', (event) => event.preventDefault());

  dropzone.addEventListener('dragenter', (event) => {
    stop(event);
    dropzone.classList.add('is-dragover');
  });

  dropzone.addEventListener('dragover', (event) => {
    stop(event);
    dropzone.classList.add('is-dragover');
  });

  dropzone.addEventListener('dragleave', (event) => {
    stop(event);
    if (!dropzone.contains(event.relatedTarget as Node | null)) {
      dropzone.classList.remove('is-dragover');
    }
  });

  dropzone.addEventListener('drop', async (event) => {
    stop(event);
    dropzone.classList.remove('is-dragover');

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
