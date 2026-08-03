# PicturePicture

Import your photos; the site organizes them by the day they were taken and plots
where each one was shot on a Google Map overlay.

Everything runs in the browser and media files are never uploaded. Geotag
coordinates are shared with map and place-name services as described in
[Privacy](#privacy).

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
6. **Name the landmark** — reverse geocoding answers "which district is this?",
   which is true but rarely what the photo is *of*. A second pass asks which
   mapped areas *contain* the point, so photos shot in the stands say **Tokyo
   Dome** rather than Bunkyo-ku. See [Landmarks](#landmarks).
7. **Suggest nearby dining** — the same batched location lookup finds the
   nearest named restaurant, cafe, fast-food venue, or food court within 30m.
   It is always labeled as a possibility, not a claim about where the photo was
   taken.
8. **Caption** — from landmark, place, nearby dining, and time of day.
9. **Browse** — one day per page, chosen from a horizontally swipeable date
   strip that runs oldest on the left to newest on the right. Each card names
   the places that day's photos were taken, busiest first, shortened to their
   most specific part — "Shinjuku, Tokyo" becomes "Shinjuku", since the broader
   half repeats across every day of a trip. The selected day lives in the URL
   hash, so the back button steps through days and a link to one survives a
   reload. Photos open in a lightbox with click and button zoom on desktop,
   plus direct pinch zoom on touch screens.
10. **See everywhere** — a globe button after the dates opens one map containing
    every geotagged stop. Selecting a pin returns to the matching day.
11. **Export** — a self-contained static site you can publish anywhere, including
    the all-locations map as `everywhere.html`.

On a fresh upload, PicturePicture renders the photos and dates immediately from
local data. If place, landmark, and nearby-dining recognition takes longer than
a moment, the gallery shows a location-processing status and updates captions
automatically when recognition finishes. This keeps the library usable while
the network work continues. A failed enrichment service never blocks the
import; the final render falls back to the resolved area name.

Each day renders on its own rather than as one long timeline: a few hundred
photos meant every day's maps and thumbnails were live at once. Day maps start
expanded on every screen; click the header to collapse them, and the preference
is remembered across days and visits.

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

For release scrutiny, see [SECURITY.md](SECURITY.md) for the threat model and
reporting process, [AUDIT.md](AUDIT.md) for the latest public-beta audit, and
[CLAUDE.md](CLAUDE.md) for automated-review invariants and priorities.

## Releasing

```bash
npm run release              # validate, and report what a push would do
npm run release -- --push    # validate, then push
```

The pipeline regenerates fixtures, type checks, builds, and runs the smoke
suite, refusing to go further the moment anything fails. Pushing is opt-in
rather than automatic — a release script that publishes as a side effect of
being run is one mistyped command away from shipping the working tree.

Before pushing it also refuses a dirty tree, fetches, and stops if the remote
has commits you don't (`--allow-dirty` validates without publishing).

`npm run smoke` runs the checks on their own. They import the real modules —
Node 24 runs the TypeScript directly — and concentrate on what has actually
broken here: the map projection, day grouping across timezones, caption
wording, landmark ranking, HTML escaping, and whether the built output still
uses relative paths so a GitHub Pages sub-path works.

The suite has been mutation-tested: changing the tile size, the cluster radius,
the region-split threshold, the landmark ranking, or the HTML escaping each
makes it fail. A suite that cannot fail is worse than none.

Anything needing a DOM or IndexedDB is out of scope; the release output ends
with the short manual browser pass that covers it.

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
- Transparency is flood-filled from the outside, with a wordmark-only enclosed
  component pass for the counters inside the `p` and `e` letters. Restricting
  that pass to the text preserves the mascot's intentional white artwork.
- The mascot crop was picked by rendering candidates *at favicon size*. Framings
  that included the whole photo-and-map composition turned to mush at 40px.

Brand colours are sampled from the artwork: teal `#01a5ab`, purple `#6559e9`.
The teal is used as `--brand-teal: #019aa0` — the same hue nudged just dark
enough to clear 3:1 contrast on the pale header, which the raw value misses.
Functional teals are darker still so body text and white-on-colour stay legible.

## How the map works

There is **no Google Maps API key**, no billing account, and no map library.

The basemap is a plain `<iframe>` pointed at Google's keyless embed
(`maps.google.com/maps?ll=…&output=embed`). Pins are
ordinary HTML buttons positioned on top of it by projecting each coordinate with
the same Web Mercator maths Google uses — 256px tiles, world size doubling per
zoom level. Zoom is fitted twice: once when the markup is built, then again
against the real canvas once it has been laid out.

The +/− controls, desktop mouse wheel, and mobile pinch gesture update the map
zoom and reproject every photo pin together. Keeping those two operations in one
place prevents custom pins from drifting away from their Google Maps locations.

This technique is borrowed from the Tokyo2026 trip site, which is also where the
visual design comes from. The difference is that Tokyo2026's metadata was all
hand-authored — an 89KB literal table of capture times, hardcoded coordinates,
manually verified place names, fixed Tokyo map bounds. PicturePicture derives
every one of those from the files themselves, and works anywhere on Earth.

## Videos

Videos are imported alongside photos and sit in the same grid, in time order —
a clip shot between two stills appears between them.

In the grid a video is a **poster frame with a play badge**, not a player.
Clicking opens it in the lightbox, where it plays and where the arrows carry on
through the day across both kinds: photo, clip, photo. An inline `<video
controls>` in the grid would swallow the click for its own play button, so the
tile could never hand off to the viewer — and a page of live players is far
heavier than a page of stills.

They carry the same date grouping, map pins and captions as photos, because the
metadata is read the same way — from a different place:

- **EXIF doesn't apply.** MP4 and MOV keep their metadata in QuickTime atoms, so
  `src/meta/videoMeta.ts` walks the container directly. It prefers Apple's
  `com.apple.quicktime.creationdate`, the only source that records the *offset*
  the camera was in, and falls back to `moov/mvhd` (always UTC) then the file
  timestamp. Location comes from the ISO 6709 string iPhones write.
- **Poster frames are extracted on the main thread.** Photos are decoded in a
  worker, but the only way to get a still out of a video is to load it into a
  `<video>` element and paint a frame, and there is no DOM in a worker.
- **Videos are stored whole.** Photos keep a 1600px derivative; a video has no
  cheap equivalent, and without the bytes it cannot play after a reload. Expect
  a library with video to be much larger — the storage figure in the header
  counts it.
- **The file is only fetched when the lightbox needs it.** Grid tiles show a
  poster, so a library's worth of clips is never resolved at once — that would
  mean gigabytes of blob URLs alive together. Leaving a clip stops it and
  releases the element, so audio never carries on behind the next photo.
- **Arrow keys are claimed by the viewer, not the clip.** Once a video has
  focus its own controls seek on left/right, so without intercepting them one
  press would both scrub the video and move to the next item.

**Codec caveat.** Playback depends on what the browser can decode. HEVC clips
from an iPhone generally play in Safari and not in Chrome; when that happens the
video keeps its date, place and caption and the card says the clip is
unavailable rather than showing an empty player.

## Landmarks

Getting from a coordinate to "Tokyo Dome" needs a different question than
reverse geocoding asks.

The obvious approach — find the nearest point of interest — is wrong, and
confidently so. Asked about the middle of Tokyo Dome it returns an unnamed
restaurant; asked about a street in Takadanobaba it returns a pharmacy. It finds
whatever tiny thing is closest, not the thing you are standing inside.

So the first question asked is which mapped areas **contain** the point
(`is_in`), picking the most specific interesting one. A point inside Tokyo Dome
is also inside "Tokyo Dome City" and inside Bunkyō ward; the ranking in
`src/geo/landmark.ts` prefers the stadium, and ignores administrative
boundaries entirely since reverse geocoding already covers those.

That alone misses a whole category, though. `is_in` can only find *areas*, and
plenty of landmarks are mapped as a single point with no footprint — teamLab
Planets is `tourism=museum` on a bare node, so nothing encloses a photo taken
inside it and no amount of tuning would ever surface it. A second lookup finds
the nearest notable feature within 220m, and anything found that way is
described as a guess: **"close to teamLab Planets"**, never "at".

The same Overpass request also checks a focused 30m radius for a named
restaurant, cafe, fast-food venue, or food court. The nearest match appears as
**"Nearby place"** without exposing the approximate GPS distance. That wording
is deliberate: GPS and map data can identify a plausible venue, but cannot
prove the photographer was inside it. The nearby line links to a Google Maps
place search using the matched venue name and surrounding area. An available
listing can provide its address, food category, hours, photos, and reviews.

Resolved descriptions also include a destination-level **"Learn about"** link.
For example, photos around Hakone link to the English Wikipedia article for
Hakone, including photos whose nearest named feature is a smaller bridge or
museum. Coordinate-only fallbacks do not receive an encyclopedia link.

The focused cutoff allows for normal indoor GPS drift without returning to the
overly broad original 120m search. Dining cache coordinates are kept at roughly metre-level precision,
so a result found for one doorway is not reused for another location down the
street.

Nearby candidates are ranked by category first and distance only as a
tie-break. Ranking by distance alone picks the wrong answer in exactly the case
this exists for: at teamLab Planets the closest qualifying feature is a station
entrance 40m away while the museum is 117m off, so "close to Shin-toyosu" beat
the answer anyone would want. Station entrances and memorials are everywhere;
what someone photographed is rarely the nearest mapped thing.

Three things make this safe to depend on:

- **One request for the whole library.** Overpass accepts many `is_in` lookups
  in a single query, with `out count` between them marking where each result
  set ends — so a trip resolves in one round trip of a second or two rather
  than one throttled request per place. The library still renders first with
  district names and sharpens up a moment later, so nothing waits on the
  network.
- **Results are cached in IndexedDB**, misses included, so a place is only ever
  asked about once no matter how many times you re-import.
- **Failure is invisible.** If the service is down, names stay as districts.
  The public instance is genuinely flaky — testing drew a 429 and a 504 within
  minutes while identical queries succeeded either side of them — so requests
  rotate through community mirrors rather than giving up on the first refusal.

**Reliability caveat, and it is a real one.** The public Overpass instances ask
callers to send an identifying `User-Agent`, and browsers are not allowed to set
that header at all — the app can only send a `Referer`. In practice the free
instances throttle browser traffic hard: the same query answered in ~2s from a
Node script with a User-Agent, and returned 504 from the browser minutes later.
Landmarks are therefore best-effort. When the lookup fails nothing breaks — the
district name stays, and the next import retries — but do not expect every place
to be named on the first attempt.

If you publish this app somewhere busy, consider that Overpass is a free service
run for the OpenStreetMap community. The usage here is modest and cached, but a
high-traffic deployment should point at its own instance — which would also fix
the throttling above.

## Storage

Original files are **not** kept. A 500-photo library of originals would run to
several gigabytes, so IndexedDB stores metadata plus two derivatives per photo:
a 320px thumbnail for the grid and a 1600px version for the lightbox and export
(roughly 150MB for 500 photos).

Your library therefore survives a refresh and comes back on your next visit to
the same browser. **To get true full-resolution files back, re-import them** —
PicturePicture is a viewer for your photos, not a home for them. Your originals
are never modified or moved. The trash button on a card removes only that
browser-stored copy and its derivatives; the source file remains untouched and
can be imported again later.

## Privacy

Photos and videos are read locally and never uploaded. Geotag coordinates do
leave the device so the app can provide maps and human-readable place names:

- **BigDataCloud** receives one cluster coordinate per reverse-geocode lookup.
- **OpenStreetMap Overpass** receives batched cluster coordinates for optional
  landmark and nearby-dining enrichment.
- **English Wikipedia** receives a cluster coordinate only when the map lookup
  does not return a landmark. Nearby articles, place descriptions, and
  aggregate pageview counts help select a recognizable place without
  city-specific rules.
- **Google Maps** receives a map centre when an embedded map is displayed, and
  receives the selected coordinate if someone opens an interactive map link.

No service receives image data, filenames, captions, or capture timestamps.
Reverse-geocode, landmark, and nearby-dining results are cached locally. If a lookup fails or
the device is offline, the library still works and falls back to less-specific
area names or coordinates. Exported albums use the same Google Maps embeds and
therefore require a network connection for their basemaps.

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

**Export site** downloads a ZIP that looks and behaves like the app. Open
`index.html` straight off disk, or publish the folder as-is to GitHub Pages or
any static host — there is no build step.

```
index.html          first day
day-2.html …        one page per day
assets/site.css     shared by every page
assets/site.js
assets/logo.webp
assets/photos/
README.md
```

**One real HTML page per day**, not JavaScript view-switching. That means every
day has its own shareable URL, the browser loads only the photos for the day
being viewed rather than the whole library at once, and the date strip works
with scripting disabled. CSS, JS and the logo are separate files so they are
fetched once and cached across pages instead of being duplicated into each one.

Pin positions are baked into the HTML as percentages, so the maps are correct
with JavaScript off entirely. The script only powers filtering, the lightbox,
and collapsing the map.

## Deploying

The gallery build is a static browser bundle with no media backend or API key.
Anything that serves static files will host it. Public-beta feedback is the one
optional server component and is isolated in the Cloudflare Worker described
below.

### Public-beta readiness

The main page includes a canonical URL, complete Open Graph and Twitter cards,
WebApplication/WebSite structured data, a web manifest, `robots.txt`, and a
sitemap. Keep the canonical and sitemap URLs synchronized if the production
domain changes.

The **Send feedback** links on both the start screen and library open an in-app
public-beta form. The form posts to a Cloudflare Worker, which creates the public
GitHub issue server-side; visitors never see a GitHub dialog and do not need an
account. The browser never receives the GitHub credential. See
[`FEEDBACK-WORKER-SETUP.md`](FEEDBACK-WORKER-SETUP.md) for the one-time encrypted
secret and deployment steps.

### GitHub Pages

`.github/workflows/deploy.yml` builds and publishes on every push. One-time
setup: **Settings → Pages → Source → GitHub Actions**.

The type check, production build, generated-fixture suite, and smoke checks all
run before deployment, so a regression blocks publishing.

Project sites serve from `<user>.github.io/<repo>/`, and a sub-path is where
static builds usually break. This one doesn't: `vite.config.ts` sets
`base: './'`, and the ingest worker is loaded via `new URL(…, import.meta.url)`,
so both resolve against wherever the app is actually mounted. Verified by
serving a production build from a `/PicturePicture/` prefix and running a full
import against it.

No `.nojekyll` is needed — nothing in `dist/` is underscore-prefixed. The
`og:image` metadata uses the final absolute GitHub Pages URL so link-preview
crawlers can resolve it; runtime assets remain relative for project-subpath
portability.

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
