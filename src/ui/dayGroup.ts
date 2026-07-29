import type { DayGroup, Photo } from '../types';
import { escapeAttr } from '../util/escape';
import { photoCardHtml } from './photoCard';
import { mapRegionHtml, mapsCollapsed } from './photoMap';

/**
 * One day's section: heading, map(s), filter bar, and the photo grid.
 *
 * The reference rendered a single day at a time and so addressed its grid and
 * filter bar by unique id. Showing the whole timeline at once means every day
 * needs its own, hence the `data-` hooks and the section-scoped filter helpers
 * below — filtering day 2 must not touch day 1.
 */

export interface LightboxCollector {
  /** Registers a photo and returns its lightbox index, or -1 if unviewable. */
  add(photo: Photo): number;
}

export function dayGroupHtml(day: DayGroup, collector: LightboxCollector): string {
  const cards = day.photos
    .map((photo) => photoCardHtml({ photo, lightboxIndex: collector.add(photo) }))
    .join('');

  const collapsed = mapsCollapsed();
  const maps = day.regions
    .map((region, index) =>
      mapRegionHtml(region, index, day.regions.length, { collapsed, idPrefix: day.dayKey }),
    )
    .join('');

  const untagged = day.photos.length - day.taggedCount;

  // Photos first, map after.
  //
  // The map is context for the photos rather than the point of the page, and
  // leading with it pushed the first row of thumbnails below the fold. The
  // filter bar stays above the grid, where it belongs — it explains why the
  // grid is showing fewer photos than the day holds.
  return (
    `<section class="day-section" id="day-${escapeAttr(day.dayKey)}" data-day="${escapeAttr(day.dayKey)}">` +
    `<div class="sec-label">${escapeAttr(day.label)} · Photos</div>` +
    '<div class="photo-filter-bar" data-filter-bar>' +
    '<span data-filter-label></span>' +
    '<button class="photo-filter-clear" type="button" data-filter-clear>Show all photos</button>' +
    '</div>' +
    `<div class="photo-grid">${cards}</div>` +
    '<div class="photo-empty" data-empty hidden>No photos match this filter.</div>' +
    (maps || noMapNoticeHtml(day)) +
    (untagged > 0 && maps ? untaggedNoticeHtml(untagged) : '') +
    '</section>'
  );
}

function noMapNoticeHtml(day: DayGroup): string {
  const count = day.photos.length;
  return (
    '<div class="photo-empty">' +
    `None of the ${count} photo${count === 1 ? '' : 's'} from this day carry location data, ` +
    'so there’s nothing to plot.' +
    '</div>'
  );
}

function untaggedNoticeHtml(count: number): string {
  return (
    '<div class="photo-map-note">' +
    `📍 ${count} photo${count === 1 ? '' : 's'} from this day ` +
    `${count === 1 ? 'has' : 'have'} no location data, so ${count === 1 ? 'it isn’t' : 'they aren’t'} on the map.` +
    '</div>'
  );
}

/**
 * Filter a day down to one place cluster.
 *
 * Keyed on cluster id rather than the place name the reference used: two
 * genuinely separate stops can reverse-geocode to the same name, and matching
 * on the name would make one pin light up the other's photos too.
 */
export function filterDayByCluster(section: HTMLElement, clusterId: string, place: string): void {
  let shown = 0;

  for (const card of section.querySelectorAll<HTMLElement>('.photo-card')) {
    const matches = card.dataset.cluster === clusterId;
    card.classList.toggle('photo-map-filter-hidden', !matches);
    if (matches) shown += 1;
  }

  for (const pin of section.querySelectorAll<HTMLElement>('.photo-map-pin-html')) {
    pin.classList.toggle('is-active', pin.dataset.cluster === clusterId);
  }

  const bar = section.querySelector<HTMLElement>('[data-filter-bar]');
  const label = section.querySelector<HTMLElement>('[data-filter-label]');
  if (label) label.textContent = `📍 ${place} · ${shown} photo${shown === 1 ? '' : 's'}`;
  bar?.classList.add('active');

  updateEmptyState(section, shown);
}

export function clearDayFilter(section: HTMLElement): void {
  for (const card of section.querySelectorAll<HTMLElement>('.photo-card')) {
    card.classList.remove('photo-map-filter-hidden');
  }
  for (const pin of section.querySelectorAll<HTMLElement>('.photo-map-pin-html')) {
    pin.classList.remove('is-active');
  }

  section.querySelector<HTMLElement>('[data-filter-bar]')?.classList.remove('active');
  updateEmptyState(section, section.querySelectorAll('.photo-card').length);
}

function updateEmptyState(section: HTMLElement, visible: number): void {
  const empty = section.querySelector<HTMLElement>('[data-empty]');
  if (empty) empty.hidden = visible > 0;
}
