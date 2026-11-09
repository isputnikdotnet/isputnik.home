// Migration 92 (db/migrations/092-household-profiles.ts): 4.73.1's per-account viewing
// profiles become the household's. Run on a scratch database shaped as 4.73.1 left it.
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { up } from "../src/db/migrations/092-household-profiles.js";

function shapedLike4731() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE viewing_profiles (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL, avatar TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0,
      restricted INTEGER NOT NULL DEFAULT 0, libraries TEXT, sections TEXT, rows TEXT,
      created_at TEXT NOT NULL DEFAULT '2026-11-08', updated_at TEXT NOT NULL DEFAULT '2026-11-08'
    );
    CREATE INDEX idx_viewing_profiles_user ON viewing_profiles(user_id, position);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, profile_id TEXT REFERENCES viewing_profiles(id) ON DELETE SET NULL);
    CREATE TABLE viewing_profile_pins (user_id TEXT PRIMARY KEY);
    INSERT INTO users VALUES ('dad'), ('mum');
    INSERT INTO viewing_profiles (id, user_id, name, avatar, position, restricted, libraries, sections, rows)
      VALUES ('kids', 'dad', 'Kids', 'green', 0, 1, '["cartoons"]', '["video"]', '[{"id":"c","type":"continue"}]'),
             ('ru', 'mum', 'Russian', 'red', 0, 0, NULL, NULL, NULL);
    INSERT INTO sessions VALUES ('tv', 'kids'), ('phone', NULL);
  `);
  return db;
}

describe("migration 92", () => {
  it("keeps every profile as the household's, and the TVs wearing them", () => {
    const db = shapedLike4731();
    db.transaction(() => up(db))();
    const columns = (db.prepare("PRAGMA table_info(viewing_profiles)").all() as { name: string }[]).map((c) => c.name);
    expect(columns).not.toContain("user_id");
    expect(columns).not.toContain("sections");
    expect(db.prepare("SELECT id, name, position, restricted, libraries, rows, created_by FROM viewing_profiles ORDER BY position").all()).toEqual([
      { id: "kids", name: "Kids", position: 0, restricted: 1, libraries: '["cartoons"]', rows: '[{"id":"c","type":"continue"}]', created_by: "dad" },
      { id: "ru", name: "Russian", position: 1, restricted: 0, libraries: null, rows: null, created_by: "mum" }
    ]);
    expect(db.prepare("SELECT id, profile_id FROM sessions ORDER BY id").all()).toEqual([{ id: "phone", profile_id: null }, { id: "tv", profile_id: "kids" }]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('viewing_profile_pins', 'idx_viewing_profiles_user')").all()).toEqual([]);
    // The foreign key still works: deleting a profile frees its TV, deleting its maker keeps it.
    db.prepare("DELETE FROM users WHERE id = 'mum'").run();
    expect(db.prepare("SELECT created_by FROM viewing_profiles WHERE id = 'ru'").get()).toEqual({ created_by: null });
    db.prepare("DELETE FROM viewing_profiles WHERE id = 'kids'").run();
    expect(db.prepare("SELECT profile_id FROM sessions WHERE id = 'tv'").get()).toEqual({ profile_id: null });
  });

  it("does nothing to a database already shaped the new way", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE viewing_profiles (id TEXT PRIMARY KEY, name TEXT); INSERT INTO viewing_profiles VALUES ('a', 'A');");
    up(db);
    expect(db.prepare("SELECT * FROM viewing_profiles").all()).toEqual([{ id: "a", name: "A" }]);
  });
});
