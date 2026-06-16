import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { nanoid } from "nanoid";
import { config } from "./config.js";
import { migrate } from "./db/migrate.js";
import { seed } from "./db/seed.js";

export type Role = "admin" | "member";
export const THEME_PREFERENCES = ["system", "light", "dark", "plain-light", "plain-dark", "expanse"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export interface User {
  id: string;
  email: string;
  password_hash: string;
  display_name: string;
  role: Role;
  theme: ThemePreference;
  protected_from_delete: 0 | 1;
  is_active: 0 | 1;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface ActivityInput {
  event: string;
  actorUserId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  detail: string;
  ipAddress?: string | null;
}

// Canonical timestamp helper. Matches the SQL column default in schema.sql
// (strftime('%Y-%m-%dT%H:%M:%fZ','now')), so a column never holds two formats.
export const nowIso = (): string => new Date().toISOString();

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
if (config.thumbnailPath) {
  fs.mkdirSync(config.thumbnailPath, { recursive: true });
}

// Apply a staged restore (set by the Backup screen) before opening the DB. We
// can't swap the file while better-sqlite3 holds it open, so a restore is staged
// as "<dbPath>.restore" and applied here on the next startup. The current DB is
// copied into the backups folder first as an automatic safety snapshot.
(function applyPendingRestore() {
  const restoreFile = `${config.dbPath}.restore`;
  if (!fs.existsSync(restoreFile)) {
    return;
  }
  try {
    if (fs.existsSync(config.dbPath)) {
      fs.mkdirSync(config.backupPath, { recursive: true });
      const d = new Date();
      const p = (n: number) => String(n).padStart(2, "0");
      const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
      fs.copyFileSync(config.dbPath, path.join(config.backupPath, `isputnik-${stamp}.sqlite`));
    }
    for (const ext of ["-wal", "-shm"]) {
      fs.rmSync(`${config.dbPath}${ext}`, { force: true });
    }
    fs.renameSync(restoreFile, config.dbPath);
  } catch (err) {
    // If the restore can't be applied, leave the current DB untouched and drop
    // the staging file so we don't loop on every boot.
    try { fs.rmSync(restoreFile, { force: true }); } catch { /* ignore */ }
    console.error("Pending restore failed; kept current database.", err);
  }
})();

export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("foreign_keys = ON");

// Apply the canonical schema + ordered migrations, then seed navigation data.
migrate(db);
seed(db);

export function hasUsers() {
  const row = db.prepare("SELECT COUNT(*) AS count FROM users WHERE deleted_at IS NULL").get() as { count: number };
  return row.count > 0;
}

export function logActivity(input: ActivityInput) {
  db.prepare(`
    INSERT INTO activity_logs (id, event, actor_user_id, target_type, target_id, detail, ip_address)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    nanoid(16),
    input.event,
    input.actorUserId ?? null,
    input.targetType ?? null,
    input.targetId ?? null,
    input.detail,
    input.ipAddress ?? null
  );
}

export function publicUser(user: User) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    role: user.role,
    theme: user.theme,
    protectedFromDelete: Boolean(user.protected_from_delete),
    isActive: Boolean(user.is_active),
    createdAt: user.created_at,
    deletedAt: user.deleted_at
  };
}
