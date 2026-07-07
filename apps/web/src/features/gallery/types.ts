// Client shapes for the gallery API (see modules/library/gallery/catalog.ts).
export interface GalleryAsset {
  id: string;
  libraryId: string;
  folderPath: string;
  folder: string;
  kind: "photo" | "video";
  title: string;
  description: string | null;
  takenAt: string | null;
  addedAt: string; // when the scanner/upload discovered the item

  width: number | null;
  height: number | null;
  orientation: number | null;
  rotation: number; // user-applied clockwise angle (0/90/180/270), baked into thumbnails
  durationSeconds: number | null;
  mimeType: string | null;
  size: number | null;
  gps: { lat: number; lng: number } | null;
  camera: { make: string | null; model: string | null } | null;
  coverUrl: string | null;
  previewUrl: string | null;
  fileUrl: string;
  tags: string[];
  saved: boolean;
  // Present only on the single-asset detail (lightbox), not on list/timeline rows.
  people?: GalleryPersonTag[];
}

// "On this day" memories: past-year assets matching today's month/day, grouped by
// year (newest first). `precision` says how far the server had to widen the match
// to find anything: the exact day, ±3 days, or the whole month.
export interface GalleryMemoryGroup {
  year: number;
  count: number;
  items: GalleryAsset[];
}

export interface GalleryMemories {
  precision: "day" | "near" | "month";
  groups: GalleryMemoryGroup[];
}

// A gallery album (hand-curated set spanning libraries). itemCount/coverUrl
// reflect only the viewer's accessible items; canEdit = creator or admin.
export interface GalleryAlbum {
  id: string;
  name: string;
  description: string | null;
  itemCount: number;
  coverUrl: string | null;
  sortMode: "taken_at" | "manual";
  canEdit: boolean;
  updatedAt: string;
}

// The album-detail header (items arrive separately, paged).
export interface GalleryAlbumDetail {
  id: string;
  name: string;
  description: string | null;
  sortMode: "taken_at" | "manual";
  coverItemId: string | null;
  canEdit: boolean;
  updatedAt: string;
}

// A person tagged in a photo (id + name), as returned on the asset detail.
export interface GalleryPersonTag {
  id: string;
  name: string;
}

// A person in the People view: name, how many photos they're in, and a cover. An
// auto-detected cluster that hasn't been named yet has an empty `name`.
export interface GalleryPerson {
  id: string;
  name: string;
  faceCount: number;
  coverUrl: string | null;
}

// Admin face-recognition settings: per-gallery-library enablement + scan progress.
export interface GalleryFaceLibrary {
  id: string;
  name: string;
  enabled: boolean;
  photos: number;
  scanned: number;
  // Photos that failed every scan retry (corrupt/unsupported files) and are now
  // skipped by incremental scans; a full rescan retries them.
  unreadable: number;
}

// The face scan currently running (or next queued); null when the queue is idle.
export interface GalleryFaceScan {
  libraryId: string | null;
  status: "pending" | "running";
  recompute: boolean;
  processed: number;
  total: number;
  startedAt: string | null;
  etaSeconds: number | null;
}

export interface GalleryFaceSettings {
  threshold: number;
  groupingStrength: number; // 2..8: lower = purer/more groups, higher = more consolidated
  libraries: GalleryFaceLibrary[];
  scan: GalleryFaceScan | null;
}

// Clustering-health diagnostic: how many people are likely the same person split across
// clusters (an under-merging signal), plus one-click merge suggestions.
export interface ClusterHealthPerson {
  id: string;
  name: string;
  faceCount: number;
  coverUrl: string | null;
}

export interface ClusterHealthPair {
  a: ClusterHealthPerson; // suggested survivor of the merge
  b: ClusterHealthPerson; // folded into `a`
  similarity: number;
}

export interface ClusterHealth {
  mergeLine: number; // automatic merge threshold; pairs above it were kept apart (a named side)
  totalPeople: number;
  peopleWithTwin: number;
  bands: { nearCertain: number; likely: number; possible: number };
  pairs: ClusterHealthPair[];
}

export interface GalleryFolder {
  name: string;
  path: string;
  assetCount: number;
  coverUrl: string | null;
}

// A lightweight map marker — just what a pin + its popup thumbnail need. The full
// asset is fetched on click for the lightbox.
export interface GalleryMapPoint {
  id: string;
  kind: "photo" | "video";
  title: string;
  lat: number;
  lng: number;
  coverUrl: string | null;
}

export interface GalleryFacets {
  kinds: { kind: string; count: number }[];
  years: string[];
  withGps: number;
  people: string[];
  tags: string[];
  cameras: string[];
}

export interface GalleryLibrary {
  id: string;
  name: string;
  bookCount: number;
  scanStatus: "idle" | "scanning" | "error";
  canWrite: boolean;
  canDelete: boolean;
  canDownload: boolean;
  canUpload: boolean;
  canCurate: boolean;
  uploadExtensions: string[];
  maxUploadMB: number | null;
}
