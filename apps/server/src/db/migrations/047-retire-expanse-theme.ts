import type Database from "better-sqlite3";

// 3.30.0 — the Expanse theme is retired; Plain Dark took over its palette, so
// accounts (and a stored install default) pointing at it land on the theme that
// now looks the way they chose. "hard-orbit" was Expanse's pre-release name,
// until now remapped at read time rather than in the data.
export const version = 47;

export function up(db: Database.Database): void {
  db.prepare("UPDATE users SET theme = 'plain-dark' WHERE theme IN ('expanse', 'hard-orbit')").run();
  db.prepare(
    "UPDATE app_settings SET value = 'plain-dark' WHERE key = 'default_theme' AND value IN ('expanse', 'hard-orbit')"
  ).run();
}
