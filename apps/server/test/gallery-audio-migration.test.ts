// Migration 55 is the schema's first table REBUILD (SQLite can't widen a CHECK
// in place): gallery_details is staged, dropped, recreated with 'audio' admitted,
// and restored via an explicit column list. This exercises the rebuild against a
// database wearing the OLD constraint — the path a real upgrade takes — which
// resetDb-based tests never hit (a fresh schema.sql already admits 'audio', so
// the migration skips itself there).
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";

// The v54-era table, verbatim except comments: kind CHECK without 'audio'.
const OLD_GALLERY_DETAILS = `
  CREATE TABLE gallery_details (
    item_id             TEXT PRIMARY KEY REFERENCES library_items(id) ON DELETE CASCADE,
    kind                TEXT NOT NULL DEFAULT 'photo' CHECK (kind IN ('photo', 'video')),
    relative_path       TEXT NOT NULL,
    mime_type           TEXT,
    size                INTEGER,
    width               INTEGER,
    height              INTEGER,
    orientation         INTEGER,
    rotation            INTEGER NOT NULL DEFAULT 0,
    duration_seconds    REAL,
    taken_at            TEXT,
    taken_at_source     TEXT NOT NULL DEFAULT 'scan' CHECK (taken_at_source IN ('scan', 'manual')),
    modified_at         TEXT,
    gps_lat             REAL,
    gps_lng             REAL,
    gps_source          TEXT NOT NULL DEFAULT 'scan' CHECK (gps_source IN ('scan', 'manual')),
    camera_make         TEXT,
    camera_model        TEXT,
    preview_storage_key TEXT,
    playable            INTEGER,
    phash               TEXT,
    content_hash        TEXT,
    content_hash_at     TEXT,
    web_video_key       TEXT,
    web_video_attempts  INTEGER NOT NULL DEFAULT 0,
    updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )
`;

function upgradedDbWithOldCheck(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  // Build the current schema, then swap gallery_details for the v54 shape and
  // stamp the version migration 55 upgrades from.
  migrate(db);
  db.exec("DROP TABLE gallery_details");
  db.exec(OLD_GALLERY_DETAILS);
  db.prepare("INSERT INTO users (id, email, password_hash, display_name, role) VALUES ('u1', 'a@b.c', 'x', 'A', 'admin')").run();
  db.prepare("INSERT INTO libraries (id, name, type, source_path, created_by) VALUES ('L', 'Gal', 'gallery', '/gal', 'u1')").run();
  db.prepare("INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES ('i1', 'L', 'gallery', 'a.jpg', 'ready')").run();
  db.prepare(`
    INSERT INTO gallery_details (item_id, kind, relative_path, size, rotation, taken_at, phash)
    VALUES ('i1', 'photo', 'a.jpg', 123, 90, '2024-01-01T00:00:00Z', 'abcd')
  `).run();
  db.pragma("user_version = 54");
  return db;
}

describe("migration 55 — gallery_details rebuild for the audio kind", () => {
  it("rebuilds the table, keeps existing rows, and admits kind='audio'", () => {
    const db = upgradedDbWithOldCheck();

    // Sanity: the old constraint really rejects audio before the migration.
    expect(() =>
      db.prepare("INSERT INTO gallery_details (item_id, kind, relative_path) VALUES ('i1x', 'audio', 'm.mp3')").run()
    ).toThrow();

    migrate(db);

    // Existing data survived the rebuild, values intact.
    const row = db.prepare("SELECT kind, relative_path, size, rotation, taken_at, phash FROM gallery_details WHERE item_id = 'i1'")
      .get() as { kind: string; relative_path: string; size: number; rotation: number; taken_at: string; phash: string };
    expect(row).toEqual({ kind: "photo", relative_path: "a.jpg", size: 123, rotation: 90, taken_at: "2024-01-01T00:00:00Z", phash: "abcd" });

    // The widened constraint admits audio now — and still rejects garbage.
    db.prepare("INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES ('i2', 'L', 'gallery', 'm.mp3', 'ready')").run();
    db.prepare("INSERT INTO gallery_details (item_id, kind, relative_path) VALUES ('i2', 'audio', 'm.mp3')").run();
    expect(() =>
      db.prepare("UPDATE gallery_details SET kind = 'document' WHERE item_id = 'i2'").run()
    ).toThrow();

    // ON DELETE CASCADE survived the rebuild.
    db.prepare("DELETE FROM library_items WHERE id = 'i2'").run();
    expect(db.prepare("SELECT COUNT(*) n FROM gallery_details WHERE item_id = 'i2'").get()).toEqual({ n: 0 });

    // The three indexes were recreated and the staging table is gone.
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE tbl_name = 'gallery_details' AND type = 'index'").all() as { name: string }[])
      .map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(["idx_gallery_taken_at", "idx_gallery_size", "idx_gallery_content_hash"]));
    expect(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name = 'gallery_details_migr'").get()).toEqual({ n: 0 });

    db.close();
  });

  it("is a no-op on a database whose schema already admits audio", () => {
    const db = new Database(":memory:");
    migrate(db); // fresh schema.sql → CHECK already contains 'audio'
    const before = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'gallery_details'").get() as { sql: string }).sql;
    migrate(db);
    const after = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'gallery_details'").get() as { sql: string }).sql;
    expect(after).toBe(before);
    db.close();
  });
});
