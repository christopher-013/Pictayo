# PicturePicture

Import your photos; the site organizes them by the day they were taken and plots
where each one was shot on a Google Map overlay.

Everything runs in the browser. Photos are never uploaded.

![grouped by day, pinned to a map](https://img.shields.io/badge/runs-entirely%20client--side-0f766e)

## What it does

1. **Import** — drag photos in, pick files, or pick a whole folder. On a phone,
   the same button opens the camera roll.
2. **Read metadata** — EXIF capture time, timezone offset, GPS, camera model,
   parsed in a Web Worker pool so a thousand-photo drop doesn't freeze the page.
3. **Group by day** — using the date the *camera* recorded, so a 1am Tokyo photo
   belongs to the Tokyo day rather than shifting with the viewer's timezone.
4. **Cluster by place** — nearby geotags collapse into a single map pin, so a day
   of 200 photos becomes a handful of places.
5. **Name those places** — one reverse-geocode lookup per cluster, cached locally.
6. **Caption** — from place, time of day, and cluster context.
7. **Export** — a self-contained static site you can publish anywhere.

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
  ui/       timeline, day sections, maps, cards, lightbox
  export/   static-site generator
```

`src/meta/datetime.ts` is worth reading before changing anything date-related —
capture times use a deliberate encoding that the comment there explains.
