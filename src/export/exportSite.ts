import { zip, type Zippable } from 'fflate';
import type { DayGroup, MapRegion } from '../types';
import { escapeAttr } from '../util/escape';
import { formatCaptured } from '../meta/datetime';
import { embedUrl, interactiveUrl } from '../ui/photoMap';
import { chipParts, dayHeading, placesFor } from '../ui/dayChip';
import { loadDisplay, loadVideo } from '../store/db';
import { fitZoom } from '../geo/mercator';

/**
 * Exports the library as a self-contained static site.
 *
 * The output is a plain folder that works opened straight off disk and drops
 * onto GitHub Pages unchanged. That matters because the map is a keyless Google
 * embed: there is no API key to configure and no script to load, so the
 * exported page has no setup step and nothing that can expire.
 *
 * Structure mirrors the app: one real HTML page per day rather than one long
 * scroll. Real pages, not JavaScript view-switching, so every day gets its own
 * shareable URL, the browser only loads the images for the day being viewed,
 * and navigation works with scripting disabled entirely. CSS, JS and the logo
 * are separate files so the browser caches them once across all the pages.
 *
 * Pin positions are baked in as percentages, so the maps are correct even with
 * no JavaScript at all. The script only powers filtering, the lightbox, and
 * collapsing the map.
 */

/** Matches the aspect-ratio the exported CSS gives the map canvas. */
const EXPORT_CANVAS_WIDTH = 900;
const EXPORT_CANVAS_HEIGHT = 506;

/** Images are already compressed; only the text files are worth deflating. */
const STORE = { level: 0 } as const;
const DEFLATE = { level: 9 } as const;

export interface ExportOptions {
  title?: string;
  onProgress?: (done: number, total: number) => void;
}

export async function exportSite(days: DayGroup[], options: ExportOptions = {}): Promise<Blob> {
  const title = options.title?.trim() || 'My Photo Map';
  const files: Zippable = {};
  const photoPaths = new Map<string, string>();
  const posterPaths = new Map<string, string>();

  const media = days.flatMap((day) =>
    day.photos.filter((p) => p.kind === 'video' || !p.previewUnavailable),
  );
  let done = 0;

  for (const item of media) {
    if (item.kind === 'video') {
      // Videos ship as the original file: there is no small derivative to fall
      // back on, and an album that cannot play its clips is not much of one.
      const blob = await loadVideo(item.id).catch(() => undefined);
      if (blob) {
        const path = `assets/videos/${item.id}.${videoExtensionFor(blob.type, item.name)}`;
        files[path] = [new Uint8Array(await blob.arrayBuffer()), STORE];
        photoPaths.set(item.id, path);
      }
      // The poster frame rides along so the grid has something before play.
      const poster = await loadDisplay(item.id).catch(() => undefined);
      if (poster) {
        const path = `assets/photos/${item.id}.${extensionFor(poster.type)}`;
        files[path] = [new Uint8Array(await poster.arrayBuffer()), STORE];
        posterPaths.set(item.id, path);
      }
    } else {
      const blob = await loadDisplay(item.id).catch(() => undefined);
      if (blob) {
        const path = `assets/photos/${item.id}.${extensionFor(blob.type)}`;
        files[path] = [new Uint8Array(await blob.arrayBuffer()), STORE];
        photoPaths.set(item.id, path);
      }
    }

    options.onProgress?.((done += 1), media.length);
  }

  // Shared across every page, so they download once rather than per day.
  const [logo, favicon] = await Promise.all([fetchAsset('logo.webp'), fetchAsset('favicon.png')]);
  if (logo) files['assets/logo.webp'] = [logo, STORE];
  if (favicon) files['assets/favicon.png'] = [favicon, STORE];

  files['assets/site.css'] = [encode(EXPORT_CSS), DEFLATE];
  files['assets/site.js'] = [encode(EXPORT_JS), DEFLATE];

  days.forEach((day, index) => {
    files[pageFor(index)] = [
      encode(
        buildDayPage({ day, days, index, title, photoPaths, posterPaths, hasLogo: Boolean(logo) }),
      ),
      DEFLATE,
    ];
  });

  files['README.md'] = [encode(buildReadme(title, days)), DEFLATE];

  const archive = (await zipAsync(files)) as Uint8Array<ArrayBuffer>;
  return new Blob([archive], { type: 'application/zip' });
}

/**
 * The first day is `index.html` so the folder has a working root, and the rest
 * get their own file. No redirect, and no page duplicated.
 */
function pageFor(index: number): string {
  return index === 0 ? 'index.html' : `day-${index + 1}.html`;
}

function extensionFor(mime: string): string {
  return mime.includes('webp') ? 'webp' : mime.includes('png') ? 'png' : 'jpg';
}

/** Keeps the original container, since that is what the browser has to play. */
function videoExtensionFor(mime: string, name: string): string {
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('quicktime')) return 'mov';
  if (mime.includes('webm')) return 'webm';

  const ext = name.split('.').pop()?.toLowerCase();
  return ext && /^[a-z0-9]{2,4}$/.test(ext) ? ext : 'mp4';
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Pulls one of the app's own brand assets to bundle into the export. */
async function fetchAsset(path: string): Promise<Uint8Array | null> {
  try {
    // Relative, so it resolves whether the app is served from a domain root or
    // a project sub-path.
    const response = await fetch(path);
    if (!response.ok) return null;
    return new Uint8Array(await response.arrayBuffer());
  } catch {
    return null;
  }
}

function zipAsync(files: Zippable): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    zip(files, {}, (err, data) => (err ? reject(err) : resolve(data)));
  });
}

interface PageContext {
  day: DayGroup;
  days: DayGroup[];
  index: number;
  title: string;
  photoPaths: Map<string, string>;
  posterPaths: Map<string, string>;
  hasLogo: boolean;
}

function buildDayPage(context: PageContext): string {
  const { day, days, index, title, photoPaths, posterPaths, hasLogo } = context;

  const lightboxItems: string[] = [];

  const cards = day.photos
    .map((photo) => {
      const path = photoPaths.get(photo.id);
      const captured = formatCaptured(photo.meta.takenAt, photo.meta.tzOffsetMinutes);
      const caption = photo.caption;

      // Photos and videos share one lightbox list, so its arrows step through
      // the day in order rather than skipping the clips.
      const entry = () =>
        lightboxItems.push(
          JSON.stringify({
            src: path,
            kind: photo.kind,
            title: photo.name,
            location: caption?.location ?? '',
            dining: caption?.dining ?? '',
            desc: caption?.desc ?? '',
            mapsUrl: caption?.mapsUrl ?? '',
            captured,
          }),
        ) - 1;

      let media: string;

      if (!path) {
        const icon = photo.kind === 'video' ? '🎬' : '🖼️';
        media = `<div class="photo-nopreview"><span aria-hidden="true">${icon}</span>No preview available</div>`;
      } else if (photo.kind === 'video') {
        // A poster frame with a play badge, as in the app — clicking opens the
        // lightbox rather than playing here.
        const poster = posterPaths.get(photo.id);
        media =
          `<button class="photo-full-link photo-video-wrap" type="button" data-i="${entry()}" title="Play video">` +
          (poster
            ? `<img src="${escapeAttr(poster)}" alt="${escapeAttr(photo.name)}" loading="lazy">`
            : '<div class="photo-nopreview"><span aria-hidden="true">🎬</span>Video</div>') +
          '<span class="photo-video-play" aria-hidden="true">▶</span>' +
          '</button>';
      } else {
        media =
          `<button class="photo-full-link" type="button" data-i="${entry()}">` +
          `<img src="${escapeAttr(path)}" alt="${escapeAttr(photo.name)}" loading="lazy"></button>`;
      }

      const location = caption?.location
        ? `<div class="photo-location">📍 <a href="${escapeAttr(caption.mapsUrl)}" target="_blank" rel="noopener">${escapeAttr(caption.location)}</a></div>`
        : '';
      const dining = caption?.dining
        ? `<div class="photo-dining">🍽️ ${escapeAttr(caption.dining)}</div>`
        : '';

      return (
        `<div class="photo-card"${photo.clusterId ? ` data-cluster="${escapeAttr(photo.clusterId)}"` : ''}>` +
        media +
        '<div class="photo-meta">' +
        `<div class="photo-kind">${photo.kind === 'video' ? (photo.meta.gps ? 'Video' : 'Video · no GPS') : photo.meta.gps ? 'Photo' : 'No GPS'}</div>` +
        location +
        dining +
        (caption?.desc ? `<div class="photo-desc">${escapeAttr(caption.desc)}</div>` : '') +
        (captured ? `<div class="photo-captured">🕒 ${escapeAttr(captured)}</div>` : '') +
        '</div></div>'
      );
    })
    .join('');

  const maps = day.regions.map((region, i) => staticMapHtml(region, i, day.regions.length)).join('');
  const untagged = day.photos.length - day.taggedCount;

  const totalPhotos = days.reduce((n, d) => n + d.photos.length, 0);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeAttr(`${title} — ${day.label}`)}</title>
<meta name="theme-color" content="#019aa0">
<link rel="icon" type="image/png" href="assets/favicon.png">
<link rel="stylesheet" href="assets/site.css">
</head>
<body>

<header class="site-header">
${hasLogo ? '<img class="site-logo" src="assets/logo.webp" alt="" width="760" height="456">' : ''}
<h1>${escapeAttr(title)}</h1>
<p>${days.length} day${days.length === 1 ? '' : 's'} · ${totalPhotos} item${totalPhotos === 1 ? '' : 's'}</p>
</header>

<nav class="day-nav" aria-label="Choose a day">
<div class="day-nav-scroll">
${days.map((d, i) => navChipHtml(d, i, i === index)).join('\n')}
</div>
</nav>

<main>
<section class="day-section">
<div class="sec-label">${escapeAttr(dayHeading(day))}</div>
${maps || noMapNoticeHtml(day)}
${untagged > 0 && maps ? untaggedNoticeHtml(untagged) : ''}
<div class="photo-filter-bar" data-filter-bar><span data-filter-label></span>
<button class="photo-filter-clear" type="button" data-filter-clear>Show all</button></div>
<div class="photo-grid">${cards}</div>
</section>
</main>

<div class="photo-lightbox" id="lb" aria-hidden="true" role="dialog" aria-modal="true"
 aria-labelledby="lb-title" aria-describedby="lb-dining lb-desc"><div class="photo-lightbox-dialog">
<div class="photo-lightbox-stage">
<button class="photo-lightbox-close" id="lb-close" aria-label="Close">×</button>
<button class="photo-lightbox-nav prev" id="lb-prev" aria-label="Previous">‹</button>
<img class="photo-lightbox-media" id="lb-img" alt="">
<video class="photo-lightbox-media" id="lb-video" controls playsinline hidden></video>
<button class="photo-lightbox-nav next" id="lb-next" aria-label="Next">›</button>
</div>
<div class="photo-lightbox-info">
<div class="photo-lightbox-info-top"><div class="photo-lightbox-title" id="lb-title"></div>
<div class="photo-lightbox-count" id="lb-count"></div></div>
<div class="photo-lightbox-location" id="lb-loc"></div>
<div class="photo-lightbox-dining" id="lb-dining"></div>
<div class="photo-lightbox-desc" id="lb-desc"></div>
<div class="photo-lightbox-captured" id="lb-cap"></div>
</div></div></div>

<script>var LB=[${lightboxItems.join(',')}];</script>
<script src="assets/site.js"></script>
</body>
</html>`;
}

function navChipHtml(day: DayGroup, index: number, active: boolean): string {
  const parts = chipParts(day);
  const places = placesFor(day);
  const count = day.photos.length;

  const tooltip = places.all.length
    ? `${day.label} — ${places.all.join(', ')} · ${count} photo${count === 1 ? '' : 's'}`
    : `${day.label} — ${count} photo${count === 1 ? '' : 's'}`;

  return (
    `<a class="day-chip${active ? ' is-active' : ''}" href="${escapeAttr(pageFor(index))}"` +
    `${active ? ' aria-current="page"' : ''} title="${escapeAttr(tooltip)}">` +
    `<span class="day-chip-mon">${escapeAttr(parts.month)}</span>` +
    `<span class="day-chip-num">${escapeAttr(parts.number)}</span>` +
    `<span class="day-chip-dow">${escapeAttr(parts.weekday)}</span>` +
    `<span class="day-chip-where">${escapeAttr(places.label)}</span>` +
    '</a>'
  );
}

function noMapNoticeHtml(day: DayGroup): string {
  const videos = day.photos.filter((p) => p.kind === 'video').length;
  const photos = day.photos.length - videos;

  const parts = [];
  if (photos > 0) parts.push(`${photos} photo${photos === 1 ? '' : 's'}`);
  if (videos > 0) parts.push(`${videos} video${videos === 1 ? '' : 's'}`);

  return (
    '<div class="photo-empty">' +
    `None of the ${parts.join(' and ')} from this day carry location data, ` +
    'so there’s nothing to plot.' +
    '</div>'
  );
}

function untaggedNoticeHtml(count: number): string {
  return (
    '<div class="photo-map-note">' +
    `📍 ${count} item${count === 1 ? '' : 's'} from this day ` +
    `${count === 1 ? 'has' : 'have'} no location data, so ${count === 1 ? 'it isn’t' : 'they aren’t'} on the map.` +
    '</div>'
  );
}

/**
 * A map whose pins are positioned in percentages, computed here rather than in
 * the browser, so the exported page renders its maps correctly with JavaScript
 * disabled entirely.
 */
function staticMapHtml(region: MapRegion, index: number, total: number): string {
  const points = region.clusters.map((c) => ({ lat: c.lat, lon: c.lon }));
  const zoom = fitZoom(points, EXPORT_CANVAS_WIDTH, EXPORT_CANVAS_HEIGHT);

  const worldSize = 256 * Math.pow(2, zoom);
  const project = (lat: number, lon: number) => {
    let siny = Math.sin((lat * Math.PI) / 180);
    siny = Math.min(Math.max(siny, -0.9999), 0.9999);
    return {
      x: ((lon + 180) / 360) * worldSize,
      y: (0.5 - Math.log((1 + siny) / (1 - siny)) / (4 * Math.PI)) * worldSize,
    };
  };

  const center = project(region.centerLat, region.centerLon);

  const pins = region.clusters
    .map((cluster) => {
      const point = project(cluster.lat, cluster.lon);
      const left = ((EXPORT_CANVAS_WIDTH / 2 + point.x - center.x) / EXPORT_CANVAS_WIDTH) * 100;
      const top = ((EXPORT_CANVAS_HEIGHT / 2 + point.y - center.y) / EXPORT_CANVAS_HEIGHT) * 100;
      const count = cluster.photoIds.length;
      const label = `Show ${count} photo${count === 1 ? '' : 's'} from ${cluster.place}`;

      return (
        `<button class="photo-map-pin-html" type="button" data-cluster="${escapeAttr(cluster.id)}"` +
        ` data-place="${escapeAttr(cluster.place)}" title="${escapeAttr(label)}" aria-label="${escapeAttr(label)}"` +
        ` style="left:${left.toFixed(3)}%;top:${top.toFixed(3)}%">` +
        `<span class="photo-map-pin-count">${count > 99 ? '99+' : count}</span></button>`
      );
    })
    .join('');

  const legend = region.clusters
    .map(
      (cluster) =>
        `<button class="photo-map-place" type="button" data-cluster="${escapeAttr(cluster.id)}"` +
        ` data-place="${escapeAttr(cluster.place)}"><b>${cluster.photoIds.length}</b>` +
        `<span>${escapeAttr(cluster.place)}</span></button>`,
    )
    .join('');

  const title = total > 1 ? `🗺️ Photo trail · map ${index + 1} of ${total}` : '🗺️ Photo trail';
  const sub =
    total > 1
      ? 'This day’s photos span more than one part of the world, so each map covers one of them.'
      : 'Photo locations plotted from the original geotags.';

  return (
    `<div class="photo-day-map" data-region="${escapeAttr(region.id)}">` +
    '<button class="photo-day-map-head" type="button" data-map-toggle aria-expanded="true">' +
    '<span class="photo-day-map-headings">' +
    `<span class="photo-day-map-title">${escapeAttr(title)}</span>` +
    `<span class="photo-day-map-sub">${escapeAttr(sub)}</span></span>` +
    `<span class="photo-day-map-count">${region.taggedCount} tagged</span>` +
    '<span class="photo-day-map-chevron" aria-hidden="true">▾</span>' +
    '</button>' +
    '<div class="photo-day-map-body">' +
    '<div class="photo-day-map-canvas">' +
    `<iframe class="photo-google-map" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" src="${escapeAttr(
      embedUrl(region.centerLat, region.centerLon, zoom),
    )}" title="Map of this day’s photo locations"></iframe>` +
    `<div class="photo-map-overlay">${pins}</div>` +
    `<a class="photo-map-open" href="${escapeAttr(
      interactiveUrl(region.centerLat, region.centerLon, zoom),
    )}" target="_blank" rel="noopener">View interactive map ↗</a>` +
    '</div>' +
    `<div class="photo-day-map-legend">${legend}</div>` +
    '</div></div>'
  );
}

function buildReadme(title: string, days: DayGroup[]): string {
  const pages = days
    .map((day, i) => `- \`${pageFor(i)}\` — ${day.label} (${day.photos.length} photos)`)
    .join('\n');

  return `# ${title}

Exported from PicturePicture.

Open \`index.html\` in a browser, or publish this folder as-is:

- **GitHub Pages** — commit the folder to a repository and enable Pages for it.
- **Any static host** — upload the folder; there is no build step.

## Pages

One page per day, each with its own URL so you can link to a single day:

${pages}

\`assets/site.css\`, \`assets/site.js\` and \`assets/logo.webp\` are shared by every
page. Photos live in \`assets/photos/\` at up to 1600px.

The maps use Google's keyless embed, so there is no API key to configure and
nothing that expires. Pin positions are baked into the HTML, so the maps are
correct even with JavaScript turned off — the script only handles filtering,
the lightbox, and collapsing the map.
`;
}

const EXPORT_CSS = `
:root{
--ink:#1a1a1a;--ink2:#3d3d3d;--ink3:#787878;
--bg:#f5f2ee;--bg2:#ede9e3;--bg3:#fff;
--brand-teal:#019aa0;--teal:#0a7c82;--teal-deep:#0c5157;--pin:#e5484d;
--border:rgba(0,0,0,.09);
--brand-gradient:
  radial-gradient(circle at 84% 16%, rgba(1,165,171,.30), transparent 34%),
  radial-gradient(circle at 12% 86%, rgba(101,89,233,.24), transparent 42%),
  radial-gradient(circle at 92% 88%, rgba(229,72,77,.13), transparent 46%),
  linear-gradient(150deg,#fffdf4 0%,#fdf4e4 26%,#e2f5f3 62%,#e9e6ff 100%);
}
*{box-sizing:border-box}
[hidden]{display:none!important}
body{margin:0;background:var(--bg);color:var(--ink);font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:15px;line-height:1.45}
button,a{font:inherit}
.site-header{display:flex;flex-direction:column;align-items:center;gap:2px;padding:18px 18px 14px;background:var(--brand-gradient);border-bottom:1px solid rgba(10,124,130,.14);text-align:center}
.site-logo{display:block;width:188px;max-width:100%;height:auto}
.site-header h1{margin:6px 0 0;font-size:22px;color:var(--teal-deep)}
.site-header p{margin:3px 0 0;font-size:13px;color:#4f7076}
.day-nav{position:sticky;top:0;z-index:40;background:rgba(255,253,246,.9);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border-bottom:1px solid rgba(10,124,130,.16);box-shadow:0 3px 14px rgba(12,81,87,.08)}
.day-nav-scroll{display:flex;gap:8px;overflow-x:auto;max-width:1400px;margin:0 auto;padding:10px 18px;scrollbar-width:none}
.day-nav-scroll::-webkit-scrollbar{display:none}
.day-chip{flex:0 0 auto;display:flex;flex-direction:column;align-items:center;gap:1px;min-width:86px;max-width:168px;padding:7px 12px;border:1.5px solid #cfe8ea;border-radius:12px;background:#fff;text-decoration:none;transition:background-color 160ms ease,border-color 160ms ease}
.day-chip:hover{background:#f0fafa;border-color:var(--teal)}
.day-chip.is-active{background:linear-gradient(135deg,var(--brand-teal),#0a7c82);border-color:transparent;box-shadow:0 4px 14px rgba(10,124,130,.34)}
.day-chip-mon{font-size:10px;font-weight:800;letter-spacing:.7px;color:#6f8f92}
.day-chip-num{font-size:19px;font-weight:800;line-height:1.05;color:var(--teal-deep)}
.day-chip-dow{font-size:10px;font-weight:700;letter-spacing:.7px;color:#8aa2a4}
.day-chip-where{max-width:100%;margin-top:4px;padding-top:4px;border-top:1px solid rgba(10,124,130,.14);font-size:10px;font-weight:700;line-height:1.25;color:var(--teal);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.day-chip.is-active .day-chip-mon{color:rgba(255,255,255,.72)}
.day-chip.is-active .day-chip-num{color:#fff}
.day-chip.is-active .day-chip-dow{color:rgba(255,255,255,.66)}
.day-chip.is-active .day-chip-where{color:#fff;border-top-color:rgba(255,255,255,.3)}
main{max-width:1400px;margin:0 auto;padding:16px 18px 60px}
.day-section{display:flex;flex-direction:column;gap:12px}
.sec-label{font-size:15px;font-weight:800;letter-spacing:.4px;color:var(--ink3)}
.photo-day-map{position:relative;overflow:hidden;border:1px solid #b6d9dc;border-radius:15px;background:#dcf4f5;box-shadow:0 5px 18px rgba(17,56,68,.12)}
.photo-day-map-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;width:100%;padding:12px 13px 9px;border:0;background:linear-gradient(135deg,#fffdf4,#e9f8f9);border-bottom:1px solid rgba(10,124,130,.15);text-align:left;cursor:pointer}
.photo-day-map-head:hover{background:linear-gradient(135deg,#fffbe8,#dff4f6)}
.photo-day-map-headings{min-width:0;flex:1}
.photo-day-map-title{display:block;font-size:17px;font-weight:800;color:var(--teal-deep);line-height:1.2}
.photo-day-map-sub{display:block;font-size:11px;color:#4f7076;margin-top:3px}
.photo-day-map-count{flex-shrink:0;background:var(--teal);color:#fff;border-radius:999px;padding:5px 9px;font-size:11px;font-weight:800;white-space:nowrap}
.photo-day-map-chevron{flex-shrink:0;align-self:center;color:var(--teal);font-size:15px;line-height:1;transition:transform 180ms ease}
.photo-day-map.is-collapsed .photo-day-map-body{display:none}
.photo-day-map.is-collapsed .photo-day-map-head{border-bottom:0}
.photo-day-map.is-collapsed .photo-day-map-chevron{transform:rotate(-90deg)}
.photo-day-map-canvas{position:relative;aspect-ratio:16/9;min-height:185px;max-height:520px;background:#bfe8ef}
.photo-google-map{position:absolute;inset:0;width:100%;height:100%;border:0;pointer-events:none;background:#e5e7eb}
.photo-map-overlay{position:absolute;inset:0;pointer-events:none}
.photo-map-pin-html{position:absolute;z-index:2;display:flex;align-items:center;justify-content:center;width:46px;height:46px;padding:0 3px 7px;border:3px solid #fff;border-radius:50% 50% 50% 0;background:var(--pin);color:#fff;font-size:12px;font-weight:900;box-shadow:0 4px 10px rgba(15,23,42,.52);transform:translate(-50%,-100%) rotate(-45deg);transform-origin:50% 100%;pointer-events:auto;cursor:pointer}
.photo-map-pin-html::before{content:'';position:absolute;inset:7px;border-radius:50%;background:rgba(126,20,25,.22);box-shadow:inset 0 0 0 1px rgba(255,255,255,.22)}
.photo-map-pin-count{position:relative;z-index:1;display:block;transform:rotate(45deg);text-shadow:0 1px 2px rgba(0,0,0,.4)}
.photo-map-pin-html:hover,.photo-map-pin-html.is-active{z-index:4;background:var(--teal);transform:translate(-50%,-100%) rotate(-45deg) scale(1.14)}
.photo-map-open{position:absolute;right:8px;bottom:8px;z-index:3;padding:7px 10px;border-radius:7px;background:#fff;color:#1a73e8;border:1px solid #dadce0;font-size:10px;font-weight:700;text-decoration:none}
.photo-day-map-legend{display:flex;gap:6px;overflow-x:auto;padding:9px 10px 10px;background:#fffdf8}
.photo-map-place{flex:0 0 auto;display:inline-flex;align-items:center;gap:5px;max-width:240px;padding:5px 8px;border-radius:999px;background:#e6f6f7;border:1px solid #b9e3e6;color:#0a6c72;font-size:11px;white-space:nowrap;cursor:pointer}
.photo-map-place b{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 4px;border-radius:999px;background:#ef5d55;color:#fff;font-size:9px}
.photo-map-place span{overflow:hidden;text-overflow:ellipsis}
.photo-map-note{padding:0 11px 9px;background:#fffdf8;color:#71828a;font-size:10px;line-height:1.3}
.photo-filter-bar{display:none;align-items:center;justify-content:space-between;gap:10px;padding:9px 11px;border-radius:10px;background:#e3f5f6;border:1px solid #a8dade;color:#0f5158;font-size:12px;font-weight:700}
.photo-filter-bar.active{display:flex}
.photo-filter-clear{flex-shrink:0;padding:6px 9px;border:0;border-radius:7px;background:var(--teal);color:#fff;font-size:11px;font-weight:800;cursor:pointer}
.photo-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
@media(min-width:560px){.photo-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media(min-width:860px){.photo-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}
@media(min-width:1180px){.photo-grid{grid-template-columns:repeat(5,minmax(0,1fr))}}
.photo-card{background:var(--bg3);border:1px solid var(--border);border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(17,24,39,.08)}
.photo-card.hidden{display:none}
.photo-full-link{display:block;width:100%;padding:0;border:0;background:none;cursor:zoom-in}
.photo-card img{display:block;width:100%;aspect-ratio:1/1;object-fit:cover;background:var(--bg2)}
.photo-video-wrap{position:relative}
.photo-video-play{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:flex;align-items:center;justify-content:center;width:46px;height:46px;padding-left:3px;border:2px solid rgba(255,255,255,.9);border-radius:50%;background:rgba(9,13,18,.55);color:#fff;font-size:17px;line-height:1;box-shadow:0 3px 14px rgba(0,0,0,.4);pointer-events:none}
.photo-video-wrap:hover .photo-video-play{background:rgba(10,124,130,.85)}
video.photo-lightbox-media{width:100%}
.photo-nopreview{display:flex;align-items:center;justify-content:center;flex-direction:column;gap:5px;aspect-ratio:1/1;background:var(--bg2);color:var(--ink3);font-size:11px;text-align:center}
.photo-meta{padding:7px 7px 8px}
.photo-kind{display:inline-block;font-size:9px;color:var(--teal);background:#d6f2f4;border:1px solid rgba(10,124,130,.2);border-radius:999px;padding:2px 5px;margin-bottom:4px}
.photo-location{font-size:12px;color:var(--teal);margin-bottom:4px}
.photo-location a{color:var(--teal);text-underline-offset:2px}
.photo-dining{font-size:11px;color:#8a4f08;line-height:1.3;margin-bottom:4px}
.photo-desc{font-size:11px;color:var(--ink3);line-height:1.3}
.photo-captured{font-size:10px;color:var(--ink2);margin-top:5px;padding-top:5px;border-top:1px solid var(--border)}
.photo-empty{background:var(--bg3);border:1px dashed var(--border);border-radius:14px;padding:18px;color:var(--ink3);font-size:13px;text-align:center}
.photo-lightbox{position:fixed;inset:0;z-index:9999;display:none;align-items:center;justify-content:center;padding:18px;background:rgba(4,10,18,.92)}
.photo-lightbox.open{display:flex}
.photo-lightbox-dialog{position:relative;width:min(100%,1000px);height:min(92vh,1000px);display:grid;grid-template-rows:minmax(0,1fr) auto;background:#090d12;border-radius:12px;overflow:hidden}
.photo-lightbox-stage{position:relative;min-height:0;display:flex;align-items:center;justify-content:center;padding:58px 62px 16px}
.photo-lightbox-media{max-width:100%;max-height:100%;object-fit:contain;border-radius:8px}
.photo-lightbox-close{position:absolute;top:8px;right:8px;z-index:2;width:48px;height:48px;border-radius:50%;border:1px solid rgba(255,255,255,.4);background:rgba(0,0,0,.72);color:#fff;font-size:28px;cursor:pointer}
.photo-lightbox-nav{position:absolute;top:50%;z-index:2;width:50px;height:58px;margin-top:-29px;border:1px solid rgba(255,255,255,.35);border-radius:12px;background:rgba(0,0,0,.68);color:#fff;font-size:36px;cursor:pointer}
.photo-lightbox-nav.prev{left:8px}.photo-lightbox-nav.next{right:8px}
.photo-lightbox-nav:disabled{opacity:.22;pointer-events:none}
.photo-lightbox-info{padding:13px 18px 16px;background:linear-gradient(135deg,#111827,#0f2430);color:#fff}
.photo-lightbox-info-top{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.photo-lightbox-title{font-size:16px;font-weight:700}
.photo-lightbox-count{font-size:13px;color:rgba(255,255,255,.62);white-space:nowrap}
.photo-lightbox-location{font-size:14px;color:#5fe3e8;margin-top:5px}
.photo-lightbox-location a{color:#5fe3e8}
.photo-lightbox-dining{font-size:14px;color:#ffd27a;line-height:1.35;margin-top:5px}
.photo-lightbox-desc{font-size:14px;color:rgba(255,255,255,.82);margin-top:5px}
.photo-lightbox-captured{font-size:13px;color:rgba(255,255,255,.65);margin-top:7px;padding-top:7px;border-top:1px solid rgba(255,255,255,.12)}
body.lb-open{overflow:hidden}
@media(max-width:560px){
.site-logo{width:158px}
.day-nav-scroll{padding:8px 12px}
.day-chip{min-width:78px;max-width:132px;padding:6px 9px}
main{padding:12px 12px 48px}
.photo-day-map-canvas{aspect-ratio:4/3}
.photo-lightbox-stage{padding:54px 48px 10px}
}
`;

export const EXPORT_JS = `
(function(){
var i=-1,lb=document.getElementById('lb'),img=document.getElementById('lb-img'),vid=document.getElementById('lb-video');
var closeBtn=document.getElementById('lb-close'),ret=null,bg=[];
function el(id){return document.getElementById(id)}
function stopVid(){if(!vid.getAttribute('src'))return;vid.pause();vid.removeAttribute('src');vid.load()}
function inert(on){if(on){bg=[];Array.prototype.forEach.call(document.body.children,function(x){
if(x!==lb&&x instanceof HTMLElement){bg.push([x,x.inert]);x.inert=true}});return}
bg.forEach(function(x){x[0].inert=x[1]});bg=[]}
function trap(e){var q=Array.prototype.filter.call(lb.querySelectorAll('a[href],button:not([disabled]),video[controls],[tabindex]:not([tabindex="-1"])'),function(x){
return !x.hidden&&x.getClientRects().length});if(!q.length){e.preventDefault();closeBtn.focus();return}
var first=q[0],last=q[q.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}
else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}}
function show(){var it=LB[i];if(!it)return;
// Stop the previous clip before the next item starts, or its audio carries on.
stopVid();
var isVid=it.kind==='video';
img.hidden=isVid;vid.hidden=!isVid;
if(isVid){vid.src=it.src;var p=vid.play();if(p&&p.catch)p.catch(function(){})}
else{img.src=it.src;img.alt=it.title}
el('lb-title').textContent=it.title;
el('lb-count').textContent=(i+1)+' / '+LB.length;
el('lb-prev').disabled=i<=0;el('lb-next').disabled=i>=LB.length-1;
var lo=el('lb-loc');lo.innerHTML='';lo.style.display=it.location?'block':'none';
if(it.location){lo.appendChild(document.createTextNode('\\u{1F4CD} '));
if(it.mapsUrl){var a=document.createElement('a');a.href=it.mapsUrl;a.target='_blank';a.rel='noopener';a.textContent=it.location;lo.appendChild(a)}
else lo.appendChild(document.createTextNode(it.location))}
var eat=el('lb-dining');eat.textContent=it.dining?'\\u{1F37D}\\u{FE0F} '+it.dining:'';eat.style.display=it.dining?'block':'none';
var d=el('lb-desc');d.textContent=it.desc||'';d.style.display=it.desc?'block':'none';
var c=el('lb-cap');c.textContent=it.captured?'\\u{1F552} '+it.captured:'';c.style.display=it.captured?'block':'none'}
function open(n){ret=document.activeElement;i=Math.max(0,Math.min(n,LB.length-1));show();lb.classList.add('open');lb.setAttribute('aria-hidden','false');document.body.classList.add('lb-open');inert(true);requestAnimationFrame(function(){closeBtn.focus()})}
function close(){if(!lb.classList.contains('open'))return;lb.classList.remove('open');lb.setAttribute('aria-hidden','true');document.body.classList.remove('lb-open');inert(false);stopVid();img.removeAttribute('src');i=-1;if(ret&&ret.isConnected)ret.focus();ret=null}
function go(d){var n=i+d;if(n<0||n>=LB.length)return;i=n;show()}
el('lb-close').onclick=close;el('lb-prev').onclick=function(){go(-1)};el('lb-next').onclick=function(){go(1)};
lb.onclick=function(e){if(e.target===lb)close()};
document.addEventListener('keydown',function(e){if(!lb.classList.contains('open'))return;
if(e.key==='Escape'){close();return}
if(e.key==='Tab'){trap(e);return}
// Claimed before the video's own controls, which would otherwise seek on the
// same press as well as moving to the next item.
if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();go(e.key==='ArrowLeft'?-1:1)}});
var sx=0,sy=0,stage=lb.querySelector('.photo-lightbox-stage');
stage.addEventListener('touchstart',function(e){var t=e.changedTouches[0];sx=t.clientX;sy=t.clientY},{passive:true});
stage.addEventListener('touchend',function(e){var t=e.changedTouches[0],dx=t.clientX-sx,dy=t.clientY-sy;
if(Math.abs(dx)>45&&Math.abs(dx)>Math.abs(dy))go(dx<0?1:-1)},{passive:true});

var KEY='pp:maps-collapsed';
function collapsed(){try{var v=localStorage.getItem(KEY);return v===null?false:v==='1'}catch(e){return false}}
function store(v){try{localStorage.setItem(KEY,v?'1':'0')}catch(e){}}
if(collapsed()){Array.prototype.forEach.call(document.querySelectorAll('.photo-day-map'),function(m){
m.classList.add('is-collapsed');var h=m.querySelector('[data-map-toggle]');if(h)h.setAttribute('aria-expanded','false')})}

function clear(s){Array.prototype.forEach.call(s.querySelectorAll('.photo-card'),function(c){c.classList.remove('hidden')});
Array.prototype.forEach.call(s.querySelectorAll('.photo-map-pin-html'),function(x){x.classList.remove('is-active')});
s.querySelector('[data-filter-bar]').classList.remove('active')}

document.addEventListener('click',function(e){
var t=e.target;
var mt=t.closest('[data-map-toggle]');
if(mt){var m=mt.closest('.photo-day-map');var c=m.classList.toggle('is-collapsed');
mt.setAttribute('aria-expanded',String(!c));store(c);return}
var o=t.closest('[data-i]');if(o){open(Number(o.getAttribute('data-i')));return}
var s=t.closest('.day-section');if(!s)return;
if(t.closest('[data-filter-clear]')){clear(s);return}
var p=t.closest('.photo-map-pin-html,.photo-map-place');if(!p)return;
var id=p.getAttribute('data-cluster'),act=s.querySelector('.photo-map-pin-html.is-active');
if(act&&act.getAttribute('data-cluster')===id){clear(s);return}
var n=0;Array.prototype.forEach.call(s.querySelectorAll('.photo-card'),function(c){
var m=c.getAttribute('data-cluster')===id;c.classList.toggle('hidden',!m);if(m)n++});
Array.prototype.forEach.call(s.querySelectorAll('.photo-map-pin-html'),function(x){
x.classList.toggle('is-active',x.getAttribute('data-cluster')===id)});
s.querySelector('[data-filter-label]').textContent='\\u{1F4CD} '+p.getAttribute('data-place')+' \\u00B7 '+n+' item'+(n===1?'':'s');
s.querySelector('[data-filter-bar]').classList.add('active')});
})();
`;
