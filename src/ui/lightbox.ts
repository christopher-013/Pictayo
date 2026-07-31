import { displayUrlFor, videoUrlFor } from './media';

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
  kind: 'photo' | 'video';
  title: string;
  location: string;
  desc: string;
  mapsUrl: string;
  dining: string;
  captured: string;
}

const SWIPE_THRESHOLD_PX = 45;
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.5;

let items: LightboxItem[] = [];
let index = -1;
let touchStartX = 0;
let touchStartY = 0;
let swipeTracking = false;
let gestureWasPinch = false;
let zoomScale = MIN_ZOOM;
let pinchStartDistance = 0;
let pinchStartScale = MIN_ZOOM;
let pinchActive = false;
let suppressImageClick = false;

let root: HTMLElement;
let image: HTMLImageElement;
let video: HTMLVideoElement;
let titleEl: HTMLElement;
let locationEl: HTMLElement;
let diningEl: HTMLElement;
let descEl: HTMLElement;
let capturedEl: HTMLElement;
let countEl: HTMLElement;
let prevButton: HTMLButtonElement;
let nextButton: HTMLButtonElement;
let closeButton: HTMLButtonElement;
let zoomControls: HTMLElement;
let zoomOutButton: HTMLButtonElement;
let zoomResetButton: HTMLButtonElement;
let zoomInButton: HTMLButtonElement;
let returnFocus: HTMLElement | null = null;
let backgroundState: Array<{ element: HTMLElement; inert: boolean }> = [];

export function initLightbox(): void {
  root = must('photo-lightbox');
  image = must<HTMLImageElement>('photo-lightbox-image');
  video = must<HTMLVideoElement>('photo-lightbox-video');
  titleEl = must('photo-lightbox-title');
  locationEl = must('photo-lightbox-location');
  diningEl = must('photo-lightbox-dining');
  descEl = must('photo-lightbox-desc');
  capturedEl = must('photo-lightbox-captured');
  countEl = must('photo-lightbox-count');
  prevButton = must<HTMLButtonElement>('photo-lightbox-prev');
  nextButton = must<HTMLButtonElement>('photo-lightbox-next');
  zoomControls = must('photo-lightbox-zoom');
  zoomOutButton = must<HTMLButtonElement>('photo-lightbox-zoom-out');
  zoomResetButton = must<HTMLButtonElement>('photo-lightbox-zoom-reset');
  zoomInButton = must<HTMLButtonElement>('photo-lightbox-zoom-in');

  closeButton = must<HTMLButtonElement>('photo-lightbox-close');
  closeButton.addEventListener('click', closeLightbox);
  prevButton.addEventListener('click', () => navigate(-1));
  nextButton.addEventListener('click', () => navigate(1));
  zoomOutButton.addEventListener('click', () => setZoom(zoomScale - ZOOM_STEP));
  zoomResetButton.addEventListener('click', resetZoom);
  zoomInButton.addEventListener('click', () => setZoom(zoomScale + ZOOM_STEP));

  image.addEventListener('click', (event) => {
    if (suppressImageClick) return;
    if (zoomScale > MIN_ZOOM) {
      resetZoom();
      return;
    }

    const rect = image.getBoundingClientRect();
    setZoomOrigin(event.clientX - rect.left, event.clientY - rect.top, rect);
    setZoom(2);
  });

  image.addEventListener('touchstart', startPinch, { passive: false });
  image.addEventListener('touchmove', movePinch, { passive: false });
  image.addEventListener('touchend', endPinch, { passive: false });
  image.addEventListener('touchcancel', endPinch, { passive: false });

  // Backdrop click only — a click that lands on the dialog itself should not close.
  root.addEventListener('click', (event) => {
    if (event.target === root) closeLightbox();
  });

  document.addEventListener('keydown', (event) => {
    if (!root.classList.contains('open')) return;

    if (event.key === 'Escape') {
      closeLightbox();
    } else if (event.key === 'Tab') {
      trapFocus(event);
    } else if ((event.key === '+' || event.key === '=') && !image.hidden) {
      event.preventDefault();
      setZoom(zoomScale + ZOOM_STEP);
    } else if (event.key === '-' && !image.hidden) {
      event.preventDefault();
      setZoom(zoomScale - ZOOM_STEP);
    } else if (event.key === '0' && !image.hidden) {
      event.preventDefault();
      resetZoom();
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      // Claimed before the native video controls can act on them: once a clip
      // has focus its own handler seeks on arrow keys, so without this the same
      // press would both scrub the video and move to the next item.
      event.preventDefault();
      navigate(event.key === 'ArrowLeft' ? -1 : 1);
    }
  });

  const stage = must('photo-lightbox-stage');
  stage.addEventListener('touchstart', (event) => {
    swipeTracking = event.touches.length === 1 && zoomScale === MIN_ZOOM;
    if (!swipeTracking) return;
    const touch = event.changedTouches[0];
    if (!touch) return;
    touchStartX = touch.clientX;
    touchStartY = touch.clientY;
  }, { passive: true });

  stage.addEventListener('touchend', (event) => {
    if (!swipeTracking || gestureWasPinch || zoomScale > MIN_ZOOM) {
      swipeTracking = false;
      return;
    }
    const touch = event.changedTouches[0];
    if (!touch) return;
    const dx = touch.clientX - touchStartX;
    const dy = touch.clientY - touchStartY;
    // Ignore mostly-vertical drags so scrolling still works.
    if (Math.abs(dx) > SWIPE_THRESHOLD_PX && Math.abs(dx) > Math.abs(dy)) {
      navigate(dx < 0 ? 1 : -1);
    }
    swipeTracking = false;
  }, { passive: true });
}

export function setLightboxItems(next: LightboxItem[]): void {
  items = next;
  if (index >= items.length) closeLightbox();
}

export function openLightbox(at: number): void {
  if (items.length === 0) return;

  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  index = Math.max(0, Math.min(at, items.length - 1));
  void render();

  root.classList.add('open');
  root.setAttribute('aria-hidden', 'false');
  document.body.classList.add('photo-lightbox-open');
  setBackgroundInert(true);
  requestAnimationFrame(() => closeButton.focus());
}

export function closeLightbox(): void {
  if (!root.classList.contains('open')) return;

  root.classList.remove('open');
  root.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('photo-lightbox-open');
  setBackgroundInert(false);
  index = -1;

  stopVideo();
  resetZoom();
  image.removeAttribute('src');
  image.alt = '';

  const target = returnFocus;
  returnFocus = null;
  if (target?.isConnected) target.focus();
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
  diningEl.textContent = item.dining ? `🍽️ ${item.dining}` : '';
  diningEl.style.display = item.dining ? 'block' : 'none';
  capturedEl.textContent = item.captured ? `🕒 ${item.captured}` : '';
  capturedEl.style.display = item.captured ? 'block' : 'none';

  // Whichever element the last item used has to stop before the next one
  // starts, or a video keeps playing — audible — behind the following photo.
  stopVideo();
  resetZoom();

  const isVideo = item.kind === 'video';
  image.hidden = isVideo;
  video.hidden = !isVideo;
  zoomControls.hidden = isVideo;

  // Guard against a slow blob read landing after the user has already moved on.
  const requested = item.photoId;
  const url = isVideo ? await videoUrlFor(requested) : await displayUrlFor(requested);
  if (items[index]?.photoId !== requested) return;

  if (!url) {
    image.removeAttribute('src');
    image.alt = '';
    return;
  }

  if (isVideo) {
    video.src = url;
    // Opening the lightbox was itself a click, so autoplay is permitted here.
    // If the browser refuses anyway, the controls are right there.
    void video.play().catch(() => undefined);
  } else {
    image.src = url;
    image.alt = item.title;
  }
}

function setZoom(next: number): void {
  zoomScale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
  image.style.transform = `scale(${zoomScale})`;
  image.classList.toggle('is-zoomed', zoomScale > MIN_ZOOM);
  zoomOutButton.disabled = zoomScale <= MIN_ZOOM;
  zoomInButton.disabled = zoomScale >= MAX_ZOOM;
  zoomResetButton.textContent = `${Math.round(zoomScale * 100)}%`;
}

function resetZoom(): void {
  zoomScale = MIN_ZOOM;
  pinchActive = false;
  gestureWasPinch = false;
  image.classList.remove('is-zoomed', 'is-pinching');
  image.style.transform = '';
  image.style.transformOrigin = '';
  if (zoomOutButton) zoomOutButton.disabled = true;
  if (zoomInButton) zoomInButton.disabled = false;
  if (zoomResetButton) zoomResetButton.textContent = '100%';
}

function startPinch(event: TouchEvent): void {
  if (event.touches.length !== 2) return;

  const [first, second] = [event.touches[0], event.touches[1]];
  if (!first || !second) return;

  event.preventDefault();
  pinchActive = true;
  gestureWasPinch = true;
  suppressImageClick = true;
  swipeTracking = false;
  pinchStartDistance = touchDistance(first, second);
  pinchStartScale = zoomScale;
  image.classList.add('is-pinching');

  const rect = image.getBoundingClientRect();
  setZoomOrigin(
    (first.clientX + second.clientX) / 2 - rect.left,
    (first.clientY + second.clientY) / 2 - rect.top,
    rect,
  );
}

function movePinch(event: TouchEvent): void {
  if (!pinchActive || event.touches.length < 2) return;
  const [first, second] = [event.touches[0], event.touches[1]];
  if (!first || !second || pinchStartDistance <= 0) return;

  event.preventDefault();
  setZoom(pinchStartScale * (touchDistance(first, second) / pinchStartDistance));
}

function endPinch(event: TouchEvent): void {
  if (!pinchActive || event.touches.length >= 2) return;
  event.preventDefault();
  pinchActive = false;
  image.classList.remove('is-pinching');
  setTimeout(() => {
    suppressImageClick = false;
    gestureWasPinch = false;
  }, 0);
}

function touchDistance(first: Touch, second: Touch): number {
  return Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
}

function setZoomOrigin(x: number, y: number, rect: DOMRect): void {
  if (rect.width <= 0 || rect.height <= 0) return;
  const left = Math.min(100, Math.max(0, (x / rect.width) * 100));
  const top = Math.min(100, Math.max(0, (y / rect.height) * 100));
  image.style.transformOrigin = `${left}% ${top}%`;
}

function stopVideo(): void {
  if (!video.src) return;
  video.pause();
  video.removeAttribute('src');
  video.load();
}

function trapFocus(event: KeyboardEvent): void {
  const focusable = [
    ...root.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), video[controls], [tabindex]:not([tabindex="-1"])',
    ),
  ].filter((element) => !element.hidden && element.getClientRects().length > 0);

  if (focusable.length === 0) {
    event.preventDefault();
    closeButton.focus();
    return;
  }

  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;

  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function setBackgroundInert(inert: boolean): void {
  if (inert) {
    backgroundState = [...document.body.children]
      .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== root)
      .map((element) => ({ element, inert: element.inert }));
    for (const { element } of backgroundState) element.inert = true;
    return;
  }

  for (const { element, inert: wasInert } of backgroundState) element.inert = wasInert;
  backgroundState = [];
}

function must<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}
