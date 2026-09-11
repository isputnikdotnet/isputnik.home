// Stories settings, one JSON blob in app_settings like the family-tree and
// mail settings. House-wide, not per-viewer.
//
// Narration recordings land in the "App files" library — the one house
// setting every app-made file shares (modules/library/gallery/house-library.ts,
// docs/photo-review-plan.md phase 0). The recordings library used to be
// nominated here on its own; migration 71 carried that choice over, and this
// module now only reads through to it. Until a house library is chosen the
// story editor simply doesn't offer Record/Upload.
import { db } from "../../db.js";
import { getHouseLibrary, type HouseLibrary } from "../library/gallery/house-library.js";
import type { AppSettingRow } from "../../db/rows.js";

export { ensureAudioScanExtensions } from "../library/gallery/house-library.js";

const SETTINGS_KEY = "stories_settings";

export interface StoriesSettings {
  /** Whether members may start a recipe from a link (an outbound fetch of a
   *  page the member names). On by default; an admin can close the door. */
  recipeImportEnabled: boolean;
}

const DEFAULTS: StoriesSettings = { recipeImportEnabled: true };

export function getStoriesSettings(): StoriesSettings {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(SETTINGS_KEY) as Pick<AppSettingRow, "value"> | undefined;
  if (!row) return { ...DEFAULTS };
  try {
    const parsed = JSON.parse(row.value) as Partial<StoriesSettings>;
    return { recipeImportEnabled: parsed.recipeImportEnabled ?? DEFAULTS.recipeImportEnabled };
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

export type RecordingsLibrary = HouseLibrary;

/** Where narration lands: the house library, or null when none is set. */
export function getRecordingsLibrary(): RecordingsLibrary | null {
  return getHouseLibrary();
}
