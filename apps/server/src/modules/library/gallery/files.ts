// Helpers for writing files into a gallery library, shared by the upload routes
// and every other path that lands a file in one (drop links, music, voice notes,
// story recordings). Kept out of routes.ts so none of those imports a routes file.
import fs from "node:fs";
import path from "node:path";
import { backFileNameFor, pairBackSides, type BackRule } from "./back-sides.js";
import { kindForExtension } from "./media.js";

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

// ── Back sides in an upload batch (docs/back-sides-proposal.md) ──────────────

interface UploadedFile { tmpPath: string; filename: string; extension: string; sizeBytes: number }

/** Which files of a batch are backs of which, by their names under the library's
 *  rule — the same matcher the scanner uses, over the names as sent. */
export function pairUploadedBackSides<T extends UploadedFile>(received: T[], rule: BackRule): { backs: Set<T>; backOf: Map<T, T> } {
  const backs = new Set<T>();
  const backOf = new Map<T, T>();
  if (rule.patterns.length === 0 || received.length < 2) return { backs, backOf };
  const byName = new Map<string, T>();
  for (const file of received) if (!byName.has(file.filename)) byName.set(file.filename, file);
  const pairing = pairBackSides(
    Array.from(byName.values()).map((file) => ({ relativePath: file.filename, kind: kindForExtension(`.${file.extension}`) ?? "video" })),
    rule
  );
  for (const [front, back] of pairing.backOf) {
    const frontFile = byName.get(front);
    const backFile = byName.get(back);
    if (!frontFile || !backFile) continue;
    backOf.set(frontFile, backFile);
    backs.add(backFile);
  }
  return { backs, backOf };
}

/** Put a batch's back beside the front that just landed at `frontAbs`, named
 *  the way the library's rule names a back of that front (so the front's own
 *  scan finds it). Best effort: a name clash leaves it an ordinary upload. */
export function placeBackSideBeside(frontAbs: string, back: UploadedFile, rule: BackRule): string | null {
  const dir = path.dirname(frontAbs);
  const wanted = backFileNameFor(path.basename(frontAbs), rule, back.extension);
  const finalName = uniqueGalleryFileName(dir, wanted);
  if (!finalName) { fs.rmSync(back.tmpPath, { force: true }); return null; }
  const finalPath = path.join(dir, finalName);
  fs.renameSync(back.tmpPath, finalPath);
  return finalPath;
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
