// Stories settings, one JSON blob in app_settings like the family-tree and
// mail settings. House-wide, not per-viewer.
//
// `recordingsLibraryId` is the gallery library narration recordings land in.
// Referencing an existing recording needs no setting, but recording from the
// story editor has to put the file somewhere — an admin nominates the library
// once, and until they do the editor simply doesn't offer Record/Upload.
import { db } from "../../db.js";
import { AUDIO_SCAN_EXTENSIONS } from "../library/gallery/media.js";
import { normalizeLibrarySettings } from "../library/shared/library-settings.js";

const SETTINGS_KEY = "stories_settings";

export interface StoriesSettings {
  recordingsLibraryId: string | null;
}

const DEFAULTS: StoriesSettings = { recordingsLibraryId: null };

export function getStoriesSettings(): StoriesSettings {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(SETTINGS_KEY) as { value: string } | undefined;
  if (!row) return { ...DEFAULTS };
  try {
    return { ...DEFAULTS, ...(JSON.parse(row.value) as Partial<StoriesSettings>) };
  } catch {
    return { ...DEFAULTS };
  }
}

// Takes a partial so a caller changing one setting can't blank the others.
export function setStoriesSettings(settings: Partial<StoriesSettings>, userId: string | null): void {
  const next: StoriesSettings = { ...getStoriesSettings(), ...settings };
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_by, updated_at)
     VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_by = excluded.updated_by,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).run(SETTINGS_KEY, JSON.stringify(next), userId);
}

export interface RecordingsLibrary {
  id: string;
  name: string;
  source_path: string;
  settings_json: string;
}

// The nominated library, or null when it was never set — or has since been
// deleted, which is why this resolves against `libraries` rather than trusting
// the stored id.
export function getRecordingsLibrary(): RecordingsLibrary | null {
  const { recordingsLibraryId } = getStoriesSettings();
  if (!recordingsLibraryId) return null;
  return (db.prepare("SELECT id, name, source_path, settings_json FROM libraries WHERE id = ? AND type = 'gallery'")
    .get(recordingsLibraryId) as RecordingsLibrary | undefined) ?? null;
}

/** Opt a gallery library into audio by merging the audio extensions into its
 *  scan settings. The scan extensions gate both uploads and what a rescan
 *  keeps — without this, the next full scan would tombstone every recording
 *  (audio is deliberately absent from the gallery defaults; see
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
