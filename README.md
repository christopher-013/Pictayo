# PicturePicture

Import your photos; the site organizes them by the day they were taken and plots
where each one was shot on a Google Map overlay.

Everything runs in the browser. Photos are never uploaded.

![grouped by day, pinned to a map](https://img.shields.io/badge/runs-entirely%20client--side-0f766e)

## What it does

1. **Import** — a start screen with the logo and a single "Add photos" button.
   Drop files anywhere on the window, pick files, or pick a whole folder; on a
   phone the same button opens the camera roll. Once anything is imported the
   start screen gives way to the library, and a saved library skips it entirely
   on the next visit.
2. **Read metadata** — EXIF capture time, timezone offset, GPS, camera model,
   parsed in a Web Worker pool so a thousand-photo drop doesn't freeze the page.
3. **Group by day** — using the date the *camera* recorded, so a 1am Tokyo photo
   belongs to the Tokyo day rather than shifting with the viewer's timezone.
4. **Cluster by place** — nearby geotags collapse into a single map pin, so a day
   of 200 photos becomes a handful of places.
5. **Name those places** — one reverse-geocode lookup per cluster, cached locally.
6. **Caption** — from place, time of day, and cluster context.
7. **Browse** — one day per page, chosen from a date strip that runs oldest on
   the left to newest on the right. Each card names the places that day's photos
   were taken, busiest first, shortened to their most specific part — "Shinjuku,
   Tokyo" becomes "Shinjuku", since the broader half repeats across every day of
   a trip. The selected day lives in the URL hash, so the back button steps
   through days and a link to one survives a reload.
8. **Export** — a self-contained static site you can publish anywhere.

Each day renders on its own rather than as one long timeline: a few hundred
photos meant every day's maps and thumbnails were live at once. The day map
collapses too — click its header — and that preference is remembered across
days and visits, for when you want the grid and not the map.

## Running it

```bash
npm install
npm run dev
```

Generate test photos with known EXIF (no need for your own library):

```bash
npm run fixtures
```

That writes 13 JPEGs to `fixtures/` covering the interesting cases: a travel day
that crosses the Pacific, a day with two clusters, a photo with no GPS, and one
with no EXIF date at all.

Other scripts: `npm run build` (typecheck + production build), `npm run typecheck`.

## Branding

`brand/logo-source.png` is the master artwork. Nothing references it directly —
at 1.25MB it is larger than the whole app bundle — so `npm run brand` derives
what actually ships into `public/`: the circular mascot mark, favicons, an
Open Graph image, and the full logo used on the empty state.

Two things that script handles which are easy to get wrong by hand:

- The source's background is `rgb(254,254,254)`, not white. That one step is
  invisible alone but draws a faint rectangle around the logo on a white card,
  and no encoder setting fixes it — even lossless WebP preserves the 254
  faithfully. The pixels are normalised to `#ffffff` before encoding.
- The mascot crop was picked by rendering candidates *at favicon size*. Framings
  that included the whole photo-and-map composition turned to mush at 40px.

Brand colours are sampled from the artwork: teal `#01a5ab`, purple `#6559e9`.
The teal is used as `--brand-teal: #019aa0` — the same hue nudged just dark
enough to clear 3:1 contrast on the pale header, which the raw value misses.
Functional teals are darker still so body text and white-on-colour stay legible.

## How the map works

There is **no Google Maps API key**, no billing account, and no map library.

The basemap is a plain `<iframe>` pointed at Google's keyless embed
(`maps.google.com/maps?ll=…&output=embed`) with `pointer-events: none`. Pins are
ordinary HTML buttons positioned on top of it by projecting each coordinate with
the same Web Mercator maths Google uses — 256px tiles, world size doubling per
zoom level. Zoom is fitted twice: once when the markup is built, then again
against the real canvas once it has been laid out.

This technique is borrowed from the Tokyo2026 trip site, which is also where the
visual design comes from. The difference is that Tokyo2026's metadata was all
hand-authored — an 89KB literal table of capture times, hardcoded coordinates,
manually verified place names, fixed Tokyo map bounds. PicturePicture derives
every one of those from the files themselves, and works anywhere on Earth.

## Storage

Original files are **not** kept. A 500-photo library of originals would run to
several gigabytes, so IndexedDB stores metadata plus two derivatives per photo:
a 320px thumbnail for the grid and a 1600px version for the lightbox and export
(roughly 150MB for 500 photos).

Your library therefore survives a refresh and comes back on your next visit to
the same browser. **To get true full-resolution files back, re-import them** —
PicturePicture is a viewer for your photos, not a home for them. Your originals
are never modified or moved.

## Privacy

Photos are read locally and never uploaded.

The app makes exactly one kind of outbound request: a reverse-geocode lookup to
name a place cluster. It sends a coordinate and nothing else — no image data, no
filenames, no timestamps — once per cluster, cached afterwards. A 500-photo
import typically means fewer than twenty lookups. If those requests fail or
you're offline, clusters fall back to showing their coordinates and everything
else still works.

## About the captions

Captions are built from metadata alone, so they describe **where and when** a
photo was taken, never what is in it:

> Afternoon at Takadanobaba, Tokyo. One of 12 photos from this spot, 4:42–5:33 PM.

Metadata simply doesn't know that the photo shows kids eating conveyor-belt
sushi. Scene descriptions would need a vision model, which would mean an API key
and sending your photos to a third party — deliberately not part of this build.

The door is left open: `src/meta/describe.ts` defines a `DescriptionProvider`
interface, and `MetadataDescriber` is just one implementation. Adding a
vision-model provider means writing one new file and passing it to
`buildLibrary` — no changes to the pipeline, storage, or UI.

## Exporting

**Export site** downloads a ZIP containing `index.html`, `assets/photos/`, and a
README. Open it straight off disk, or publish the folder as-is to GitHub Pages
or any static host — there is no build step.

Pin positions are baked into the exported HTML as percentages, so the maps are
correct even with JavaScript disabled. The small inline script only powers
filtering and the lightbox.

## Deploying

The build is four static files — no server, no API keys, no environment
variables. Anything that serves static files will host it.

### GitHub Pages

`.github/workflows/deploy.yml` builds and publishes on every push. One-time
setup: **Settings → Pages → Source → GitHub Actions**.

The type check runs first, so a type error fails the deploy instead of shipping
a broken bundle.

Project sites serve from `<user>.github.io/<repo>/`, and a sub-path is where
static builds usually break. This one doesn't: `vite.config.ts` sets
`base: './'`, and the ingest worker is loaded via `new URL(…, import.meta.url)`,
so both resolve against wherever the app is actually mounted. Verified by
serving a production build from a `/PicturePicture/` prefix and running a full
import against it.

No `.nojekyll` is needed — nothing in `dist/` is underscore-prefixed.

**One thing to set once the domain is fixed:** the `og:image` tag in
`index.html` is a relative path, because the final URL isn't known yet. The Open
Graph spec wants an absolute one, and most crawlers won't resolve a relative
path — so link previews will show no image until it reads something like
`https://christopher-013.github.io/PicturePicture/og-image.png`. Everything else
is deliberately relative and should stay that way.

### Cloudflare Pages

| Setting | Value |
| --- | --- |
| Build command | `npm run build` |
| Output directory | `dist` |
| Node version | from `.nvmrc` |

### Serving requirements

- **Must be served over HTTP(S).** Opening `dist/index.html` from the filesystem
  won't work: the content-hash dedupe uses `crypto.subtle`, which browsers only
  expose in a secure context. Use `npm run preview` locally. (This does *not*
  apply to an exported album — that's plain HTML and opens straight off disk.)
- **Don't set `Cross-Origin-Embedder-Policy: require-corp`.** No host sets it by
  default, but it would block the Google Maps iframe. No custom headers needed.
- **Storage is per-origin.** A library built on one domain doesn't follow you to
  another — moving means re-importing. Worth settling on the final domain before
  building up a large library.

## Known limitations

- **HEIC on desktop.** iPhone originals are HEIC. Metadata reads fine, but most
  browsers outside Safari can't decode the pixels — those photos keep their date
  and map position but show a placeholder tile instead of a thumbnail. Importing
  from an iPhone is unaffected: iOS converts to JPEG through the file picker.
- **Timezones are shown as offsets** (`UTC+09:00`), not names like `JST`. EXIF
  records only the offset, and mapping one back to a named zone is ambiguous.
- **Photos with no GPS** are grouped and displayed normally, just absent from the
  map. The day's badge counts only geotagged photos.
- **Fallback dates.** With no EXIF date, the file's modification time is used and
  the caption says so — a copied or re-encoded file can carry a timestamp that
  has nothing to do with when the photo was taken.

## Layout

```
src/
  import/   file selection, worker pool, per-file ingest worker
  meta/     EXIF parsing, capture-time handling, caption generation
  geo/      Mercator projection, distance clustering, reverse geocoding
  store/    IndexedDB
  ui/       day pager, day sections, maps, cards, lightbox
  export/   static-site generator
```

`src/meta/datetime.ts` is worth reading before changing anything date-related —
capture times use a deliberate encoding that the comment there explains.
