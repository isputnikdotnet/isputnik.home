import type Database from "better-sqlite3";

// Photo Sync phase 2 (docs/photo-sync-plan.md, decision 6): a `photo-sync` token is one
// phone, bound to its owner's personal library. Plain TEXT, no foreign key: a revoked
// token keeps naming the library it wrote into (phase 3's photo_sync_files hang off
// the token), and deleting the library revokes its phones rather than being blocked.
export const version = 88;

export function up(db: Database.Database): void {
  const columns = new Set((db.prepare("PRAGMA table_info(api_tokens)").all() as { name: string }[]).map((c) => c.name));
  if (columns.size > 0 && !columns.has("library_id")) db.exec("ALTER TABLE api_tokens ADD COLUMN library_id TEXT");
}
