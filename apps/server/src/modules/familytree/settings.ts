// Family-tree settings, stored as one JSON blob in app_settings like the mail
// and password-policy settings.
//
// The only setting so far is the gallery library that family-tree uploads land
// in. Attaching an *existing* photo needs no setting — the picker browses every
// gallery the viewer can see — but uploading a new one has to put the file
// somewhere, so an admin nominates the library once.
import { db } from "../../db.js";

const SETTINGS_KEY = "family_tree_settings";

export interface FamilyTreeSettings {
  galleryLibraryId: string | null;
}

const DEFAULTS: FamilyTreeSettings = { galleryLibraryId: null };

export function getFamilyTreeSettings(): FamilyTreeSettings {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(SETTINGS_KEY) as { value: string } | undefined;
  if (!row) return { ...DEFAULTS };
  try {
    return { ...DEFAULTS, ...(JSON.parse(row.value) as Partial<FamilyTreeSettings>) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function setFamilyTreeSettings(settings: FamilyTreeSettings, userId: string | null): void {
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_by, updated_at)
     VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_by = excluded.updated_by,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).run(SETTINGS_KEY, JSON.stringify(settings), userId);
}

// The nominated library, or null when it was never set — or has since been
// deleted, which is why this resolves against `libraries` rather than trusting
// the stored id.
export function getFamilyUploadLibrary(): { id: string; name: string } | null {
  const { galleryLibraryId } = getFamilyTreeSettings();
  if (!galleryLibraryId) return null;
  return (db.prepare("SELECT id, name FROM libraries WHERE id = ? AND type = 'gallery'")
    .get(galleryLibraryId) as { id: string; name: string } | undefined) ?? null;
}
