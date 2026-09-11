import type Database from "better-sqlite3";

// 3.26.0 — a clip's own sound. An intro/outro clip is often chosen FOR its
// sound (a recorded greeting, a toast), so each clip carries a per-clip
// toggle, on by default: the clip's audio plays and the music pauses under
// it, resuming where it left off. New columns on an existing table.
export const version = 46;

export function up(db: Database.Database): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(gallery_slideshows)").all() as { name: string }[]).map((c) => c.name)
  );
  for (const name of ["intro_sound", "outro_sound"]) {
    if (!columns.has(name)) {
      db.exec(`ALTER TABLE gallery_slideshows ADD COLUMN ${name} INTEGER NOT NULL DEFAULT 1`);
    }
  }
}
