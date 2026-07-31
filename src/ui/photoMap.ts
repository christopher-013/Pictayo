import type { MapRegion } from '../types';
import { escapeAttr } from '../util/escape';
import {
  fitZoom,
  latitudeFromMercator,
  mercatorY,
  screenPosition,
  worldSizeAt,
} from '../geo/mercator';

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
  'Google Maps view with photo locations plotted from the original geotags. Scroll or use +/− to zoom; pinch on mobile.';

const MIN_MAP_ZOOM = 1;
const MAX_MAP_ZOOM = 20;

let resizeObserver: ResizeObserver | null = null;

const COLLAPSE_KEY = 'pp:maps-collapsed';

/**
 * Whether day maps start collapsed. First visits expand on every screen; an
 * explicit preference always wins.
 *
 * Stored as one preference rather than per day: someone who opens or collapses
 * the map is saying how they want to browse, not something about that
 * particular day, so the choice carries across days and visits.
 */
export function mapsCollapsed(): boolean {
  try {
    const stored = localStorage.getItem(COLLAPSE_KEY);
    if (stored !== null) return stored === '1';
    return false;
  } catch {
    return false;
  }
}

export function setMapsCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
  } catch {
    // Private browsing with storage disabled — the toggle still works for
    // this page, it just won't be remembered.
  }
}

/**
 * Expands or collapses one map. Returns the new state.
 *
 * A collapsed canvas has no measured size, so its pins can't be placed. They
 * are therefore repositioned on the way back out rather than while hidden.
 */
export function toggleMapRegion(mapElement: HTMLElement): boolean {
  const collapsed = mapElement.classList.toggle('is-collapsed');

  const head = mapElement.querySelector<HTMLElement>('[data-map-toggle]');
  head?.setAttribute('aria-expanded', String(!collapsed));

  if (!collapsed) refreshMapPins(mapElement);

  return collapsed;
}

export function mapRegionHtml(
  region: MapRegion,
  index: number,
  total: number,
  options: {
    collapsed?: boolean;
    idPrefix?: string;
    title?: string;
    subtitle?: string;
    iframeTitle?: string;
  } = {},
): string {
  const title =
    options.title ??
    (total > 1 ? `🗺️ Photo trail · map ${index + 1} of ${total}` : '🗺️ Photo trail');

  const sub =
    options.subtitle ??
    (total > 1
      ? 'This day’s photos span more than one part of the world, so each map covers one of them.'
      : MAP_SUB);

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

  const collapsed = options.collapsed ?? false;
  const bodyId = `map-body-${options.idPrefix ?? 'x'}-${region.id}`;

  return (
    `<div class="photo-day-map${collapsed ? ' is-collapsed' : ''}" data-region="${escapeAttr(region.id)}">` +
    // A button, not a div: collapsing is a real control, so it should be
    // focusable and operable from the keyboard for free.
    `<button class="photo-day-map-head" type="button" data-map-toggle` +
    ` aria-expanded="${!collapsed}" aria-controls="${escapeAttr(bodyId)}">` +
    '<span class="photo-day-map-headings">' +
    `<span class="photo-day-map-title">${escapeAttr(title)}</span>` +
    `<span class="photo-day-map-sub">${escapeAttr(sub)}</span>` +
    '</span>' +
    `<span class="photo-day-map-count">${region.taggedCount} tagged</span>` +
    '<span class="photo-day-map-chevron" aria-hidden="true">▾</span>' +
    '</button>' +
    `<div class="photo-day-map-body" id="${escapeAttr(bodyId)}">` +
    `<div class="photo-day-map-canvas" data-map-lat="${region.centerLat}"` +
    ` data-map-lon="${region.centerLon}" data-map-zoom="${region.zoom}"` +
    ` data-map-base-zoom="${region.zoom}">` +
    `<iframe class="photo-google-map" title="${escapeAttr(options.iframeTitle ?? 'Map of this day’s photo locations')}"` +
    ' loading="lazy" referrerpolicy="strict-origin-when-cross-origin"></iframe>' +
    `<div class="photo-map-overlay">${pins}</div>` +
    '<div class="photo-map-zoom" role="group" aria-label="Map zoom controls">' +
    '<button type="button" data-map-zoom-in aria-label="Zoom map in">+</button>' +
    '<button type="button" data-map-zoom-out aria-label="Zoom map out">−</button>' +
    '</div>' +
    '<a class="photo-map-open" target="_blank" rel="noopener">View interactive map ↗</a>' +
    '</div>' +
    `<div class="photo-day-map-legend">${legend}</div>` +
    '</div>' +
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
    wireMapZoom(canvas);
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
  const requestedZoom = Number(canvas.dataset.mapUserZoom);
  const zoom = Number.isFinite(requestedZoom)
    ? clampZoom(requestedZoom)
    : fitZoom(points, width, height, baseZoom, MIN_MAP_ZOOM);
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

  const zoomIn = canvas.querySelector<HTMLButtonElement>('[data-map-zoom-in]');
  const zoomOut = canvas.querySelector<HTMLButtonElement>('[data-map-zoom-out]');
  if (zoomIn) zoomIn.disabled = zoom >= MAX_MAP_ZOOM;
  if (zoomOut) zoomOut.disabled = zoom <= MIN_MAP_ZOOM;
}

function wireMapZoom(canvas: HTMLElement): void {
  if (canvas.dataset.mapZoomWired === '1') return;
  canvas.dataset.mapZoomWired = '1';

  const change = (delta: number, clientX?: number, clientY?: number) => {
    const current = Number(canvas.dataset.mapZoom);
    const oldZoom = clampZoom(Number.isFinite(current) ? current : 1);
    const nextZoom = clampZoom(oldZoom + delta);
    if (nextZoom === oldZoom) return;

    if (clientX != null && clientY != null) {
      const rect = canvas.getBoundingClientRect();
      const offsetX = clientX - rect.left - rect.width / 2;
      const offsetY = clientY - rect.top - rect.height / 2;
      const oldSize = worldSizeAt(oldZoom);
      const nextSize = worldSizeAt(nextZoom);
      const centerLon = Number(canvas.dataset.mapLon);
      const centerLat = Number(canvas.dataset.mapLat);
      const focusX = (((centerLon + 180) / 360) * oldSize + offsetX) / oldSize;
      const focusY = (mercatorY(centerLat) * oldSize + offsetY) / oldSize;
      const nextCenterX = focusX * nextSize - offsetX;
      const nextCenterY = focusY * nextSize - offsetY;
      canvas.dataset.mapLon = String((nextCenterX / nextSize) * 360 - 180);
      canvas.dataset.mapLat = String(latitudeFromMercator(nextCenterY / nextSize));
    }

    canvas.dataset.mapUserZoom = String(nextZoom);
    positionPins(canvas);
  };

  canvas.querySelector('[data-map-zoom-in]')?.addEventListener('click', () => change(1));
  canvas.querySelector('[data-map-zoom-out]')?.addEventListener('click', () => change(-1));
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    change(event.deltaY < 0 ? 1 : -1, event.clientX, event.clientY);
  }, { passive: false });

  let pinchDistance = 0;
  const distance = (first: Touch, second: Touch) =>
    Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);

  canvas.addEventListener('touchstart', (event) => {
    if (event.touches.length !== 2) return;
    const first = event.touches[0];
    const second = event.touches[1];
    if (!first || !second) return;
    event.preventDefault();
    pinchDistance = distance(first, second);
  }, { passive: false });
  canvas.addEventListener('touchmove', (event) => {
    if (event.touches.length !== 2 || pinchDistance <= 0) return;
    const first = event.touches[0];
    const second = event.touches[1];
    if (!first || !second) return;
    event.preventDefault();
    const nextDistance = distance(first, second);
    if (Math.abs(nextDistance - pinchDistance) < 28) return;
    change(
      nextDistance > pinchDistance ? 1 : -1,
      (first.clientX + second.clientX) / 2,
      (first.clientY + second.clientY) / 2,
    );
    pinchDistance = nextDistance;
  }, { passive: false });
  const endPinch = (event: TouchEvent) => {
    if (event.touches.length < 2) pinchDistance = 0;
  };
  canvas.addEventListener('touchend', endPinch, { passive: true });
  canvas.addEventListener('touchcancel', endPinch, { passive: true });
}

function clampZoom(zoom: number): number {
  return Math.min(MAX_MAP_ZOOM, Math.max(MIN_MAP_ZOOM, Math.round(zoom)));
}
