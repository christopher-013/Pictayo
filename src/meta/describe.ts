import type { Caption, Photo, PlaceCluster } from '../types';
import { formatClock, timeOfDayPhrase } from './datetime';
import { googleMapsUrl } from '../geo/geocode';

/**
 * Turning metadata into a caption.
 *
 * Everything here is derived from EXIF and reverse geocoding, which bounds what
 * a caption can honestly say: metadata knows *where* and *when* a photo was
 * taken, never *what is in it*. So these read "Afternoon at Takadanobaba,
 * Tokyo — one of 12 photos from this spot, 4:42–5:33 PM" rather than describing
 * the scene.
 *
 * {@link DescriptionProvider} exists so that limit is swappable: a provider
 * backed by a vision model can be dropped in as a new implementation without
 * touching the pipeline, the store, or the UI.
 */

export interface DescriptionContext {
  photo: Photo;
  /** Null when the photo has no usable GPS. */
  cluster: PlaceCluster | null;
  /** How many photos share this cluster. */
  clusterSize: number;
}

export interface DescriptionProvider {
  describe(context: DescriptionContext): Caption | Promise<Caption>;
}

export class MetadataDescriber implements DescriptionProvider {
  describe({ photo, cluster, clusterSize }: DescriptionContext): Caption {
    const location = cluster?.place ?? '';
    const mapsUrl = cluster ? googleMapsUrl(cluster.lat, cluster.lon) : '';

    return { location, desc: this.compose(photo, cluster, clusterSize), mapsUrl };
  }

  private compose(photo: Photo, cluster: PlaceCluster | null, clusterSize: number): string {
    const when = timeOfDayPhrase(photo.meta.takenAt);

    if (!cluster) return this.withoutLocation(photo, when);

    const parts = [when ? `${capitalize(when)} at ${cluster.place}.` : `At ${cluster.place}.`];

    if (clusterSize > 1) {
      const span = formatSpan(cluster.firstAt, cluster.lastAt);
      const company = `One of ${clusterSize} photos from this spot`;
      parts.push(span ? `${company}, ${span}.` : `${company}.`);
    }

    // The time is only as trustworthy as its source. Say so rather than let a
    // copied or re-encoded file present its modification date as a capture time.
    if (photo.meta.dateSource === 'file') {
      parts.push('Time taken from the file date, not the camera.');
    }

    return parts.join(' ');
  }

  private withoutLocation(photo: Photo, when: string): string {
    const camera = cameraName(photo.meta.make, photo.meta.model);

    if (photo.meta.takenAt === null) {
      return camera
        ? `No date or location recorded. Shot on ${camera}.`
        : 'No date or location recorded.';
    }

    // Be explicit when the date came from the file rather than the camera — a
    // copied or edited file can carry a timestamp that has nothing to do with
    // when the photo was actually taken.
    const guessed = photo.meta.dateSource === 'file';
    const base = guessed
      ? `${capitalize(when)}, by file date — no location recorded.`
      : `${capitalize(when)}, no location recorded.`;

    return camera ? `${base} Shot on ${camera}.` : base;
  }
}

/** "4:42–5:33 PM", collapsing to a single time when the span is a moment. */
function formatSpan(firstAt: number | null, lastAt: number | null): string {
  if (firstAt === null || lastAt === null) return '';

  const start = formatClock(firstAt);
  const end = formatClock(lastAt);
  if (!start || !end) return '';
  if (start === end) return start;

  // "4:42 PM–5:33 PM" reads better as "4:42–5:33 PM" when both share a meridiem.
  const startMeridiem = start.slice(-2);
  const endMeridiem = end.slice(-2);
  if (startMeridiem === endMeridiem) return `${start.slice(0, -3)}–${end}`;

  return `${start}–${end}`;
}

/** Camera makers often repeat the brand in the model ("Canon Canon EOS R6"). */
function cameraName(make: string | null, model: string | null): string {
  if (model && make && model.toLowerCase().startsWith(make.toLowerCase())) return model;
  if (make && model) return `${make} ${model}`;
  return model ?? make ?? '';
}

function capitalize(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}
