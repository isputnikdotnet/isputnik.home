import type Database from "better-sqlite3";

// 4.21.0: portraits everyone can see, and portraits cut from a group photo
// (docs/people-sharing-plan.md, phases 3 and 4).
//
// A portrait chosen from the gallery is now rendered into the family tree's own
// thumbnail bucket (portrait_storage_key), so it no longer depends on access to
// the library the photo sits in. portrait_item_id stays as the photo it came
// from; portrait_crop_json is the frame cut from it, so it can be re-cropped;
// portrait_file_item_id is the cropped copy kept in App files.
//
// gallery_details.derived_from_item_id marks a picture the app made FROM another
// one (a portrait crop), which the face scan skips: it would otherwise grow a
// second copy of the same face.
export const version = 82;

function columnsOf(db: Database.Database, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
}

export function up(db: Database.Database): void {
  const persons = columnsOf(db, "family_tree_persons");
  if (persons.size > 0) {
    if (!persons.has("portrait_crop_json")) {
      db.exec("ALTER TABLE family_tree_persons ADD COLUMN portrait_crop_json TEXT");
    }
    if (!persons.has("portrait_file_item_id")) {
      db.exec("ALTER TABLE family_tree_persons ADD COLUMN portrait_file_item_id TEXT REFERENCES library_items(id) ON DELETE SET NULL");
    }
  }
  const details = columnsOf(db, "gallery_details");
  if (details.size > 0 && !details.has("derived_from_item_id")) {
    db.exec("ALTER TABLE gallery_details ADD COLUMN derived_from_item_id TEXT");
  }
}
