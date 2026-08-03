# Pictayo reviewer guide

This file is for Claude Code and other automated reviewers. Read `README.md`,
`SECURITY.md`, and `AUDIT.md` before changing behavior.

## Fast orientation

- `src/main.ts` owns startup, restore, import progress, persistence, and chrome.
- `src/import/` extracts metadata and creates local image/video derivatives.
- `src/geo/` clusters coordinates and queries keyless place services.
- `src/library.ts` assembles days, regions, captions, landmarks, and dining.
- `src/ui/` renders the date navigation, maps, cards, dialogs, and lightbox.
- `src/export/exportSite.ts` creates a standalone multi-page ZIP album.
- `feedback-worker.js` is a separate text-only Cloudflare/GitHub Issues boundary.
- `scripts/smoke.mjs` is the main network-free regression and security suite.

## Required commands

```powershell
npm ci
npm audit --audit-level=high
npm run verify
git diff --check
```

Do not approve a release when any command fails. `dist/` and generated fixtures
are build artifacts and are not committed.

## Security invariants

1. Photo/video bytes never leave the browser. Only GPS coordinates go to place
   and map services.
2. Never add a token or API key to client code, HTML, Vite variables, tests, or
   committed configuration.
3. Treat filenames, EXIF strings, reverse-geocoder text, Overpass names, and
   feedback as untrusted. Escape before HTML-string rendering; prefer text nodes.
   Keep exported lightbox metadata in the inert `lb-data` JSON element and use
   `scriptSafeJson`; plain `JSON.stringify` does not neutralize `</script>`.
4. Preserve the CSP allowlist. Adding a new origin requires a documented data-
   flow/privacy reason and a regression test.
5. Every `target="_blank"` must use `rel="noopener noreferrer"`.
6. Feedback must remain in-app, text-only, origin restricted, rate limited, and
   server-side. Never fall back to a GitHub redirect.
7. Keep the GitHub token Issues-only and repository-scoped in Cloudflare's
   encrypted secret store.
8. Destructive controls remove only Pictayo's browser copies, never the
   user's original files.

## Performance invariants

- Render imported dates and media before network place enrichment finishes.
- Never read an entire large original merely to identify it; photo hashing is
  bounded and video hashing is sampled.
- Keep decode/encode work off the main thread for photos.
- Fetch full display blobs and original videos only when opened or exported.
- Avoid reassigning map iframe `src` unless center/zoom actually changed.

## Review priorities

Scrutinize new `innerHTML` sinks, external URLs, IndexedDB migrations, blob URL
lifetime, worker/message error handling, import cancellation, fetch timeouts,
cache invalidation, and exported-site escaping. Confirm desktop keyboard use and
phone touch/pinch behavior for every new interaction.

## Deployment

Pushes to `master` run `.github/workflows/deploy.yml` and publish `dist/` to
GitHub Pages. The feedback Worker is deployed separately with Wrangler; see
`FEEDBACK-WORKER-SETUP.md`. A Pages success does not prove the Worker secret is
configured, so validate feedback independently before declaring a release live.
