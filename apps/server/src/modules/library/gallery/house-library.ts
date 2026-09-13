// The "App files" library — docs/photo-review-plan.md, phase 0.
//
// Three features used to ask an admin, separately, which gallery library the
// files THEY make should land in: story narration, family-tree uploads, and
// rendered slideshow movies. It was one question asked three times, so it is
// one library now, and each source writes into a fixed subfolder of it.
// The Photo Inbox stays a different thing on purpose — it holds what is NOT
// yet part of the collection, while everything here counts the moment it
// exists — and is refused here.
//
// Since 4.6 it is a system library: the gallery library holding the 'app-files'
// role (system-libraries.ts). It was the `house_library` setting until then.
import { db } from "../../../db.js";
import { normalizeLibrarySettings } from "../shared/library-settings.js";
import { AUDIO_SCAN_EXTENSIONS } from "./media.js";
import { setSystemLibraryRole } from "./system-libraries.js";
import type { LibraryRow } from "../../../db/rows.js";

/** Where each source writes inside the house library. The first two are the
 *  folder names the features already used before the setting was unified, so
 *  an existing install's files stay where they are. */
export const HOUSE_FOLDERS = {
  recordings: "Story recordings",
  familyTree: "Family tree",
  movies: "Slideshow movies",
  /** Voice notes recorded on a photo (docs/photo-review-plan.md, phase 4). */
  voiceNotes: "Voice notes",
  /** Uploaded slideshow music (docs/app-storage-plan.md, phase 3). */
  music: "Slideshow music"
} as const;

export type HouseLibrary = Pick<LibraryRow, "id" | "name" | "source_path" | "settings_json" | "policy_json">;

/** The App files library: the gallery library holding the 'app-files' role
 *  (docs/system-data-plan.md, phase 1). The `house_library` setting that used to
 *  name it was carried onto the role by migration 75 and is no longer read. */
export function getHouseLibrary(): HouseLibrary | null {
  const row = db.prepare("SELECT id, name, source_path, settings_json, policy_json FROM libraries WHERE role = 'app-files' AND type = 'gallery'")
    .get() as HouseLibrary | undefined;
  return row ?? null;
}

export type SetHouseLibraryResult = { ok: true; library: HouseLibrary | null } | { ok: false; status: 404 | 409; error: string };

/** Make a gallery library App files (or clear the role). Choosing one also opts
 *  it into audio, since narration lands there: the scan extensions gate both
 *  uploads and what a rescan keeps, and without them the next full scan would
 *  tombstone every recording. `userId` is kept for the callers' activity logs. */
export function setHouseLibrary(libraryId: string | null, _userId: string | null): SetHouseLibraryResult {
  if (libraryId) {
    const row = db.prepare("SELECT id, role FROM libraries WHERE id = ? AND type = 'gallery'")
      .get(libraryId) as Pick<LibraryRow, "id" | "role"> | undefined;
    if (!row) return { ok: false, status: 404, error: "That gallery library doesn't exist." };
    if (row.role === "inbox") {
      return { ok: false, status: 409, error: "A Photo Inbox holds photos that are not part of the collection yet; choose a regular gallery library." };
    }
    ensureAudioScanExtensions(libraryId);
  }
  setSystemLibraryRole("app-files", libraryId);
  return { ok: true, library: getHouseLibrary() };
}

/** The characters no filesystem takes in a name (Windows is the strict one),
 *  the backslash by char code so no escaping is involved. */
const FORBIDDEN_IN_NAMES = new Set(["<", ">", ":", '"', "/", String.fromCharCode(92), "|", "?", "*"]);

/** A folder name from what someone typed: the characters no filesystem takes
 *  are dropped, and what is left must still say something. */
export function safeFolderName(name: string): string | null {
  const cleaned = Array.from(name)
    .filter((ch) => !FORBIDDEN_IN_NAMES.has(ch) && ch.charCodeAt(0) >= 32)
    .join("")
    .replace(/[ \t]+/g, " ")
    .trim()
    .replace(/[.]+$/, "");
  if (!cleaned || cleaned === "." || cleaned === "..") return null;
  return cleaned.slice(0, 80);
}

/** Opt a gallery library into audio by merging the audio extensions into its
 *  scan settings (audio is deliberately absent from the gallery defaults; see
 *  library-settings.ts). Returns false when no such gallery library exists. */
export function ensureAudioScanExtensions(libraryId: string): boolean {
  const library = db.prepare("SELECT id, settings_json FROM libraries WHERE id = ? AND type = 'gallery'")
    .get(libraryId) as Pick<LibraryRow, "id" | "settings_json"> | undefined;
  if (!library) return false;
  const current = normalizeLibrarySettings("gallery", library.settings_json).scan_extensions;
  const merged = Array.from(new Set([...current, ...AUDIO_SCAN_EXTENSIONS]));
  if (merged.length === current.length) return true;
  let raw: Record<string, unknown> = {};
  try { raw = JSON.parse(library.settings_json || "{}") as Record<string, unknown>; } catch { /* rebuilt from scratch */ }
  db.prepare("UPDATE libraries SET settings_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
    .run(JSON.stringify({ ...raw, scan_extensions: merged }), library.id);
  return true;
}
