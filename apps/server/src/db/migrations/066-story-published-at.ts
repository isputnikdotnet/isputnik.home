import type Database from "better-sqlite3";

// Stories on the home feed: published_at dates "X wrote a story" from the
// moment it went live rather than from when the draft was started, and
// story_updates records a chapter added to a story that was already
// published, so the feed can say so. Existing published stories are
// stamped with created_at — what the feed used until now — so the
// upgrade announces nothing that was not news already.
export const version = 66;

export function up(db: Database.Database): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(stories)").all() as { name: string }[]).map((c) => c.name)
  );
  // A database with no stories table at all (a partial fixture) has nothing
  // to stamp; schema.sql creates both tables complete.
  if (columns.size === 0) return;
  if (!columns.has("published_at")) {
    db.exec("ALTER TABLE stories ADD COLUMN published_at TEXT");
  }
  db.exec("UPDATE stories SET published_at = created_at WHERE status = 'published' AND published_at IS NULL");
  db.exec(`
        CREATE TABLE IF NOT EXISTS story_updates (
          id          TEXT PRIMARY KEY,
          story_id    TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
          chapter_id  TEXT NOT NULL REFERENCES story_chapters(id) ON DELETE CASCADE,
          actor_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
          created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );
        CREATE INDEX IF NOT EXISTS idx_story_updates_story ON story_updates(story_id, created_at);
      `);
}
