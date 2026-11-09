import type Database from "better-sqlite3";

// 4.74: the Stremio add-on is gone (it was docs/stremio-plan.md; the TV app is the
// TV answer). Every member's add-on link was an api_tokens row of scope
// "video-stremio"; nothing answers under /video/stremio any more, so the rows are
// revoked rather than left live for a scope no code checks. The origin column
// they used stays, empty.
export const version = 93;

export function up(db: Database.Database): void {
  db.prepare(
    "UPDATE api_tokens SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE scope = 'video-stremio' AND revoked_at IS NULL"
  ).run();
}
