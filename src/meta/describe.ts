import type { Caption, Photo, PlaceCluster } from '../types';
import { timeOfDayPhrase } from './datetime';
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
  describe({ photo, cluster }: DescriptionContext): Caption {
    // "Near" only on the location line and in the sentence — pins and date
    // chips show the bare name, where there is no room for the qualifier.
    const location = cluster
      ? cluster.landmarkNearby
        ? `Near ${cluster.place}`
        : cluster.place
      : '';

    const mapsUrl = cluster ? googleMapsUrl(cluster.lat, cluster.lon) : '';
    const dining = cluster?.nearbyDining
      ? `Nearby place: ${cluster.nearbyDining}${
          cluster.nearbyDiningDistanceMeters && cluster.nearbyDiningDistanceMeters > 0
            ? ` · ${cluster.nearbyDiningDistanceMeters} m`
            : ''
        }.`
      : undefined;

    return { location, desc: this.compose(photo, cluster), mapsUrl, dining };
  }

  private compose(photo: Photo, cluster: PlaceCluster | null): string {
    const when = timeOfDayPhrase(photo.meta.takenAt);

    if (!cluster) return this.withoutLocation(photo, when);

    // When a landmark was found, `place` is the landmark and `area` is the
    // surrounding district — worth naming both, since "Tokyo Dome" alone
    // doesn't say which city. With no landmark the two are equal and the
    // area would just repeat itself.
    const where =
      cluster.area && cluster.area !== cluster.place
        ? `${cluster.place}, ${cluster.area}`
        : cluster.place;

    // "close to" when the landmark was only the nearest one. Claiming you were
    // inside somewhere the app merely guessed at would be worse than saying
    // nothing at all.
    const preposition = cluster.landmarkNearby ? 'close to' : 'at';

    const parts = [
      when ? `${capitalize(when)} ${preposition} ${where}.` : `${capitalize(preposition)} ${where}.`,
    ];

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

/** Camera makers often repeat the brand in the model ("Canon Canon EOS R6"). */
function cameraName(make: string | null, model: string | null): string {
  if (model && make && model.toLowerCase().startsWith(make.toLowerCase())) return model;
  if (make && model) return `${make} ${model}`;
  return model ?? make ?? '';
}

function capitalize(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}
