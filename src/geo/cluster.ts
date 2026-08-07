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
 * Default grouping distance for one map pin.
 *
 * A 250 m radius was much too broad in dense city centres: it combined
 * Tsukiji Hongan-ji with Tsukiji Outer Market and averaged restaurant photos
 * together with nearby street photography. Landmark and dining lookup then
 * started from a coordinate where none of those places actually were.
 * Eighty metres still absorbs ordinary phone GPS drift and keeps a burst of
 * photos at one venue together without merging distinct blocks.
 */
export const DEFAULT_CLUSTER_RADIUS_M = 80;

/**
 * How long a cluster can go quiet before the next photo counts as a new visit.
 *
 * Distance alone cannot separate neighbours on a dense city block. A Harajuku
 * morning put breakfast at Eggs'n Things (09:51, 10:02) in the same cluster as
 * a coffee shop, a trainer shop and an electronics store visited around noon —
 * every pair within 83m, so all five shared a centroid out in the road and were
 * captioned after the district and a restaurant nobody ate at. What actually
 * separates them is the two hours in between.
 *
 * The gap is measured from the cluster's most recent photo, not its first, so
 * a long meal photographed throughout never splits: only genuine idle time
 * does. Returning to the same place later simply resolves to the same name.
 */
export const MAX_VISIT_GAP_MS = 60 * 60 * 1000;

/**
 * Greedy nearest-cluster assignment: each geotagged photo joins the closest
 * cluster within `radiusMeters`, or starts a new one. It is distance-based and
 * order-stable (photos arrive sorted by time, so clusters form along the day's
 * actual path).
 */
export function clusterPhotos(
  photos: Photo[],
  radiusMeters = DEFAULT_CLUSTER_RADIUS_M,
): PlaceCluster[] {
  const clusters: PlaceCluster[] = [];

  /**
   * Where each cluster started, which is what actually bounds its size.
   *
   * The radius alone does not: the centroid moves toward every photo that
   * joins, so a photo just inside the edge drags the centre outward and lets
   * the next one in a little further along. Walking down a street taking
   * pictures, that chains — a morning in Harajuku collapsed Eggs'n Things,
   * Island Vintage Coffee, Onitsuka Tiger and Anker into a single cluster whose
   * centroid sat in the road between them, so the whole set was captioned after
   * the district and a restaurant none of the photos were taken in.
   *
   * Measuring against the seed as well keeps a cluster inside one disc, so it
   * stays what it claims to be: a burst of photos at one place.
   */
  const seeds = new Map<string, GpsPoint>();

  const geotagged = photos
    .filter((p): p is Photo & { meta: { gps: GpsPoint } } => p.meta.gps !== null)
    .sort((a, b) => (a.meta.takenAt ?? 0) - (b.meta.takenAt ?? 0));

  for (const photo of geotagged) {
    const gps = photo.meta.gps;

    let best: PlaceCluster | null = null;
    let bestDistance = Infinity;

    for (const cluster of clusters) {
      const d = distanceMeters(gps, cluster);
      if (d >= radiusMeters || d >= bestDistance) continue;

      const seed = seeds.get(cluster.id);
      if (seed && distanceMeters(gps, seed) >= radiusMeters) continue;

      // A neighbouring shop is not the place you were an hour ago, even when it
      // is inside the radius. Photos arrive in time order, so `lastAt` is the
      // most recent one already in this cluster.
      const takenAt = photo.meta.takenAt;
      if (takenAt != null && cluster.lastAt != null &&
          takenAt - cluster.lastAt >= MAX_VISIT_GAP_MS) continue;

      best = cluster;
      bestDistance = d;
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
      const id = `c${clusters.length}-${gps.lat.toFixed(5)},${gps.lon.toFixed(5)}`;
      seeds.set(id, { lat: gps.lat, lon: gps.lon });
      clusters.push({
        id,
        lat: gps.lat,
        lon: gps.lon,
        photoIds: [photo.id],
        place: '',
        area: '',
        landmark: null,
        landmarkNearby: false,
        nearbyDining: null,
        nearbyDiningDistanceMeters: null,
        nearbyDiningLat: null,
        nearbyDiningLon: null,
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
