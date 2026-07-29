import type { MapRegion } from '../types';
import { escapeAttr } from '../util/escape';
import { fitZoom, screenPosition } from '../geo/mercator';

/**
 * The day map: a Google Maps embed used as a basemap, with HTML pins projected
 * on top of it.
 *
 * The embed URL (`maps.google.com/maps?...&output=embed`) needs no API key, no
 * billing account and no script tag — which is what makes this whole approach
 * work as a static site. The trade-off is that the iframe is opaque to us: we
 * can't ask it where anything is, so pin placement is pure maths against the
 * centre and zoom we chose. `pointer-events: none` keeps the iframe from
 * swallowing clicks meant for the pins.
 *
 * Two fixes over the reference implementation, both required by showing more
 * than one day at a time:
 *  - positioning walks *every* canvas, not just `querySelector`'s first match;
 *  - the iframe src is set after the zoom is settled rather than written into
 *    the markup and then rewritten, which used to reload the map mid-render.
 */

const MAP_SUB =
  'Google Maps view with photo locations plotted from the original geotags.';

let resizeObserver: ResizeObserver | null = null;

export function mapRegionHtml(region: MapRegion, index: number, total: number): string {
  const title = total > 1 ? `🗺️ Photo trail · map ${index + 1} of ${total}` : '🗺️ Photo trail';

  const sub =
    total > 1
      ? 'This day’s photos span more than one part of the world, so each map covers one of them.'
      : MAP_SUB;

  const pins = region.clusters
    .map((cluster) => {
      const count = cluster.photoIds.length;
      const label = `Show ${count} photo${count === 1 ? '' : 's'} from ${cluster.place}`;
      return (
        `<button class="photo-map-pin-html" type="button"` +
        ` data-cluster="${escapeAttr(cluster.id)}"` +
        ` data-place="${escapeAttr(cluster.place)}"` +
        ` data-lat="${cluster.lat.toFixed(7)}" data-lon="${cluster.lon.toFixed(7)}"` +
        ` aria-label="${escapeAttr(label)}" title="${escapeAttr(label)}">` +
        `<span class="photo-map-pin-count">${count > 99 ? '99+' : count}</span>` +
        '</button>'
      );
    })
    .join('');

  const legend = region.clusters
    .map((cluster) => {
      const count = cluster.photoIds.length;
      return (
        `<button class="photo-map-place" type="button"` +
        ` data-cluster="${escapeAttr(cluster.id)}"` +
        ` data-place="${escapeAttr(cluster.place)}"` +
        ` title="${escapeAttr(cluster.place)}">` +
        `<b>${count > 99 ? '99+' : count}</b><span>${escapeAttr(cluster.place)}</span>` +
        '</button>'
      );
    })
    .join('');

  return (
    `<div class="photo-day-map" data-region="${escapeAttr(region.id)}">` +
    '<div class="photo-day-map-head"><div>' +
    `<div class="photo-day-map-title">${escapeAttr(title)}</div>` +
    `<div class="photo-day-map-sub">${escapeAttr(sub)}</div>` +
    '</div>' +
    `<div class="photo-day-map-count">${region.taggedCount} tagged</div>` +
    '</div>' +
    `<div class="photo-day-map-canvas" data-map-lat="${region.centerLat}"` +
    ` data-map-lon="${region.centerLon}" data-map-zoom="${region.zoom}"` +
    ` data-map-base-zoom="${region.zoom}">` +
    '<iframe class="photo-google-map" title="Map of this day’s photo locations"' +
    ' loading="lazy" referrerpolicy="strict-origin-when-cross-origin"></iframe>' +
    `<div class="photo-map-overlay">${pins}</div>` +
    '<a class="photo-map-open" target="_blank" rel="noopener">View interactive map ↗</a>' +
    '</div>' +
    `<div class="photo-day-map-legend">${legend}</div>` +
    '</div>'
  );
}

export function embedUrl(lat: number, lon: number, zoom: number): string {
  return `https://maps.google.com/maps?ll=${lat},${lon}&z=${zoom}&t=m&hl=en&output=embed`;
}

export function interactiveUrl(lat: number, lon: number, zoom: number): string {
  return `https://www.google.com/maps/@${lat},${lon},${zoom}z`;
}

/** Repositions pins on every map under `root`. Safe to call repeatedly. */
export function refreshMapPins(root: ParentNode = document): void {
  for (const canvas of root.querySelectorAll<HTMLElement>('.photo-day-map-canvas')) {
    positionPins(canvas);
  }
}

/** Keeps pins aligned when the layout reflows — orientation change, resize. */
export function observeMaps(root: ParentNode = document): void {
  resizeObserver ??= new ResizeObserver((entries) => {
    for (const entry of entries) positionPins(entry.target as HTMLElement);
  });

  resizeObserver.disconnect();
  for (const canvas of root.querySelectorAll<HTMLElement>('.photo-day-map-canvas')) {
    resizeObserver.observe(canvas);
  }
}

function positionPins(canvas: HTMLElement): void {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;

  const centerLat = Number(canvas.dataset.mapLat);
  const centerLon = Number(canvas.dataset.mapLon);
  const baseZoom = Number(canvas.dataset.mapBaseZoom ?? canvas.dataset.mapZoom);
  if (!Number.isFinite(centerLat) || !Number.isFinite(centerLon) || !Number.isFinite(baseZoom)) {
    return;
  }

  const pins = [...canvas.querySelectorAll<HTMLElement>('.photo-map-pin-html')];
  if (pins.length === 0) return;

  const points = pins.map((pin) => ({
    lat: Number(pin.dataset.lat),
    lon: Number(pin.dataset.lon),
  }));

  // Re-fit against the real canvas now that it has been laid out; the zoom
  // baked in at build time was computed against an assumed size.
  const zoom = fitZoom(points, width, height, baseZoom);
  canvas.dataset.mapZoom = String(zoom);

  const center = { lat: centerLat, lon: centerLon };

  const iframe = canvas.querySelector<HTMLIFrameElement>('.photo-google-map');
  if (iframe) {
    const wanted = embedUrl(centerLat, centerLon, zoom);
    // Only touch src when it actually changes — assigning it reloads the map.
    if (iframe.getAttribute('src') !== wanted) iframe.setAttribute('src', wanted);
  }

  const openLink = canvas.querySelector<HTMLAnchorElement>('.photo-map-open');
  if (openLink) openLink.href = interactiveUrl(centerLat, centerLon, zoom);

  pins.forEach((pin, i) => {
    const position = screenPosition(points[i]!, center, zoom, width, height);
    pin.style.left = `${position.left.toFixed(1)}px`;
    pin.style.top = `${position.top.toFixed(1)}px`;
    pin.style.display = position.visible ? 'flex' : 'none';
  });
}
