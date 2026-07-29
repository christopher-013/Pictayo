import { defineConfig } from 'vite';

// `base` is relative so a build can be dropped into a GitHub Pages project
// subpath (e.g. /PicturePicture/) without rewriting asset URLs.
export default defineConfig({
  base: './',
  server: { port: 5273 },
  build: {
    target: 'es2022',
    outDir: 'dist',
    // The ingest worker is emitted as its own chunk; keep names stable.
    rollupOptions: { output: { chunkFileNames: 'assets/[name]-[hash].js' } },
  },
  worker: { format: 'es' },
});
