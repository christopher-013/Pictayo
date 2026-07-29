import type { GpsPoint, Photo, PlaceCluster } from '../types';

/**
 * Grouping photos into map pins.
 *
 * The reference implementation clustered in projected-percentage space against
 * hardcoded Tokyo bounds, which only works for one city. This clusters in real
 * metres so it behaves the same anywhere on Earth.
 */

const EARTH_RADIUS_M = 6371008.8;

/** Great-circle distance. Haversine rather than a flat approximation, because
 *  the region split below compares distances of thousands of kilometres. */
export function distanceMeters(a: GpsPoint, b: GpsPoint): number {
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const dLat = lat2 - lat1;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Greedy nearest-cluster assignment: each geotagged photo joins the closest
 * cluster within `radiusMeters`, or starts a new one. Same shape as the
 * reference, but distance-based and order-stable (photos arrive sorted by time,
 * so clusters form along the day's actual path).
 */
export function clusterPhotos(photos: Photo[], radiusMeters = 250): PlaceCluster[] {
  const clusters: PlaceCluster[] = [];

  const geotagged = photos
    .filter((p): p is Photo & { meta: { gps: GpsPoint } } => p.meta.gps !== null)
    .sort((a, b) => (a.meta.takenAt ?? 0) - (b.meta.takenAt ?? 0));

  for (const photo of geotagged) {
    const gps = photo.meta.gps;

    let best: PlaceCluster | null = null;
    let bestDistance = Infinity;

    for (const cluster of clusters) {
      const d = distanceMeters(gps, cluster);
      if (d < radiusMeters && d < bestDistance) {
        best = cluster;
        bestDistance = d;
      }
    }

    if (best) {
      best.photoIds.push(photo.id);
      // Running mean keeps the centroid honest as the cluster grows.
      const n = best.photoIds.length;
      best.lat += (gps.lat - best.lat) / n;
      best.lon += (gps.lon - best.lon) / n;
      best.firstAt = minDefined(best.firstAt, photo.meta.takenAt);
      best.lastAt = maxDefined(best.lastAt, photo.meta.takenAt);
    } else {
      clusters.push({
        id: `c${clusters.length}-${gps.lat.toFixed(5)},${gps.lon.toFixed(5)}`,
        lat: gps.lat,
        lon: gps.lon,
        photoIds: [photo.id],
        place: '',
        area: '',
        landmark: null,
        landmarkNearby: false,
        mapsUrl: '',
        firstAt: photo.meta.takenAt,
        lastAt: photo.meta.takenAt,
      });
    }
  }

  return clusters.sort((a, b) => (a.firstAt ?? 0) - (b.firstAt ?? 0));
}

/**
 * Split a day's clusters into groups that each deserve their own map.
 *
 * A day containing a Honolulu breakfast and a Tokyo dinner cannot be shown on
 * one useful map — zoomed out far enough to fit both, every pin lands in the
 * Pacific. Tokyo2026 solved this by clipping to hardcoded bounds and printing
 * "N photos are not plotted here". Instead, single-linkage group the clusters
 * and give each group its own map, so nothing gets dropped.
 */
export function splitIntoRegions(
  clusters: PlaceCluster[],
  maxGapMeters = 500_000,
): PlaceCluster[][] {
  if (clusters.length === 0) return [];

  const unassigned = new Set(clusters.keys());
  const regions: PlaceCluster[][] = [];

  while (unassigned.size > 0) {
    const seed = unassigned.values().next().value as number;
    unassigned.delete(seed);

    const region = [seed];
    const queue = [seed];

    // Breadth-first chain: anything within the gap of a member joins the region.
    while (queue.length > 0) {
      const current = clusters[queue.pop() as number]!;
      for (const candidate of [...unassigned]) {
        if (distanceMeters(current, clusters[candidate]!) <= maxGapMeters) {
          unassigned.delete(candidate);
          region.push(candidate);
          queue.push(candidate);
        }
      }
    }

    regions.push(region.map((i) => clusters[i]!));
  }

  // Chronological, so a travel day reads departure-first.
  return regions.sort(
    (a, b) => (a[0]?.firstAt ?? 0) - (b[0]?.firstAt ?? 0),
  );
}

function minDefined(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

function maxDefined(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}
