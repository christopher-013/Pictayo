import { defineConfig, type Plugin } from 'vite';

/**
 * Lets the dev server render, without loosening the policy that ships.
 *
 * index.html carries the production Content Security Policy, and `style-src
 * 'self'` is correct for the build: Vite emits a linked stylesheet and the
 * built HTML contains no inline styles at all. During `vite dev`, though,
 * styles are injected as inline `<style>` blocks, which that policy blocks —
 * leaving the dev server completely unstyled and the release checklist's manual
 * browser pass unable to verify anything it asks a reviewer to look at.
 *
 * Relaxing it here rather than in index.html keeps the committed policy the
 * real one, and keeps the temptation to add `'unsafe-inline'` to the shipped
 * page — which would weaken production to fix a dev-only problem — off the
 * table.
 */
function devStylePolicy(): Plugin {
  return {
    name: 'pictayo:dev-style-policy',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace(/style-src 'self'/, "style-src 'self' 'unsafe-inline'");
    },
  };
}

// `base` is relative so a build can be dropped into a GitHub Pages project
// subpath (e.g. /Pictayo/) without rewriting asset URLs.
export default defineConfig({
  base: './',
  plugins: [devStylePolicy()],
  server: { port: 5273 },
  build: {
    target: 'es2022',
    outDir: 'dist',
    // The ingest worker is emitted as its own chunk; keep names stable.
    rollupOptions: { output: { chunkFileNames: 'assets/[name]-[hash].js' } },
  },
  worker: { format: 'es' },
});
