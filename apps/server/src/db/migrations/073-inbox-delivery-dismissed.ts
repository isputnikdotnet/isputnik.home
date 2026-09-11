import type Database from "better-sqlite3";

// "Not now" on a Photo Inbox delivery row (docs/for-you-plan.md): hides it
// from For you until more photos arrive in that delivery.
export const version = 73;

export function up(db: Database.Database): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(inbox_delivery_seen)").all() as { name: string }[]).map((c) => c.name)
  );
  if (columns.size === 0) return;
  if (!columns.has("dismissed_at")) db.exec("ALTER TABLE inbox_delivery_seen ADD COLUMN dismissed_at TEXT");
}
