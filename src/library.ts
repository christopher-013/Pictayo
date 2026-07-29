import type { DayGroup, MapRegion, Photo, PlaceCluster } from './types';
import { clusterPhotos, splitIntoRegions } from './geo/cluster';
import { centerOf, fitZoom } from './geo/mercator';
import { formatCoords, googleMapsUrl, type Geocoder } from './geo/geocode';
import { cachedLandmark, type LandmarkFinder } from './geo/landmark';
import { UNDATED_KEY, formatDayLabel } from './meta/datetime';
import { MetadataDescriber, type DescriptionProvider } from './meta/describe';

/**
 * Assembles raw photos into the day-by-day, place-clustered structure the UI
 * renders: group by capture date, cluster each day's geotags into pins, name
 * those pins, split them across maps when a day spans continents, and caption
 * every photo.
 */

/**
 * The zoom baked into the initial iframe URL is a guess, because the real
 * canvas hasn't been laid out yet. `refreshMapPins` re-fits against the actual
 * element once it's on screen — same two-pass approach as the reference.
 */
const ESTIMATED_CANVAS_WIDTH = 800;
const ESTIMATED_CANVAS_HEIGHT = 450;

export async function buildLibrary(
  photos: Photo[],
  geocoder: Geocoder,
  describer: DescriptionProvider = new MetadataDescriber(),
): Promise<DayGroup[]> {
  const byDay = new Map<string, Photo[]>();

  for (const photo of photos) {
    const key = photo.meta.dayKey ?? UNDATED_KEY;
    const bucket = byDay.get(key);
    if (bucket) bucket.push(photo);
    else byDay.set(key, [photo]);
  }

  const days = await Promise.all(
    [...byDay.entries()].map(([dayKey, dayPhotos]) =>
      buildDay(dayKey, dayPhotos, geocoder, describer),
    ),
  );

  return days.sort(compareDays);
}

async function buildDay(
  dayKey: string,
  photos: Photo[],
  geocoder: Geocoder,
  describer: DescriptionProvider,
): Promise<DayGroup> {
  photos.sort((a, b) => (a.meta.takenAt ?? 0) - (b.meta.takenAt ?? 0));

  const clusters = clusterPhotos(photos);
  await Promise.all(clusters.map((cluster) => nameCluster(cluster, geocoder)));

  const clusterByPhotoId = new Map<string, PlaceCluster>();
  for (const cluster of clusters) {
    for (const photoId of cluster.photoIds) clusterByPhotoId.set(photoId, cluster);
  }

  for (const photo of photos) {
    const cluster = clusterByPhotoId.get(photo.id) ?? null;
    photo.clusterId = cluster?.id;
    photo.caption = await describer.describe({
      photo,
      cluster,
      clusterSize: cluster?.photoIds.length ?? 0,
    });
  }

  return {
    dayKey,
    label: formatDayLabel(dayKey),
    photos,
    regions: splitIntoRegions(clusters).map(toMapRegion),
    taggedCount: clusters.reduce((sum, c) => sum + c.photoIds.length, 0),
  };
}

async function nameCluster(cluster: PlaceCluster, geocoder: Geocoder): Promise<void> {
  const [place, landmark] = await Promise.all([
    geocoder.lookup(cluster.lat, cluster.lon),
    // Cache-only: assembling the library must not wait on the landmark service.
    cachedLandmark(cluster.lat, cluster.lon),
  ]);

  // Coordinates are a poor label but an honest one — better than a blank pin
  // when the lookup fails or the device is offline.
  cluster.area = place?.name ?? formatCoords(cluster.lat, cluster.lon);
  cluster.landmark = landmark?.name ?? null;
  cluster.landmarkNearby = landmark?.near ?? false;
  cluster.place = landmark?.name ?? cluster.area;
  cluster.mapsUrl = googleMapsUrl(cluster.lat, cluster.lon);
}

/**
 * Second pass: look up the landmark each cluster sits inside.
 *
 * Separate from {@link buildLibrary} because it is slow — Overpass has to be
 * queried a couple of seconds apart — and the timeline should not wait on it.
 * This only warms the cache; the caller rebuilds the library afterwards, which
 * is where the names actually get used.
 *
 * Returns whether anything new was found, so a rebuild can be skipped when
 * there is nothing to show for it.
 */
export async function enrichLandmarks(
  days: DayGroup[],
  finder: LandmarkFinder,
): Promise<boolean> {
  const pending = days
    .flatMap((day) => day.regions.flatMap((region) => region.clusters))
    .filter((cluster) => !cluster.landmark);

  if (pending.length === 0) return false;

  // One batched round trip for the whole library, rather than one per place.
  const found = await finder.findMany(pending.map(({ lat, lon }) => ({ lat, lon })));

  return [...found.values()].some(Boolean);
}

function toMapRegion(clusters: PlaceCluster[], index: number): MapRegion {
  const points = clusters.map((c) => ({ lat: c.lat, lon: c.lon }));
  const center = centerOf(points);

  return {
    id: `r${index}`,
    clusters,
    centerLat: center.lat,
    centerLon: center.lon,
    zoom: fitZoom(points, ESTIMATED_CANVAS_WIDTH, ESTIMATED_CANVAS_HEIGHT),
    taggedCount: clusters.reduce((sum, c) => sum + c.photoIds.length, 0),
  };
}

/**
 * Oldest day first, undated last.
 *
 * Chronological order is what the day strip needs — oldest on the left,
 * newest on the right — and a trip reads naturally from its first day.
 */
function compareDays(a: DayGroup, b: DayGroup): number {
  if (a.dayKey === UNDATED_KEY) return 1;
  if (b.dayKey === UNDATED_KEY) return -1;
  return a.dayKey.localeCompare(b.dayKey);
}
