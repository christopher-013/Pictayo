import type { IngestResult } from '../types';

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

  const poolSize = Math.max(
    1,
    Math.min(MAX_WORKERS, navigator.hardwareConcurrency || 2, files.length),
  );

  const workers = Array.from({ length: poolSize }, createWorker);
  const queue = files.map((file, index) => ({ id: `f${index}`, file }));

  let done = 0;

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

            done += 1;
            options.onProgress?.({ done, total: files.length, currentName: job.file.name });
          }
        })(),
      ),
    );
  } finally {
    for (const worker of workers) worker.terminate();
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
      resolve(failure(id, file, event.message || 'worker error'));
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

function failure(id: string, file: File, message: string): IngestResult {
  return {
    id,
    name: file.name,
    bytes: file.size,
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
