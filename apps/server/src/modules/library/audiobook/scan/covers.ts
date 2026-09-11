import fs from "node:fs";
import path from "node:path";
import type { IAudioMetadata } from "music-metadata";
import sharp from "sharp";
import { renderInTurn, thumbnailAbsolutePath, thumbnailStorageKey } from "../../shared/thumbnail.js";
import type { AudiobookSettings } from "./types.js";

// Cover *source* formats. TIFF is included because CD rips often ship cover scans
// as .tif (frequently in a sidecar folder); sharp transcodes them to webp on import
// just like any other format, so they never reach a browser as TIFF.
const coverImageExtensions = [".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff"];
// Sibling folders a book's cover art may live in instead of the book folder itself.
const coverSubfolderNames = new Set(["covers", "cover", "artwork", "art", "scans"]);

// Scan a single directory for cover images: the first file matching a wanted name
// wins outright; otherwise the largest image is remembered as a fallback.
function searchCoverDir(dir: string, wanted: Set<string>) {
  let named: string | null = null;
  let largest: { filePath: string; size: number } | null = null;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { named, largest };
  }

  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith(".")) continue; // skip ._cover.jpg junk
    const ext = path.extname(entry.name).toLowerCase();
    if (!coverImageExtensions.includes(ext)) continue;
    const filePath = path.join(dir, entry.name);
    if (wanted.has(entry.name.toLowerCase())) {
      named = filePath;
      break;
    }
    let size = 0;
    try {
      size = fs.statSync(filePath).size;
    } catch {
      continue;
    }
    if (!largest || size > largest.size) {
      largest = { filePath, size };
    }
  }

  return { named, largest };
}

export function findFolderCover(folderPath: string, settings: AudiobookSettings) {
  const coverNames = settings.cover_filenames?.length ? settings.cover_filenames : ["cover", "folder", "artwork"];
  const wanted = new Set(coverNames.flatMap((name) => {
    const base = name.trim().toLowerCase();
    const parsedExtension = path.extname(base);
    return parsedExtension ? [base] : coverImageExtensions.map((extension) => `${base}${extension}`);
  }));

  // The book folder itself takes precedence — a named cover here wins immediately.
  const direct = searchCoverDir(folderPath, wanted);
  if (direct.named) return direct.named;
  let fallback = direct.largest;

  // Then recognised sidecar art folders (Covers/, Artwork/, …) — common on CD rips
  // that keep scans separate from the audio. Never descend into arbitrary folders.
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(folderPath, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !coverSubfolderNames.has(entry.name.toLowerCase())) continue;
    const sub = searchCoverDir(path.join(folderPath, entry.name), wanted);
    if (sub.named) return sub.named;
    if (sub.largest && (!fallback || sub.largest.size > fallback.size)) {
      fallback = sub.largest;
    }
  }

  return fallback?.filePath ?? null;
}

export async function writeCoverImages(libraryId: string, bookId: string, source: string | Buffer) {
  const coverStorageKey = thumbnailStorageKey(libraryId, bookId, `${bookId}-cover.webp`);
  const largeStorageKey = thumbnailStorageKey(libraryId, bookId, `${bookId}-cover-large.webp`);
  const coverPath = thumbnailAbsolutePath(coverStorageKey);
  const largePath = thumbnailAbsolutePath(largeStorageKey);

  fs.mkdirSync(path.dirname(coverPath), { recursive: true });
  fs.mkdirSync(path.dirname(largePath), { recursive: true });

  // One at a time — see renderInTurn. An embedded cover that isn't a picture
  // (it happens) would otherwise fail in two pipelines at once and kill the scan.
  await renderInTurn([
    () => sharp(source).resize(300, 300, { fit: "cover" }).webp({ quality: 82 }).toFile(coverPath),
    () => sharp(source).resize(600, 600, { fit: "cover" }).webp({ quality: 86 }).toFile(largePath)
  ]);

  return coverStorageKey;
}

export async function generateCover(libraryId: string, bookId: string, folderPath: string, settings: AudiobookSettings, firstMetadata: IAudioMetadata | null) {
  try {
    const folderCover = findFolderCover(folderPath, settings);
    if (folderCover) {
      return await writeCoverImages(libraryId, bookId, folderCover);
    }

    const embeddedCover = firstMetadata?.common.picture?.[0]?.data;
    if (embeddedCover) {
      return await writeCoverImages(libraryId, bookId, Buffer.from(embeddedCover));
    }
  } catch {
    return null;
  }

  return null;
}
