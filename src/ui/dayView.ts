import type { DayGroup, MapRegion, Photo, PlaceCluster } from '../types';
import { escapeAttr } from '../util/escape';
import { formatCaptured } from '../meta/datetime';
import { chipParts, placesFor } from './dayChip';
import { clearDayFilter, dayGroupHtml, filterDayByCluster, type LightboxCollector } from './dayGroup';
import {
  mapRegionHtml,
  observeMaps,
  refreshMapPins,
  setMapsCollapsed,
  toggleMapRegion,
} from './photoMap';
import { openLightbox, setLightboxItems, type LightboxItem } from './lightbox';
import { centerOf, fitZoom } from '../geo/mercator';

/**
 * Shows one day at a time, with a date strip for moving between them.
 *
 * A single scrolling timeline stopped being workable once a library ran to a
 * few hundred photos — every day's maps and thumbnails were live at once. Each
 * day is now its own page, mirroring the Tokyo2026 site, and only the visible
 * day builds any DOM.
 *
 * The selected day lives in the URL hash, so the back button steps through the
 * days you visited and a link to a particular day survives a reload.
 */

const HASH_PREFIX = '#day/';
const EVERYWHERE_HASH = '#everywhere';
const EVERYWHERE_KEY = 'everywhere';

class Collector implements LightboxCollector {
  readonly items: LightboxItem[] = [];

  add(photo: Photo): number {
    // Videos are in the list alongside photos, so the arrows step through the
    // day in the order it happened rather than skipping the clips.
    //
    // A video with no poster still belongs: it was decodable enough to import,
    // and the lightbox can play it even where the grid has nothing to show.
    if (photo.kind === 'photo' && (photo.previewUnavailable || !photo.thumbUrl)) return -1;

    return (
      this.items.push({
        photoId: photo.id,
        kind: photo.kind,
        title: photo.name,
        location: photo.caption?.location ?? '',
        desc: photo.caption?.desc ?? '',
        mapsUrl: photo.caption?.mapsUrl ?? '',
        dining: photo.caption?.dining ?? '',
        captured: formatCaptured(photo.meta.takenAt, photo.meta.tzOffsetMinutes),
      }) - 1
    );
  }
}

let days: DayGroup[] = [];
let activeKey: string | null = null;
let nav: HTMLElement;
let page: HTMLElement;
let wired = false;
let removePhoto: (photoId: string) => void = () => undefined;
let everywhereClusterDays = new Map<string, string>();

export function initDayView(
  navElement: HTMLElement,
  pageElement: HTMLElement,
  onRemovePhoto: (photoId: string) => void,
): void {
  nav = navElement;
  page = pageElement;
  removePhoto = onRemovePhoto;

  window.addEventListener('hashchange', () => {
    const key = keyFromHash();
    if (!key || key === activeKey) return;
    if (key === EVERYWHERE_KEY) showEverywhere(false);
    else if (days.some((d) => d.dayKey === key)) showDay(key, false);
  });
}

/** Replaces the library. Keeps the current day selected when it still exists. */
export function setDays(next: DayGroup[]): void {
  days = next;

  if (days.length === 0) {
    activeKey = null;
    nav.hidden = true;
    nav.innerHTML = '';
    page.innerHTML = '';
    setLightboxItems([]);
    return;
  }

  const requested = keyFromHash();
  const preferred = [requested, activeKey].find(
    (key) => key === EVERYWHERE_KEY || (key && days.some((day) => day.dayKey === key)),
  );

  if (preferred === EVERYWHERE_KEY) showEverywhere(true);
  else showDay(preferred ?? days[0]!.dayKey, true);
}

function showEverywhere(replaceHash: boolean): void {
  activeKey = EVERYWHERE_KEY;
  renderNav();
  renderEverywherePage();
  syncHash(EVERYWHERE_KEY, replaceHash);
  wireDelegation();
}

export function showDay(dayKey: string, replaceHash: boolean): void {
  const day = days.find((d) => d.dayKey === dayKey);
  if (!day) return;

  activeKey = dayKey;

  renderNav();
  renderPage(day);
  syncHash(dayKey, replaceHash);
  wireDelegation();
}

function renderPage(day: DayGroup): void {
  const collector = new Collector();

  page.setAttribute('aria-labelledby', `day-tab-${day.dayKey}`);
  page.innerHTML = dayGroupHtml(day, collector);
  // Lightbox navigation stays within the day being viewed, so its counter
  // reads "3 / 12" for that day rather than a position in the whole library.
  setLightboxItems(collector.items);

  refreshMapPins(page);
  requestAnimationFrame(() => refreshMapPins(page));
  observeMaps(page);
}

function renderEverywherePage(): void {
  const clusters: PlaceCluster[] = [];
  everywhereClusterDays = new Map();

  for (const day of days) {
    for (const cluster of day.regions.flatMap((region) => region.clusters)) {
      const id = `everywhere-${day.dayKey}-${cluster.id}`;
      clusters.push({ ...cluster, id });
      everywhereClusterDays.set(id, day.dayKey);
    }
  }

  page.setAttribute('aria-labelledby', 'day-tab-everywhere');
  setLightboxItems([]);

  if (clusters.length === 0) {
    page.innerHTML =
      '<section class="day-section everywhere-section">' +
      '<div class="sec-label">🌍 Everywhere I Have Been</div>' +
      '<div class="photo-empty">None of the imported photos carry location data yet.</div>' +
      '</section>';
    return;
  }

  const points = clusters.map(({ lat, lon }) => ({ lat, lon }));
  const center = centerOf(points);
  const region: MapRegion = {
    id: EVERYWHERE_KEY,
    clusters,
    centerLat: center.lat,
    centerLon: center.lon,
    // Preserve geographic context when every photo is concentrated in one city.
    zoom: fitZoom(points, 800, 450, 8, 1),
    taggedCount: clusters.reduce((sum, cluster) => sum + cluster.photoIds.length, 0),
  };
  const totalItems = days.reduce((sum, day) => sum + day.photos.length, 0);
  const untagged = totalItems - region.taggedCount;

  page.innerHTML =
    '<section class="day-section everywhere-section">' +
    '<div class="sec-label">🌍 Everywhere I Have Been</div>' +
    mapRegionHtml(region, 0, 1, {
      collapsed: false,
      idPrefix: EVERYWHERE_KEY,
      title: '🌍 All photo locations',
      subtitle: 'Every geotagged stop in the library. Scroll or use +/− to zoom; pinch on mobile.',
      iframeTitle: 'World map of all photo locations',
    }) +
    (untagged > 0
      ? `<div class="photo-map-note">📍 ${untagged} item${untagged === 1 ? '' : 's'} without location data ${untagged === 1 ? 'is' : 'are'} not shown.</div>`
      : '') +
    '</section>';

  refreshMapPins(page);
  requestAnimationFrame(() => refreshMapPins(page));
  observeMaps(page);
}

function renderNav(): void {
  // Shown from the first day onwards. A single chip still tells you which day
  // you are looking at, and the strip appearing only once a second day exists
  // made the page seem to change shape on the next import.
  nav.hidden = days.length === 0;
  if (nav.hidden) {
    nav.innerHTML = '';
    return;
  }

  nav.innerHTML =
    '<div class="day-nav-scroll" role="tablist">' +
    days.map((day) => chipHtml(day)).join('') +
    everywhereChipHtml() +
    '</div>';

  // Keep the selected day visible when the strip is wider than the screen.
  nav
    .querySelector<HTMLElement>('.day-chip.is-active')
    ?.scrollIntoView({ block: 'nearest', inline: 'center' });
}

function everywhereChipHtml(): string {
  const active = activeKey === EVERYWHERE_KEY;
  return (
    `<button class="day-chip everywhere-chip${active ? ' is-active' : ''}" type="button" role="tab"` +
    ' id="day-tab-everywhere" data-everywhere aria-controls="day-page"' +
    ` aria-selected="${active}" tabindex="${active ? '0' : '-1'}"` +
    ' title="Show all photo locations">' +
    '<span class="everywhere-chip-globe" aria-hidden="true">🌍</span>' +
    '<span class="day-chip-where everywhere-chip-label">Show All</span>' +
    '</button>'
  );
}

function chipHtml(day: DayGroup): string {
  const active = day.dayKey === activeKey;
  const parts = chipParts(day);
  const places = placesFor(day);
  const count = day.photos.length;

  const tooltip = places.all.length
    ? `${day.label} — ${places.all.join(', ')} · ${count} photo${count === 1 ? '' : 's'}`
    : `${day.label} — ${count} photo${count === 1 ? '' : 's'}`;

  return (
    `<button class="day-chip${active ? ' is-active' : ''}" type="button" role="tab"` +
    ` id="day-tab-${escapeAttr(day.dayKey)}" data-day="${escapeAttr(day.dayKey)}"` +
    ` aria-controls="day-page" aria-selected="${active}" tabindex="${active ? '0' : '-1'}"` +
    ` title="${escapeAttr(tooltip)}">` +
    `<span class="day-chip-mon">${escapeAttr(parts.month)}</span>` +
    `<span class="day-chip-num">${escapeAttr(parts.number)}</span>` +
    `<span class="day-chip-dow">${escapeAttr(parts.weekday)}</span>` +
    `<span class="day-chip-where">${escapeAttr(places.label)}</span>` +
    '</button>'
  );
}

function wireDelegation(): void {
  if (wired) return;
  wired = true;

  nav.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    if (target.closest('[data-everywhere]')) {
      if (activeKey !== EVERYWHERE_KEY) activateEverywhere();
      return;
    }
    const chip = target.closest<HTMLElement>('[data-day]');
    if (chip?.dataset.day && chip.dataset.day !== activeKey) {
      activateDay(chip.dataset.day);
    }
  });

  nav.addEventListener('keydown', (event) => {
    const chip = (event.target as HTMLElement).closest<HTMLElement>('[role="tab"]');
    if (!chip) return;

    const chips = [...nav.querySelectorAll<HTMLElement>('[role="tab"]')];
    const current = chips.indexOf(chip);
    if (current < 0) return;

    let next = current;
    if (event.key === 'ArrowLeft') next = Math.max(0, current - 1);
    else if (event.key === 'ArrowRight') next = Math.min(chips.length - 1, current + 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = chips.length - 1;
    else return;

    event.preventDefault();
    const nextChip = chips[next];
    if (!nextChip) return;
    if (nextChip.hasAttribute('data-everywhere')) activateEverywhere();
    else if (nextChip.dataset.day) activateDay(nextChip.dataset.day);
    nextChip.focus();
  });

  page.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;

    const removeButton = target.closest<HTMLElement>('[data-remove-photo]');
    if (removeButton?.dataset.removePhoto) {
      removePhoto(removeButton.dataset.removePhoto);
      return;
    }

    const mapToggle = target.closest<HTMLElement>('[data-map-toggle]');
    if (mapToggle) {
      const mapElement = mapToggle.closest<HTMLElement>('.photo-day-map');
      if (mapElement) setMapsCollapsed(toggleMapRegion(mapElement));
      return;
    }

    const everywhereSelector = target.closest<HTMLElement>(
      '.everywhere-section .photo-map-pin-html, .everywhere-section .photo-map-place',
    );
    if (everywhereSelector?.dataset.cluster) {
      const dayKey = everywhereClusterDays.get(everywhereSelector.dataset.cluster);
      if (dayKey) activateDay(dayKey);
      return;
    }

    const opener = target.closest<HTMLElement>('[data-lightbox-index]');
    if (opener) {
      openLightbox(Number(opener.dataset.lightboxIndex));
      return;
    }

    const section = target.closest<HTMLElement>('.day-section');
    if (!section) return;

    if (target.closest('[data-filter-clear]')) {
      clearDayFilter(section);
      return;
    }

    const selector = target.closest<HTMLElement>('.photo-map-pin-html, .photo-map-place');
    if (!selector?.dataset.cluster) return;

    const alreadyActive =
      section.querySelector<HTMLElement>('.photo-map-pin-html.is-active')?.dataset.cluster ===
      selector.dataset.cluster;

    if (alreadyActive) clearDayFilter(section);
    else filterDayByCluster(section, selector.dataset.cluster, selector.dataset.place ?? '');
  });
}

function activateEverywhere(): void {
  if (activeKey !== EVERYWHERE_KEY) showEverywhere(false);
  window.scrollTo({ top: 0, behavior: 'auto' });
}

function activateDay(dayKey: string): void {
  if (dayKey !== activeKey) showDay(dayKey, false);
  // A new page should start at the top, not wherever the last one was.
  window.scrollTo({ top: 0, behavior: 'auto' });
}

function keyFromHash(): string | null {
  const hash = window.location.hash;
  if (hash === EVERYWHERE_HASH) return EVERYWHERE_KEY;
  return hash.startsWith(HASH_PREFIX) ? decodeURIComponent(hash.slice(HASH_PREFIX.length)) : null;
}

function syncHash(dayKey: string, replace: boolean): void {
  const wanted =
    dayKey === EVERYWHERE_KEY ? EVERYWHERE_HASH : `${HASH_PREFIX}${encodeURIComponent(dayKey)}`;
  if (window.location.hash === wanted) return;

  const url = `${window.location.pathname}${window.location.search}${wanted}`;
  // Replacing on the initial render avoids leaving an entry that goes "back"
  // to the same page the user just arrived on.
  if (replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
}
