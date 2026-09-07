// The "Made in the app" library — docs/photo-review-plan.md, phase 0.
//
// Three features used to ask an admin, separately, which gallery library the
// files THEY make should land in: story narration, family-tree uploads, and
// rendered slideshow movies. It was one question asked three times, so it is
// one setting now: a single gallery library nominated once under Control →
// Settings → Gallery, and each source writes into a fixed subfolder of it.
// The Photo Inbox stays a different thing on purpose — it holds what is NOT
// yet part of the collection, while everything here counts the moment it
// exists — and is refused here.
//
// Stored as one JSON blob in app_settings like the other house-wide settings.
import { db } from "../../../db.js";
import { parsePolicy } from "../../../core/permissions.js";
import { normalizeLibrarySettings } from "../shared/library-settings.js";
import { AUDIO_SCAN_EXTENSIONS } from "./media.js";

export const HOUSE_LIBRARY_SETTINGS_KEY = "house_library";

/** Where each source writes inside the house library. The first two are the
 *  folder names the features already used before the setting was unified, so
 *  an existing install's files stay where they are. */
export const HOUSE_FOLDERS = {
  recordings: "Story recordings",
  familyTree: "Family tree",
  movies: "Slideshow movies"
} as const;

export interface HouseLibrarySetting {
  libraryId: string | null;
}

export interface HouseLibrary {
  id: string;
  name: string;
  source_path: string;
  settings_json: string;
  policy_json: string;
}

export function getHouseLibrarySetting(): HouseLibrarySetting {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(HOUSE_LIBRARY_SETTINGS_KEY) as { value: string } | undefined;
  if (!row) return { libraryId: null };
  try {
    const parsed = JSON.parse(row.value) as Partial<HouseLibrarySetting>;
    return { libraryId: typeof parsed.libraryId === "string" ? parsed.libraryId : null };
  } catch {
    return { libraryId: null };
  }
}

/** The nominated library, resolved against `libraries` every time rather than
 *  trusting the stored id — a deleted library, or one since turned into an
 *  Inbox, reads as "not set". */
export function getHouseLibrary(): HouseLibrary | null {
  const { libraryId } = getHouseLibrarySetting();
  if (!libraryId) return null;
  const row = db.prepare("SELECT id, name, source_path, settings_json, policy_json FROM libraries WHERE id = ? AND type = 'gallery'")
    .get(libraryId) as HouseLibrary | undefined;
  if (!row || parsePolicy(row.policy_json).inbox === true) return null;
  return row;
}

export type SetHouseLibraryResult = { ok: true; library: HouseLibrary | null } | { ok: false; status: 404 | 409; error: string };

/** Nominate (or clear) the house library. Choosing one also opts it into audio,
 *  since narration lands there: the scan extensions gate both uploads and what a
 *  rescan keeps, and without them the next full scan would tombstone every
 *  recording. */
export function setHouseLibrary(libraryId: string | null, userId: string | null): SetHouseLibraryResult {
  if (libraryId) {
    const row = db.prepare("SELECT id, policy_json FROM libraries WHERE id = ? AND type = 'gallery'")
      .get(libraryId) as { id: string; policy_json: string } | undefined;
    if (!row) return { ok: false, status: 404, error: "That gallery library doesn't exist." };
    if (parsePolicy(row.policy_json).inbox === true) {
      return { ok: false, status: 409, error: "A Photo Inbox holds photos that are not part of the collection yet; choose a regular gallery library." };
    }
    ensureAudioScanExtensions(libraryId);
  }
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_by, updated_at)
     VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_by = excluded.updated_by,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).run(HOUSE_LIBRARY_SETTINGS_KEY, JSON.stringify({ libraryId } satisfies HouseLibrarySetting), userId);
  return { ok: true, library: getHouseLibrary() };
}

/** Opt a gallery library into audio by merging the audio extensions into its
 *  scan settings (audio is deliberately absent from the gallery defaults; see
 *  library-settings.ts). Returns false when no such gallery library exists. */
export function ensureAudioScanExtensions(libraryId: string): boolean {
  const library = db.prepare("SELECT id, settings_json FROM libraries WHERE id = ? AND type = 'gallery'")
    .get(libraryId) as { id: string; settings_json: string } | undefined;
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
