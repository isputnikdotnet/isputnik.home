// Scene search has one switch for the whole install (docs/scene-search-plan.md):
// unlike faces, a photo's vector names nobody and is shown to nobody, and what a
// search returns is cut down to what the searcher may see anyway.
import { db } from "../../../../db.js";
import type { AppSettingRow, LibraryRow } from "../../../../db/rows.js";

const ENABLED_KEY = "scene_search.enabled";

export function sceneSearchEnabled(): boolean {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(ENABLED_KEY) as Pick<AppSettingRow, "value"> | undefined;
  return row?.value === "true";
}

export function setSceneSearchEnabled(enabled: boolean, userId: string): void {
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_by, updated_at)
    VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `).run(ENABLED_KEY, enabled ? "true" : "false", userId);
}

/** The gallery libraries whose photos are described: every one a person made,
 *  personal libraries included (their owner searches them too). The two system
 *  libraries are left out: a Photo Inbox holds photos nobody has kept yet, and
 *  App files holds what the app keeps for itself. */
export function sceneLibraryIds(): string[] {
  return (db.prepare("SELECT id FROM libraries WHERE type = 'gallery' AND role IS NULL ORDER BY name").all() as Pick<LibraryRow, "id">[])
    .map((row) => row.id);
}

export function isSceneLibrary(libraryId: string): boolean {
  return db.prepare("SELECT 1 FROM libraries WHERE id = ? AND type = 'gallery' AND role IS NULL").get(libraryId) != null;
}
