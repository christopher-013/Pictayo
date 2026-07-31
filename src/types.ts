export interface GpsPoint {
  lat: number;
  lon: number;
}

/** Everything we can learn about a photo without looking at the image itself. */
export interface PhotoMeta {
  /** UTC instant of capture, ms since epoch. Null when nothing usable was found. */
  takenAt: number | null;
  /**
   * Minutes east of UTC at the moment of capture, from EXIF OffsetTimeOriginal.
   * Null when the camera didn't record one — most don't.
   */
  tzOffsetMinutes: number | null;
  /**
   * Local calendar day where the photo was taken, "YYYY-MM-DD".
   * Null when undated. This is the grouping key, so it deliberately uses the
   * capture-site local date rather than the viewer's — a 1am Tokyo photo belongs
   * to the Tokyo day, not to yesterday back home.
   */
  dayKey: string | null;
  gps: GpsPoint | null;
  width: number | null;
  height: number | null;
  make: string | null;
  model: string | null;
  /** Where takenAt came from, so the UI can be honest about guessed dates. */
  dateSource: 'exif' | 'file' | 'none';
}

/** The caption shape the Tokyo2026 gallery used; kept so markup stays compatible. */
export interface Caption {
  location: string;
  desc: string;
  mapsUrl: string;
  /** Best-effort nearby food venue, always phrased as a possibility. */
  dining?: string;
  /** Coordinate-scoped Google Maps search for the nearby venue. */
  diningUrl?: string;
  /** Human-readable surrounding destination used by the information link. */
  infoLabel?: string;
  /** English Wikipedia article for the resolved surrounding destination. */
  infoUrl?: string;
}

export type MediaKind = 'photo' | 'video';

export interface Photo {
  id: string;
  name: string;
  bytes: number;
  kind: MediaKind;
  /** Video length in milliseconds, when known. */
  durationMs?: number | null;
  meta: PhotoMeta;
  /** True when the browser could not decode the file (typically HEIC on desktop). */
  previewUnavailable: boolean;
  /** Populated at render time from the stored blobs. */
  thumbUrl?: string;
  displayUrl?: string;
  caption?: Caption;
  /** Cluster this photo belongs to, assigned when the library is assembled. */
  clusterId?: string;
}

/** A photo record as it lives in IndexedDB, blobs included. */
export interface StoredPhoto extends Photo {
  thumb: Blob | null;
  display: Blob | null;
}

/** A group of photos taken close together, rendered as one map pin. */
export interface PlaceCluster {
  id: string;
  lat: number;
  lon: number;
  photoIds: string[];
  /**
   * The name to display: the enclosing landmark when one was found ("Tokyo
   * Dome"), otherwise the reverse-geocoded area, otherwise coordinates.
   */
  place: string;
  /** The reverse-geocoded area, always — "Bunkyo-ku, Tokyo". */
  area: string;
  /** The landmark, once one has been looked up. */
  landmark: string | null;
  /**
   * True when the landmark was the nearest one rather than one containing the
   * photo — the difference between "at Tokyo Dome" and "close to teamLab
   * Planets".
   */
  landmarkNearby: boolean;
  /** Nearest named restaurant/cafe candidate within the dining search radius. */
  nearbyDining: string | null;
  /** Approximate distance from the cluster centroid to the dining candidate. */
  nearbyDiningDistanceMeters: number | null;
  /** Mapped venue position, used to scope its details link accurately. */
  nearbyDiningLat: number | null;
  nearbyDiningLon: number | null;
  mapsUrl: string;
  /** Earliest and latest capture instants in this cluster, for caption context. */
  firstAt: number | null;
  lastAt: number | null;
}

/**
 * One map's worth of clusters. A day usually has exactly one region; a travel
 * day that crosses continents gets one per landmass so neither map is useless.
 */
export interface MapRegion {
  id: string;
  clusters: PlaceCluster[];
  centerLat: number;
  centerLon: number;
  zoom: number;
  /** Total photos with geotags across this region's clusters. */
  taggedCount: number;
}

export interface DayGroup {
  /** "YYYY-MM-DD", or "undated" for the catch-all group. */
  dayKey: string;
  /** Display heading, e.g. "Sat Jun 6, 2026". */
  label: string;
  photos: Photo[];
  regions: MapRegion[];
  /** Photos in this day that carry usable GPS. */
  taggedCount: number;
}

/** Result of reverse-geocoding a coordinate. */
export interface Place {
  /** Cache key: coordinates rounded to ~100m. */
  key: string;
  name: string;
  locality: string | null;
  region: string | null;
  country: string | null;
}

/** Message sent to the ingest worker. */
export interface IngestRequest {
  id: string;
  file: File;
}

/** Message returned by the ingest worker for one file. */
export interface IngestResult {
  id: string;
  name: string;
  bytes: number;
  kind: MediaKind;
  durationMs?: number | null;
  meta: PhotoMeta;
  thumb: Blob | null;
  display: Blob | null;
  /** The playable file itself, for videos — there is no cheap derivative. */
  video?: Blob | null;
  previewUnavailable: boolean;
  error?: string;
}
