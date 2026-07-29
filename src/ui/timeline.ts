import type { DayGroup, Photo } from '../types';
import { escapeAttr } from '../util/escape';
import { formatCaptured } from '../meta/datetime';
import { clearDayFilter, dayGroupHtml, filterDayByCluster, type LightboxCollector } from './dayGroup';
import { observeMaps, refreshMapPins } from './photoMap';
import { openLightbox, setLightboxItems, type LightboxItem } from './lightbox';

/**
 * Renders the whole timeline and owns its interactions.
 *
 * Clicks are handled by delegation on the container, so re-rendering never
 * needs to detach listeners and nothing has to be published on `window` the way
 * the reference's inline `onclick` handlers required.
 */

class Collector implements LightboxCollector {
  readonly items: LightboxItem[] = [];

  add(photo: Photo): number {
    // Photos we couldn't decode have nothing to show full-size.
    if (photo.previewUnavailable || !photo.thumbUrl) return -1;

    return (
      this.items.push({
        photoId: photo.id,
        title: photo.name,
        location: photo.caption?.location ?? '',
        desc: photo.caption?.desc ?? '',
        mapsUrl: photo.caption?.mapsUrl ?? '',
        captured: formatCaptured(photo.meta.takenAt, photo.meta.tzOffsetMinutes),
      }) - 1
    );
  }
}

let delegated = false;

export function renderTimeline(
  days: DayGroup[],
  container: HTMLElement,
  strip: HTMLElement,
): void {
  const collector = new Collector();

  container.innerHTML = days.map((day) => dayGroupHtml(day, collector)).join('');
  setLightboxItems(collector.items);

  renderDayStrip(days, strip);
  wireDelegation(container);

  // Pins can only be placed once the canvases have a measured size. The second
  // pass catches layout that settles late — web fonts, scrollbar appearing.
  refreshMapPins(container);
  requestAnimationFrame(() => refreshMapPins(container));
  observeMaps(container);
}

function renderDayStrip(days: DayGroup[], strip: HTMLElement): void {
  strip.hidden = days.length < 2;
  if (strip.hidden) {
    strip.innerHTML = '';
    return;
  }

  strip.innerHTML = days
    .map(
      (day) =>
        `<button class="day-chip" type="button" data-jump="${escapeAttr(day.dayKey)}">` +
        `${escapeAttr(day.label)}<b>${day.photos.length}</b></button>`,
    )
    .join('');

  strip.onclick = (event) => {
    const chip = (event.target as HTMLElement).closest<HTMLElement>('[data-jump]');
    if (!chip?.dataset.jump) return;
    document
      .getElementById(`day-${chip.dataset.jump}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
}

function wireDelegation(container: HTMLElement): void {
  if (delegated) return;
  delegated = true;

  container.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;

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

    // Pins and legend chips are two views of the same action.
    const selector = target.closest<HTMLElement>('.photo-map-pin-html, .photo-map-place');
    if (!selector?.dataset.cluster) return;

    const alreadyActive =
      section
        .querySelector<HTMLElement>('.photo-map-pin-html.is-active')
        ?.dataset.cluster === selector.dataset.cluster;

    // Clicking the active pin again is the natural way to undo the filter.
    if (alreadyActive) clearDayFilter(section);
    else filterDayByCluster(section, selector.dataset.cluster, selector.dataset.place ?? '');
  });
}
