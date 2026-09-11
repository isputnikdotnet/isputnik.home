// Helpers for writing files into a gallery library, shared by the upload routes
// and every other path that lands a file in one (drop links, music, voice notes,
// story recordings). Kept out of routes.ts so none of those imports a routes file.
import fs from "node:fs";
import path from "node:path";

// Turn a client filename into a safe, collision-free name within a directory:
// strip path separators / control chars, refuse a leading dot (the scanner skips
// dot-entries, and ".upload-*" is reserved for staging), then disambiguate against
// existing files with " (2)", " (3)", … Returns null if nothing usable remains.
// Mirrors the ebook uploader. Every path that writes a file into a gallery
// library uses it (uploads, drop links, slideshow music, voice notes, story
// recordings), so they all follow the same naming rules as a regular upload.
export function uniqueGalleryFileName(dir: string, filename: string): string | null {
  const ext = path.extname(filename);
  const stem = Array.from(path.basename(filename, ext))
    .filter((ch) => ch.charCodeAt(0) >= 32)
    .join("")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 150)
    .replace(/[\s.]+$/g, "");
  if (!stem) return null;
  let candidate = `${stem}${ext}`;
  let counter = 2;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${stem} (${counter})${ext}`;
    counter += 1;
  }
  return candidate;
}

// Turn a raw filesystem write failure into a message that names the real problem.
// The usual culprit is a read-only media mount (Unraid's template historically mapped
// media read-only) or missing write permission — uploading has to create files in the
// library folder, unlike scanning which only reads.
export function friendlyStorageError(err: unknown, fallback: string): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/\b(EROFS|EACCES|EPERM|ENOENT)\b/.test(message) && /mkdir|open|rename|EROFS/.test(message)) {
    return "Can't write to this library's folder. Uploads need write access — on Unraid, set the Media Storage path to Read/Write (not Read Only) and make sure the container can write to it.";
  }
  return message || fallback;
}
