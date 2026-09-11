import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { thumbnailAbsolutePath, thumbnailStorageKey } from "../shared/thumbnail.js";
import { downloadImage } from "../shared/remote-image.js";

export async function writePersonPhoto(authorId: string, photoUrl: string) {
  const buffer = await downloadImage(photoUrl);
  // Versioned file name: photo URLs are cached by the browser, so replacing a
  // photo must produce a new URL to show up immediately.
  const storageKey = thumbnailStorageKey("people", authorId, `${authorId}-photo-${Date.now()}.webp`);
  const absolutePath = thumbnailAbsolutePath(storageKey);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  await sharp(buffer).resize(512, 512, { fit: "inside", withoutEnlargement: true }).webp({ quality: 85 }).toFile(absolutePath);
  return storageKey;
}

// Best-effort removal of replaced photo files.
export function removeStoredPhotos(storageKeys: Array<string | null | undefined>) {
  for (const key of new Set(storageKeys.filter((key): key is string => Boolean(key)))) {
    try {
      fs.unlinkSync(thumbnailAbsolutePath(key));
    } catch {
      // already gone or unreadable — nothing to clean
    }
  }
}
