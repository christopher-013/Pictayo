import { zip } from 'fflate';
import type { DayGroup } from '../types';
import { escapeAttr } from '../util/escape';
import { formatCaptured } from '../meta/datetime';
import { embedUrl, interactiveUrl } from '../ui/photoMap';
import { loadDisplay } from '../store/db';
import { fitZoom } from '../geo/mercator';

/**
 * Exports the library as a self-contained static site.
 *
 * The output is a plain folder — `index.html` plus `assets/photos/*` — that
 * works opened straight off disk and drops onto GitHub Pages unchanged. That
 * matters because the map is a keyless Google embed: there is no API key to
 * configure and no script to load, so the exported page has no setup step and
 * nothing that can expire.
 *
 * Pin positions are baked in as percentages rather than recomputed at runtime,
 * so the exported page needs no JavaScript for the map to be correct. A small
 * inline script handles only filtering and the lightbox.
 */

/** Matches the aspect-ratio the exported CSS gives the map canvas. */
const EXPORT_CANVAS_WIDTH = 900;
const EXPORT_CANVAS_HEIGHT = 506;

export interface ExportOptions {
  title?: string;
  onProgress?: (done: number, total: number) => void;
}

export async function exportSite(days: DayGroup[], options: ExportOptions = {}): Promise<Blob> {
  const title = options.title?.trim() || 'My Photo Map';
  const files: Record<string, Uint8Array> = {};

  const photos = days.flatMap((day) => day.photos.filter((p) => !p.previewUnavailable));
  let done = 0;

  for (const photo of photos) {
    const blob = await loadDisplay(photo.id).catch(() => undefined);
    if (blob) {
      files[`assets/photos/${assetName(photo.id, blob.type)}`] = new Uint8Array(
        await blob.arrayBuffer(),
      );
    }
    options.onProgress?.((done += 1), photos.length);
  }

  files['index.html'] = new TextEncoder().encode(
    buildHtml(days, title, files, await brandMarkDataUri()),
  );
  files['README.md'] = new TextEncoder().encode(buildReadme(title));

  // fflate returns Uint8Array<ArrayBufferLike>; BlobPart wants an ArrayBuffer-
  // backed view. It always is one here — fflate never allocates on a
  // SharedArrayBuffer — so narrowing it is safe.
  const archive = (await zipAsync(files)) as Uint8Array<ArrayBuffer>;
  return new Blob([archive], { type: 'application/zip' });
}

/**
 * The mascot, inlined as a data URI rather than shipped as a file.
 *
 * At ~9KB it costs less than the extra request would, and it keeps the export
 * to exactly the files the user's own photos need. Failure is non-fatal — the
 * header simply renders without it.
 */
async function brandMarkDataUri(): Promise<string> {
  try {
    // Relative so it resolves whether the app is served from a domain root or
    // a project sub-path.
    const response = await fetch('mark.webp');
    if (!response.ok) return '';

    const buffer = new Uint8Array(await response.arrayBuffer());
    let binary = '';
    for (const byte of buffer) binary += String.fromCharCode(byte);

    return `data:image/webp;base64,${btoa(binary)}`;
  } catch {
    return '';
  }
}

function assetName(id: string, mime: string): string {
  const ext = mime.includes('webp') ? 'webp' : mime.includes('png') ? 'png' : 'jpg';
  return `${id}.${ext}`;
}

function assetPathFor(id: string, files: Record<string, Uint8Array>): string | null {
  for (const ext of ['webp', 'jpg', 'png']) {
    const path = `assets/photos/${id}.${ext}`;
    if (files[path]) return path;
  }
  return null;
}

function zipAsync(files: Record<string, Uint8Array>): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    // Images are already compressed; level 0 keeps the export fast.
    zip(files, { level: 0 }, (err, data) => (err ? reject(err) : resolve(data)));
  });
}

function buildHtml(
  days: DayGroup[],
  title: string,
  files: Record<string, Uint8Array>,
  markDataUri: string,
): string {
  const lightboxItems: string[] = [];

  const sections = days
    .map((day) => {
      const cards = day.photos
        .map((photo) => {
          const path = assetPathFor(photo.id, files);
          const captured = formatCaptured(photo.meta.takenAt, photo.meta.tzOffsetMinutes);
          const caption = photo.caption;

          const media = path
            ? `<button class="photo-full-link" type="button" data-i="${lightboxItems.push(
                JSON.stringify({
                  src: path,
                  title: photo.name,
                  location: caption?.location ?? '',
                  desc: caption?.desc ?? '',
                  mapsUrl: caption?.mapsUrl ?? '',
                  captured,
                }),
              ) - 1}"><img src="${escapeAttr(path)}" alt="${escapeAttr(photo.name)}" loading="lazy"></button>`
            : '<div class="photo-nopreview"><span>🖼️</span>No preview available</div>';

          const location = caption?.location
            ? `<div class="photo-location">📍 <a href="${escapeAttr(caption.mapsUrl)}" target="_blank" rel="noopener">${escapeAttr(caption.location)}</a></div>`
            : '';

          return (
            `<div class="photo-card"${photo.clusterId ? ` data-cluster="${escapeAttr(photo.clusterId)}"` : ''}>` +
            media +
            '<div class="photo-meta">' +
            `<div class="photo-kind">${photo.meta.gps ? 'Photo' : 'No GPS'}</div>` +
            location +
            (caption?.desc ? `<div class="photo-desc">${escapeAttr(caption.desc)}</div>` : '') +
            (captured ? `<div class="photo-captured">🕒 ${escapeAttr(captured)}</div>` : '') +
            '</div></div>'
          );
        })
        .join('');

      const maps = day.regions.map((region) => staticMapHtml(region)).join('');

      return (
        `<section class="day-section" id="day-${escapeAttr(day.dayKey)}">` +
        `<div class="sec-label">${escapeAttr(day.label)} · Photos</div>` +
        maps +
        '<div class="photo-filter-bar" data-filter-bar><span data-filter-label></span>' +
        '<button class="photo-filter-clear" type="button" data-filter-clear>Show all photos</button></div>' +
        `<div class="photo-grid">${cards}</div>` +
        '</section>'
      );
    })
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeAttr(title)}</title>
${markDataUri ? `<link rel="icon" href="${markDataUri}">` : ''}
<meta name="theme-color" content="#019aa0">
<style>${EXPORT_CSS}</style>
</head>
<body>
<header class="site-header">
${markDataUri ? `<img class="site-mark" src="${markDataUri}" alt="" width="192" height="192">` : ''}
<div><h1>${escapeAttr(title)}</h1>
<p>${days.length} day${days.length === 1 ? '' : 's'} · ${days.reduce((n, d) => n + d.photos.length, 0)} photos</p></div>
</header>
<main>${sections}</main>
<div class="photo-lightbox" id="lb" aria-hidden="true"><div class="photo-lightbox-dialog">
<div class="photo-lightbox-stage">
<button class="photo-lightbox-close" id="lb-close" aria-label="Close">×</button>
<button class="photo-lightbox-nav prev" id="lb-prev" aria-label="Previous">‹</button>
<img class="photo-lightbox-media" id="lb-img" alt="">
<button class="photo-lightbox-nav next" id="lb-next" aria-label="Next">›</button>
</div>
<div class="photo-lightbox-info">
<div class="photo-lightbox-info-top"><div class="photo-lightbox-title" id="lb-title"></div>
<div class="photo-lightbox-count" id="lb-count"></div></div>
<div class="photo-lightbox-location" id="lb-loc"></div>
<div class="photo-lightbox-desc" id="lb-desc"></div>
<div class="photo-lightbox-captured" id="lb-cap"></div>
</div></div></div>
<script>var LB=[${lightboxItems.join(',')}];${EXPORT_JS}</script>
</body>
</html>`;
}

/**
 * A map whose pins are positioned in percentages, computed here rather than in
 * the browser. The exported page therefore renders its maps correctly with
 * JavaScript disabled entirely.
 */
function staticMapHtml(region: {
  clusters: { id: string; lat: number; lon: number; place: string; photoIds: string[] }[];
  centerLat: number;
  centerLon: number;
  taggedCount: number;
}): string {
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

  return (
    '<div class="photo-day-map">' +
    '<div class="photo-day-map-head"><div><div class="photo-day-map-title">🗺️ Photo trail</div>' +
    '<div class="photo-day-map-sub">Photo locations plotted from the original geotags.</div></div>' +
    `<div class="photo-day-map-count">${region.taggedCount} tagged</div></div>` +
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
    '</div>'
  );
}

function buildReadme(title: string): string {
  return `# ${title}

Exported from PicturePicture.

Open \`index.html\` in a browser, or publish this folder as-is:

- **GitHub Pages** — commit the folder to a repository and enable Pages for that branch.
- **Any static host** — upload the folder; there is no build step.

The maps use Google's keyless embed, so there is no API key to configure and
nothing that expires. Photos are stored in \`assets/photos/\` at up to 1600px.
`;
}

const EXPORT_CSS = `
:root{--ink:#1a1a1a;--ink2:#3d3d3d;--ink3:#787878;--bg:#f5f2ee;--bg2:#ede9e3;--bg3:#fff;--teal:#0a7c82;--pin:#e5484d;--border:rgba(0,0,0,.09)}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:15px;line-height:1.45}
button,a{font:inherit}
.site-header{display:flex;align-items:center;gap:14px;padding:18px 18px 16px;background:linear-gradient(135deg,#fffdf4,#e9f8f9);border-bottom:1px solid rgba(10,124,130,.18)}
.site-mark{flex:0 0 52px;width:52px;height:52px;border-radius:50%;object-fit:cover;background:#fff;box-shadow:0 0 0 2px rgba(1,154,160,.35),0 3px 10px rgba(10,124,130,.22)}
.site-header h1{margin:0;font-size:24px;color:#0c5157}
.site-header p{margin:4px 0 0;font-size:13px;color:#4f7076}
main{max-width:1400px;margin:0 auto;padding:16px 18px 60px;display:flex;flex-direction:column;gap:26px}
.day-section{display:flex;flex-direction:column;gap:12px}
.sec-label{font-size:15px;font-weight:700;letter-spacing:2.5px;text-transform:uppercase;color:var(--ink3)}
.photo-day-map{position:relative;overflow:hidden;border:1px solid #b6d9dc;border-radius:15px;background:#dcf4f5;box-shadow:0 5px 18px rgba(17,56,68,.12)}
.photo-day-map-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:12px 13px 9px;background:linear-gradient(135deg,#fffdf4,#e9f8f9);border-bottom:1px solid rgba(10,124,130,.15)}
.photo-day-map-title{font-size:17px;font-weight:800;color:#0c5157}
.photo-day-map-sub{font-size:11px;color:#4f7076;margin-top:3px}
.photo-day-map-count{flex-shrink:0;background:var(--teal);color:#fff;border-radius:999px;padding:5px 9px;font-size:11px;font-weight:800;white-space:nowrap}
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
.photo-nopreview{display:flex;align-items:center;justify-content:center;flex-direction:column;gap:5px;aspect-ratio:1/1;background:var(--bg2);color:var(--ink3);font-size:11px;text-align:center}
.photo-meta{padding:7px 7px 8px}
.photo-kind{display:inline-block;font-size:9px;color:var(--teal);background:#d6f2f4;border:1px solid rgba(10,124,130,.2);border-radius:999px;padding:2px 5px;margin-bottom:4px}
.photo-location{font-size:12px;color:var(--teal);margin-bottom:4px}
.photo-location a{color:var(--teal);text-underline-offset:2px}
.photo-desc{font-size:11px;color:var(--ink3);line-height:1.3}
.photo-captured{font-size:10px;color:var(--ink2);margin-top:5px;padding-top:5px;border-top:1px solid var(--border)}
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
.photo-lightbox-desc{font-size:14px;color:rgba(255,255,255,.82);margin-top:5px}
.photo-lightbox-captured{font-size:13px;color:rgba(255,255,255,.65);margin-top:7px;padding-top:7px;border-top:1px solid rgba(255,255,255,.12)}
body.lb-open{overflow:hidden}
@media(max-width:560px){.photo-day-map-canvas{aspect-ratio:4/3}.photo-lightbox-stage{padding:54px 48px 10px}}
`;

const EXPORT_JS = `
(function(){
var i=-1,lb=document.getElementById('lb'),img=document.getElementById('lb-img');
function el(id){return document.getElementById(id)}
function show(){var it=LB[i];if(!it)return;
img.src=it.src;img.alt=it.title;el('lb-title').textContent=it.title;
el('lb-count').textContent=(i+1)+' / '+LB.length;
el('lb-prev').disabled=i<=0;el('lb-next').disabled=i>=LB.length-1;
var lo=el('lb-loc');lo.innerHTML='';lo.style.display=it.location?'block':'none';
if(it.location){lo.appendChild(document.createTextNode('📍 '));
if(it.mapsUrl){var a=document.createElement('a');a.href=it.mapsUrl;a.target='_blank';a.rel='noopener';a.textContent=it.location;lo.appendChild(a)}
else lo.appendChild(document.createTextNode(it.location))}
var d=el('lb-desc');d.textContent=it.desc||'';d.style.display=it.desc?'block':'none';
var c=el('lb-cap');c.textContent=it.captured?'🕒 '+it.captured:'';c.style.display=it.captured?'block':'none'}
function open(n){i=Math.max(0,Math.min(n,LB.length-1));show();lb.classList.add('open');lb.setAttribute('aria-hidden','false');document.body.classList.add('lb-open')}
function close(){lb.classList.remove('open');lb.setAttribute('aria-hidden','true');document.body.classList.remove('lb-open');img.removeAttribute('src');i=-1}
function go(d){var n=i+d;if(n<0||n>=LB.length)return;i=n;show()}
el('lb-close').onclick=close;el('lb-prev').onclick=function(){go(-1)};el('lb-next').onclick=function(){go(1)};
lb.onclick=function(e){if(e.target===lb)close()};
document.addEventListener('keydown',function(e){if(!lb.classList.contains('open'))return;
if(e.key==='Escape')close();else if(e.key==='ArrowLeft')go(-1);else if(e.key==='ArrowRight')go(1)});
var sx=0,sy=0,stage=lb.querySelector('.photo-lightbox-stage');
stage.addEventListener('touchstart',function(e){var t=e.changedTouches[0];sx=t.clientX;sy=t.clientY},{passive:true});
stage.addEventListener('touchend',function(e){var t=e.changedTouches[0],dx=t.clientX-sx,dy=t.clientY-sy;
if(Math.abs(dx)>45&&Math.abs(dx)>Math.abs(dy))go(dx<0?1:-1)},{passive:true});
document.addEventListener('click',function(e){
var o=e.target.closest('[data-i]');if(o){open(Number(o.getAttribute('data-i')));return}
var s=e.target.closest('.day-section');if(!s)return;
if(e.target.closest('[data-filter-clear]')){clear(s);return}
var p=e.target.closest('.photo-map-pin-html,.photo-map-place');if(!p)return;
var id=p.getAttribute('data-cluster'),act=s.querySelector('.photo-map-pin-html.is-active');
if(act&&act.getAttribute('data-cluster')===id){clear(s);return}
var n=0;Array.prototype.forEach.call(s.querySelectorAll('.photo-card'),function(c){
var m=c.getAttribute('data-cluster')===id;c.classList.toggle('hidden',!m);if(m)n++});
Array.prototype.forEach.call(s.querySelectorAll('.photo-map-pin-html'),function(x){
x.classList.toggle('is-active',x.getAttribute('data-cluster')===id)});
s.querySelector('[data-filter-label]').textContent='📍 '+p.getAttribute('data-place')+' · '+n+' photo'+(n===1?'':'s');
s.querySelector('[data-filter-bar]').classList.add('active')});
function clear(s){Array.prototype.forEach.call(s.querySelectorAll('.photo-card'),function(c){c.classList.remove('hidden')});
Array.prototype.forEach.call(s.querySelectorAll('.photo-map-pin-html'),function(x){x.classList.remove('is-active')});
s.querySelector('[data-filter-bar]').classList.remove('active')}
})();
`;
