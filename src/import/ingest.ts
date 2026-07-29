import type { IngestResult, MediaKind } from '../types';
import { isVideoFile } from './picker';
import { ingestVideo } from './videoIngest';

/**
 * Worker pool that turns selected files into ingest results.
 *
 * A pool rather than a single worker because decode + encode is CPU-bound, and
 * a thousand-photo import is an explicit design target.
 */

const MAX_WORKERS = 4;

export interface IngestProgress {
  done: number;
  total: number;
  currentName: string;
}

export interface IngestOptions {
  onResult: (result: IngestResult) => void | Promise<void>;
  onProgress?: (progress: IngestProgress) => void;
  signal?: AbortSignal;
}

export async function ingestFiles(files: File[], options: IngestOptions): Promise<void> {
  if (files.length === 0) return;

  // Photos go to the worker pool; videos have to stay on the main thread,
  // since a poster frame can only be painted from a <video> element and there
  // is no DOM in a worker. See ./videoIngest.ts.
  const videos = files.filter(isVideoFile);
  const images = files.filter((file) => !isVideoFile(file));

  let done = 0;
  const total = files.length;

  const report = (name: string) => {
    done += 1;
    options.onProgress?.({ done, total, currentName: name });
  };

  if (images.length > 0) {
    const poolSize = Math.max(
      1,
      Math.min(MAX_WORKERS, navigator.hardwareConcurrency || 2, images.length),
    );

    const workers = Array.from({ length: poolSize }, createWorker);
    const queue = images.map((file, index) => ({ id: `f${index}`, file }));

    try {
      await Promise.all(
        workers.map((worker) =>
          (async () => {
            for (;;) {
              if (options.signal?.aborted) return;

              const job = queue.shift();
              if (!job) return;

              const result = await runJob(worker, job.id, job.file);
              await options.onResult(result);
              report(job.file.name);
            }
          })(),
        ),
      );
    } finally {
      for (const worker of workers) worker.terminate();
    }
  }

  // Sequential: decoding several videos at once competes for the same hardware
  // decoder and is no faster.
  for (const file of videos) {
    if (options.signal?.aborted) return;

    try {
      await options.onResult(await ingestVideo(file));
    } catch (error) {
      await options.onResult(
        failure(file.name, file, error instanceof Error ? error.message : String(error), 'video'),
      );
    }

    report(file.name);
  }
}

function createWorker(): Worker {
  return new Worker(new URL('./ingest.worker.ts', import.meta.url), { type: 'module' });
}

function runJob(worker: Worker, id: string, file: File): Promise<IngestResult> {
  return new Promise((resolve) => {
    const onMessage = (event: MessageEvent<IngestResult>) => {
      cleanup();
      resolve(event.data);
    };

    const onError = (event: ErrorEvent) => {
      cleanup();
      resolve(failure(id, file, event.message || 'worker error', 'photo'));
    };

    function cleanup() {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
    }

    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.postMessage({ id, file });
  });
}

function failure(id: string, file: File, message: string, kind: MediaKind): IngestResult {
  return {
    id,
    name: file.name,
    bytes: file.size,
    kind,
    meta: {
      takenAt: null,
      tzOffsetMinutes: null,
      dayKey: null,
      gps: null,
      width: null,
      height: null,
      make: null,
      model: null,
      dateSource: 'none',
    },
    thumb: null,
    display: null,
    previewUnavailable: true,
    error: message,
  };
}
