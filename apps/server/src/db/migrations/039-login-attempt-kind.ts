import type Database from "better-sqlite3";

// 3.8.0 — why an IP was auto-blocked. A failed row now says what it was —
// 'signin' (a password, code, or passkey), 'probe' (a scanner path sweep),
// or 'token' (a share/API token or device code matching nothing) — so the
// block reason and the admin alert can tell scanner noise from a password
// attack. New column on an existing table. Existing rows default to
// 'signin', which is what the block reason has always called them.
export const version = 39;

export function up(db: Database.Database): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(login_attempts)").all() as { name: string }[]).map((c) => c.name)
  );
  if (!columns.has("kind")) {
    db.exec(
      "ALTER TABLE login_attempts ADD COLUMN kind TEXT NOT NULL DEFAULT 'signin' CHECK (kind IN ('signin', 'probe', 'token'))"
    );
  }
}
