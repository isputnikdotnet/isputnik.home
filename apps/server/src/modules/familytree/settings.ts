// Family-tree settings, stored as one JSON blob in app_settings like the mail
// and password-policy settings. House-wide, not per-viewer.
//
// Uploads from the tree land in the "App files" library — the one house
// setting every app-made file shares (modules/library/gallery/house-library.ts,
// docs/photo-review-plan.md phase 0) — under its "Family tree" folder. The
// upload library used to be nominated here on its own; migration 71 carried
// that choice over, and this module now only reads through to it. Attaching an
// *existing* photo needs no setting — the picker browses every gallery the
// viewer can see.
//
// `defaultPersonId` is who the chart opens on. Without it the chart falls back
// to whoever sorts first, which is nobody's idea of the centre of the family.
import { db } from "../../db.js";
import { getHouseLibrary, HOUSE_FOLDERS } from "../library/gallery/house-library.js";

const SETTINGS_KEY = "family_tree_settings";

export interface FamilyTreeSettings {
  defaultPersonId: string | null;
}

const DEFAULTS: FamilyTreeSettings = { defaultPersonId: null };

export function getFamilyTreeSettings(): FamilyTreeSettings {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(SETTINGS_KEY) as { value: string } | undefined;
  if (!row) return { ...DEFAULTS };
  try {
    const parsed = JSON.parse(row.value) as Partial<FamilyTreeSettings>;
    return { defaultPersonId: parsed.defaultPersonId ?? null };
  } catch {
    return { ...DEFAULTS };
  }
}

// Takes a partial so a caller changing one setting can't blank the others.
export function setFamilyTreeSettings(settings: Partial<FamilyTreeSettings>, userId: string | null): void {
  const next: FamilyTreeSettings = { ...getFamilyTreeSettings(), ...settings };
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_by, updated_at)
     VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_by = excluded.updated_by,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).run(SETTINGS_KEY, JSON.stringify(next), userId);
}

/** Where family-tree uploads land: the house library and the folder inside
 *  it, or null when no house library is set. */
export function getFamilyUploadLibrary(): { id: string; name: string; folder: string } | null {
  const library = getHouseLibrary();
  return library ? { id: library.id, name: library.name, folder: HOUSE_FOLDERS.familyTree } : null;
}

// The person the chart opens on, resolved the same defensive way: a stored id
// whose person has since been deleted reads as "not set", so the chart falls
// back to its own default instead of focusing on nothing.
export function getFamilyDefaultPerson(): { id: string; name: string } | null {
  const { defaultPersonId } = getFamilyTreeSettings();
  if (!defaultPersonId) return null;
  return (db.prepare("SELECT id, name FROM family_tree_persons WHERE id = ?")
    .get(defaultPersonId) as { id: string; name: string } | undefined) ?? null;
}
