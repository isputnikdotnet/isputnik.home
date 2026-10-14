import type Database from "better-sqlite3";

// 4.31.0: back sides of scanned prints (docs/back-sides-proposal.md).
//
// A print scanned on both sides is ONE photo: the back is an attachment on the
// front's gallery_details row, never a library item of its own. Its file sits
// beside the front under the front's name plus a suffix (`X_b.jpg`, `X_back.jpg`),
// paired by the library's back-sides rule (settings_json.back_sides) or by hand.
//
// • back_relative_path / back_size / back_modified_at — the file and its change
//   detection, so a rescan re-renders the preview only when the back changed.
// • back_rotation — the back's own turn (backs are usually scanned the other way
//   up). User-owned like `rotation`: the scan never writes it.
// • back_preview_storage_key — the back's preview thumbnail.
// • back_text — "Written on the back", plain text, manual only.
// • trashed_items.back_path — the back file travels into the bin with its front
//   and comes back with it, paired again whatever the library's rule says then.
export const version = 84;

export function up(db: Database.Database): void {
  const details = new Set(
    (db.prepare("PRAGMA table_info(gallery_details)").all() as { name: string }[]).map((c) => c.name)
  );
  if (details.size > 0) {
    if (!details.has("back_relative_path")) db.exec("ALTER TABLE gallery_details ADD COLUMN back_relative_path TEXT");
    if (!details.has("back_rotation")) db.exec("ALTER TABLE gallery_details ADD COLUMN back_rotation INTEGER NOT NULL DEFAULT 0");
    if (!details.has("back_size")) db.exec("ALTER TABLE gallery_details ADD COLUMN back_size INTEGER");
    if (!details.has("back_modified_at")) db.exec("ALTER TABLE gallery_details ADD COLUMN back_modified_at TEXT");
    if (!details.has("back_preview_storage_key")) db.exec("ALTER TABLE gallery_details ADD COLUMN back_preview_storage_key TEXT");
    if (!details.has("back_text")) db.exec("ALTER TABLE gallery_details ADD COLUMN back_text TEXT");
  }

  const trashed = new Set(
    (db.prepare("PRAGMA table_info(trashed_items)").all() as { name: string }[]).map((c) => c.name)
  );
  if (trashed.size > 0 && !trashed.has("back_path")) {
    db.exec("ALTER TABLE trashed_items ADD COLUMN back_path TEXT");
  }
}
