import type Database from "better-sqlite3";

// One "App files" library (docs/photo-review-plan.md, phase 0) in
// place of the three libraries stories, the family tree and slideshow
// movies each asked for. Carries over whichever was set — recordings
// first, since narration is the one that cannot work without it — and
// leaves the old blobs alone, since their modules no longer read those
// fields.
export const version = 71;

export function up(db: Database.Database): void {
  const tables = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name)
  );
  if (!tables.has("app_settings") || !tables.has("libraries")) return;
  if (db.prepare("SELECT 1 FROM app_settings WHERE key = 'house_library'").get()) return;
  const read = (key: string): Record<string, unknown> => {
    const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as { value: string } | undefined;
    if (!row) return {};
    try { return JSON.parse(row.value) as Record<string, unknown>; } catch { return {}; }
  };
  const candidates = [read("stories_settings").recordingsLibraryId, read("family_tree_settings").galleryLibraryId];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate) continue;
    const library = db.prepare("SELECT id, policy_json FROM libraries WHERE id = ? AND type = 'gallery'")
      .get(candidate) as { id: string; policy_json: string } | undefined;
    if (!library) continue;
    let inbox = false;
    try { inbox = (JSON.parse(library.policy_json || "{}") as { inbox?: boolean }).inbox === true; } catch { /* not an inbox */ }
    if (inbox) continue;
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('house_library', ?)").run(JSON.stringify({ libraryId: library.id }));
    return;
  }
}
