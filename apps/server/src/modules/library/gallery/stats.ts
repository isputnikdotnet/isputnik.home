// Gallery numbers for the admin Statistics page, including the face-recognition
// counters. Registered into the core status registry from galleryPlugin, so
// core/ never touches gallery_faces or gallery_details.
// See core/status-contributors.ts.

import { db } from "../../../db.js";
import { registerStatusContributor } from "../../../core/status-contributors.js";
import { anyFaceLibraryEnabled } from "./faces/settings.js";

interface GalleryLibraryStatsRow {
  id: string;
  name: string;
  item_count: number;
  photo_count: number;
  video_count: number;
  total_size_bytes: number;
  total_duration_seconds: number;
}

interface LargestGalleryRow {
  id: string;
  title: string;
  library_name: string;
  kind: string;
  total_size_bytes: number;
  duration_seconds: number;
}

interface FullestFolderRow {
  folder: string;
  library_name: string;
  photo_count: number;
  video_count: number;
}

function galleryLibraryStats() {
  const libraries = db.prepare(`
    SELECT
      libraries.id,
      libraries.name,
      COUNT(library_items.id) AS item_count,
      COALESCE(SUM(CASE WHEN gallery_details.kind = 'photo' THEN 1 ELSE 0 END), 0) AS photo_count,
      COALESCE(SUM(CASE WHEN gallery_details.kind = 'video' THEN 1 ELSE 0 END), 0) AS video_count,
      COALESCE(SUM(COALESCE(gallery_details.size, 0)), 0) AS total_size_bytes,
      COALESCE(SUM(COALESCE(gallery_details.duration_seconds, 0)), 0) AS total_duration_seconds
    FROM libraries
    LEFT JOIN library_items ON library_items.library_id = libraries.id AND library_items.deleted_at IS NULL
    LEFT JOIN gallery_details ON gallery_details.item_id = library_items.id
    WHERE libraries.type = 'gallery'
    GROUP BY libraries.id, libraries.name
    ORDER BY libraries.name COLLATE NOCASE
  `).all() as GalleryLibraryStatsRow[];

  const largestItems = db.prepare(`
    SELECT
      library_items.id,
      COALESCE(NULLIF(item_metadata.title, ''), gallery_details.relative_path, library_items.folder_path) AS title,
      libraries.name AS library_name,
      gallery_details.kind,
      COALESCE(gallery_details.size, 0) AS total_size_bytes,
      COALESCE(gallery_details.duration_seconds, 0) AS duration_seconds
    FROM library_items
    JOIN libraries ON libraries.id = library_items.library_id AND libraries.type = 'gallery'
    JOIN gallery_details ON gallery_details.item_id = library_items.id
    LEFT JOIN item_metadata ON item_metadata.item_id = library_items.id
    WHERE library_items.deleted_at IS NULL
    ORDER BY total_size_bytes DESC, title COLLATE NOCASE
    LIMIT 10
  `).all() as LargestGalleryRow[];

  // Where the photos actually pile up. A gallery item's folder_path is the
  // FILE's relative path, so the folder is everything before its last slash —
  // rtrim(p, everything-but-slash) leaves the path up to and including that
  // slash, and the substr drops it. SQLite has no lastIndexOf, and doing this
  // in JS would mean pulling one row per photo out of the database to answer a
  // status card.
  //
  // The immediate folder, not every ancestor of it: "which folder holds the
  // most photos" is a question about one place on disk, and rolling children up
  // into parents would make the library root win every time. A file sitting at
  // the root has no slash to cut at and groups under the empty path, which the
  // client names for what it is.
  const fullestFolders = db.prepare(`
    SELECT
      CASE
        WHEN instr(library_items.folder_path, '/') = 0 THEN ''
        ELSE substr(
          library_items.folder_path,
          1,
          length(rtrim(library_items.folder_path, replace(library_items.folder_path, '/', ''))) - 1
        )
      END AS folder,
      libraries.name AS library_name,
      SUM(CASE WHEN gallery_details.kind = 'photo' THEN 1 ELSE 0 END) AS photo_count,
      SUM(CASE WHEN gallery_details.kind = 'video' THEN 1 ELSE 0 END) AS video_count
    FROM library_items
    JOIN libraries ON libraries.id = library_items.library_id AND libraries.type = 'gallery'
    JOIN gallery_details ON gallery_details.item_id = library_items.id
    WHERE library_items.deleted_at IS NULL
    GROUP BY libraries.id, folder
    HAVING photo_count > 0
    ORDER BY photo_count DESC, folder COLLATE NOCASE
    LIMIT 10
  `).all() as FullestFolderRow[];

  const totalSizeBytes = libraries.reduce((sum, library) => sum + library.total_size_bytes, 0);
  const totalDurationSeconds = libraries.reduce((sum, library) => sum + library.total_duration_seconds, 0);
  const totalItems = libraries.reduce((sum, library) => sum + library.item_count, 0);
  const totalPhotos = libraries.reduce((sum, library) => sum + library.photo_count, 0);
  const totalVideos = libraries.reduce((sum, library) => sum + library.video_count, 0);

  return {
    totalLibraries: libraries.length,
    totalItems,
    totalPhotos,
    totalVideos,
    totalSizeBytes,
    totalDurationSeconds,
    libraries: libraries.map((library) => ({
      id: library.id,
      name: library.name,
      itemCount: library.item_count,
      photoCount: library.photo_count,
      videoCount: library.video_count,
      totalSizeBytes: library.total_size_bytes,
      totalDurationSeconds: library.total_duration_seconds
    })),
    largestItems: largestItems.map((item) => ({
      id: item.id,
      title: item.title,
      libraryName: item.library_name,
      kind: item.kind,
      totalSizeBytes: item.total_size_bytes,
      durationSeconds: item.duration_seconds
    })),
    fullestFolders: fullestFolders.map((row) => ({
      folder: row.folder,
      libraryName: row.library_name,
      photoCount: row.photo_count,
      videoCount: row.video_count
    }))
  };
}

function faceStats() {
  return {
    enabled: anyFaceLibraryEnabled(),
    people: (db.prepare("SELECT COUNT(*) n FROM gallery_people").get() as { n: number }).n,
    faces: (db.prepare("SELECT COUNT(*) n FROM gallery_faces").get() as { n: number }).n,
    scannedItems: (db.prepare("SELECT COUNT(*) n FROM gallery_face_scans").get() as { n: number }).n
  };
}

export function registerGalleryStats(): void {
  registerStatusContributor("gallery", ["galleryStats", "faceStats"], () => ({
    galleryStats: galleryLibraryStats(),
    faceStats: faceStats()
  }));
}
