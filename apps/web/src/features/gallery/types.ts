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
  width: number | null;
  height: number | null;
  orientation: number | null;
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
}

export interface GalleryFolder {
  name: string;
  path: string;
  assetCount: number;
  coverUrl: string | null;
}

export interface GalleryLibrary {
  id: string;
  name: string;
  bookCount: number;
  scanStatus: "idle" | "scanning" | "error";
  canWrite: boolean;
  canDelete: boolean;
  canDownload: boolean;
}
