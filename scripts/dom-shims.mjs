/**
 * Minimal browser shims so browser-shaped code can be smoke-tested in Node.
 *
 * Only `FileReader` so far: exifr reads a File through it, and Node has no such
 * global, so `readMeta` would silently fall back to the file timestamp and the
 * EXIF assertions would test nothing. This is a gap in the test environment,
 * not in the app — real browsers have FileReader.
 *
 * Deliberately tiny. If a test ever needs more of the DOM than this, that test
 * belongs in the browser pass instead.
 */

if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class FileReader {
    constructor() {
      this.result = null;
      this.error = null;
      this.readyState = 0;
      this.onload = null;
      this.onloadend = null;
      this.onerror = null;
      this.listeners = new Map();
    }

    addEventListener(type, handler) {
      this.listeners.set(type, handler);
    }

    removeEventListener(type) {
      this.listeners.delete(type);
    }

    #emit(type) {
      const event = { target: this, type };
      this[`on${type}`]?.(event);
      this.listeners.get(type)?.(event);
    }

    readAsArrayBuffer(blob) {
      blob
        .arrayBuffer()
        .then((buffer) => {
          this.result = buffer;
          this.readyState = 2;
          this.#emit('load');
          this.#emit('loadend');
        })
        .catch((error) => {
          this.error = error;
          this.readyState = 2;
          this.#emit('error');
          this.#emit('loadend');
        });
    }
  };
}
