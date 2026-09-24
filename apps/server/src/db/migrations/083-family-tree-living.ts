import type Database from "better-sqlite3";

// 4.22.0: family tree access (docs/people-sharing-plan.md, D14–D16).
//
// • family_tree_persons.deceased — "Deceased (date unknown)". A person is living
//   for privacy purposes unless they have a death date, carry this mark, or were
//   born more than 100 years ago; many old ancestors have no dates at all.
// • Living relatives' details are now private to anyone who does not edit their
//   branch, unless that person (or one of their groups) may see them. The
//   household as it is today keeps seeing everything: every user and group that
//   exists at this upgrade gets the setting on. Anyone added later starts off.
export const version = 83;

export function up(db: Database.Database): void {
  const persons = new Set(
    (db.prepare("PRAGMA table_info(family_tree_persons)").all() as { name: string }[]).map((c) => c.name)
  );
  if (persons.size > 0 && !persons.has("deceased")) {
    db.exec("ALTER TABLE family_tree_persons ADD COLUMN deceased INTEGER NOT NULL DEFAULT 0");
  }

  const hasSettings = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'access_settings'").get();
  if (!hasSettings) return;
  const keep = db.prepare(`
    INSERT INTO access_settings (subject_type, subject_id, show_living_details) VALUES (?, ?, 1)
    ON CONFLICT (subject_type, subject_id) DO UPDATE SET show_living_details = 1
  `);
  for (const row of db.prepare("SELECT id FROM users WHERE deleted_at IS NULL").all() as { id: string }[]) {
    keep.run("user", row.id);
  }
  for (const row of db.prepare("SELECT id FROM user_groups").all() as { id: string }[]) {
    keep.run("group", row.id);
  }
}
