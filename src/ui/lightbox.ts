import { displayUrlFor } from './media';

/**
 * Full-size photo viewer, ported from the Tokyo2026 gallery: keyboard nav,
 * swipe on touch, click-outside to dismiss.
 *
 * Differs from the reference in one way that matters — the image source is
 * resolved lazily from IndexedDB when a photo is shown, rather than being baked
 * into the markup, so opening a 900-photo library doesn't materialize 900
 * full-size blob URLs.
 */

export interface LightboxItem {
  photoId: string;
  title: string;
  location: string;
  desc: string;
  mapsUrl: string;
  captured: string;
}

const SWIPE_THRESHOLD_PX = 45;

let items: LightboxItem[] = [];
let index = -1;
let touchStartX = 0;
let touchStartY = 0;

let root: HTMLElement;
let image: HTMLImageElement;
let titleEl: HTMLElement;
let locationEl: HTMLElement;
let descEl: HTMLElement;
let capturedEl: HTMLElement;
let countEl: HTMLElement;
let prevButton: HTMLButtonElement;
let nextButton: HTMLButtonElement;

export function initLightbox(): void {
  root = must('photo-lightbox');
  image = must<HTMLImageElement>('photo-lightbox-image');
  titleEl = must('photo-lightbox-title');
  locationEl = must('photo-lightbox-location');
  descEl = must('photo-lightbox-desc');
  capturedEl = must('photo-lightbox-captured');
  countEl = must('photo-lightbox-count');
  prevButton = must<HTMLButtonElement>('photo-lightbox-prev');
  nextButton = must<HTMLButtonElement>('photo-lightbox-next');

  must('photo-lightbox-close').addEventListener('click', closeLightbox);
  prevButton.addEventListener('click', () => navigate(-1));
  nextButton.addEventListener('click', () => navigate(1));

  // Backdrop click only — a click that lands on the dialog itself should not close.
  root.addEventListener('click', (event) => {
    if (event.target === root) closeLightbox();
  });

  document.addEventListener('keydown', (event) => {
    if (!root.classList.contains('open')) return;
    if (event.key === 'Escape') closeLightbox();
    else if (event.key === 'ArrowLeft') navigate(-1);
    else if (event.key === 'ArrowRight') navigate(1);
  });

  const stage = must('photo-lightbox-stage');
  stage.addEventListener('touchstart', (event) => {
    const touch = event.changedTouches[0];
    if (!touch) return;
    touchStartX = touch.clientX;
    touchStartY = touch.clientY;
  }, { passive: true });

  stage.addEventListener('touchend', (event) => {
    const touch = event.changedTouches[0];
    if (!touch) return;
    const dx = touch.clientX - touchStartX;
    const dy = touch.clientY - touchStartY;
    // Ignore mostly-vertical drags so scrolling still works.
    if (Math.abs(dx) > SWIPE_THRESHOLD_PX && Math.abs(dx) > Math.abs(dy)) {
      navigate(dx < 0 ? 1 : -1);
    }
  }, { passive: true });
}

export function setLightboxItems(next: LightboxItem[]): void {
  items = next;
  if (index >= items.length) closeLightbox();
}

export function openLightbox(at: number): void {
  if (items.length === 0) return;

  index = Math.max(0, Math.min(at, items.length - 1));
  void render();

  root.classList.add('open');
  root.setAttribute('aria-hidden', 'false');
  document.body.classList.add('photo-lightbox-open');
}

export function closeLightbox(): void {
  root.classList.remove('open');
  root.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('photo-lightbox-open');
  index = -1;
  image.removeAttribute('src');
  image.alt = '';
}

function navigate(direction: number): void {
  const next = index + direction;
  if (next < 0 || next >= items.length) return;
  index = next;
  void render();
}

async function render(): Promise<void> {
  const item = items[index];
  if (!item) return;

  titleEl.textContent = item.title;
  countEl.textContent = `${index + 1} / ${items.length}`;
  prevButton.disabled = index <= 0;
  nextButton.disabled = index >= items.length - 1;

  locationEl.replaceChildren();
  locationEl.style.display = item.location ? 'block' : 'none';
  if (item.location) {
    locationEl.append('📍 ');
    if (item.mapsUrl) {
      const link = document.createElement('a');
      link.href = item.mapsUrl;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = item.location;
      locationEl.append(link);
    } else {
      locationEl.append(item.location);
    }
  }

  descEl.textContent = item.desc;
  descEl.style.display = item.desc ? 'block' : 'none';
  capturedEl.textContent = item.captured ? `🕒 ${item.captured}` : '';
  capturedEl.style.display = item.captured ? 'block' : 'none';

  // Guard against a slow blob read landing after the user has already moved on.
  const requested = item.photoId;
  const url = await displayUrlFor(requested);
  if (items[index]?.photoId !== requested) return;

  if (url) {
    image.src = url;
    image.alt = item.title;
  } else {
    image.removeAttribute('src');
    image.alt = '';
  }
}

function must<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}
