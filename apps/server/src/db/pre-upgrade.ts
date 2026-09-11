import fs from "node:fs";
import type Database from "better-sqlite3";
import { log } from "../core/logger.js";
import type { AppSettingRow } from "./rows.js";

// The automatic pre-upgrade copy (docs/rollback.md).
//
// Migrations run the moment db.ts opens the database, and they only go forward: an
// install that upgrades and then wants the previous version back needs the database
// as it was BEFORE the new version touched it. So when the version booting differs
// from the one that last booted this database, a copy is taken here — after the
// database is open, before migrate() — with VACUUM INTO, which writes a consistent,
// compact snapshot (committed WAL content included) in one synchronous statement.
//
// It can't go straight into the backups folder: that may be App storage's Backups
// room, and reading where the room is needs modules that need this database. So it
// is staged beside the database and the backups plugin adopts it into the folder,
// under a proper backup name, once the server is up (adoptPreUpgradeCopy).
//
// A staged copy is never overwritten. If boot fails part-way through a run of
// migrations, the next boot must not replace the good pre-upgrade copy with one of
// the half-migrated database.

export const LAST_BOOTED_VERSION_KEY = "app.last_booted_version";

export interface PreUpgradeMeta {
  from: string | null; // null: an install from before versions were recorded
  to: string;
  takenAt: string;
}

export function preUpgradeStagingPath(dbPath: string): string {
  return `${dbPath}.pre-upgrade`;
}

function metaPath(dbPath: string): string {
  return `${preUpgradeStagingPath(dbPath)}.json`;
}

function lastBootedVersion(db: Database.Database): { known: boolean; version: string | null } {
  try {
    const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(LAST_BOOTED_VERSION_KEY) as Pick<AppSettingRow, "value"> | undefined;
    if (row) return { known: true, version: row.value };
    // No record: either a brand-new database (nothing to protect) or an install
    // from before this existed — which is exactly the first upgrade that needs it.
    const users = db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number };
    return { known: users.count > 0, version: null };
  } catch {
    return { known: false, version: null }; // fresh database: no tables yet
  }
}

/** Numeric, dot by dot ("4.0.10" > "4.0.9"); anything after a "-" is ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split("-")[0].split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Take the pre-upgrade copy if this boot is an upgrade. Never throws — a copy that
 *  can't be taken is logged and the boot carries on. Returns the staged meta when a
 *  copy was taken (or one from an earlier failed boot is still waiting).
 *
 *  Upgrades only. Starting an OLDER version against the database is a rollback in
 *  progress (docs/rollback.md), and a copy of the newer database taken then would
 *  push the one that rollback needs out of the newest-two retention. */
export function stagePreUpgradeCopy(db: Database.Database, dbPath: string, version: string): PreUpgradeMeta | null {
  if (dbPath === ":memory:") return null;
  const staging = preUpgradeStagingPath(dbPath);
  if (fs.existsSync(staging)) return readPreUpgradeMeta(dbPath);
  const last = lastBootedVersion(db);
  if (!last.known) return null;
  if (last.version !== null && compareVersions(version, last.version) <= 0) return null;
  const meta: PreUpgradeMeta = { from: last.version, to: version, takenAt: new Date().toISOString() };
  const partial = `${staging}.partial`;
  try {
    fs.rmSync(partial, { force: true });
    db.prepare("VACUUM INTO ?").run(partial);
    fs.writeFileSync(metaPath(dbPath), JSON.stringify(meta));
    fs.renameSync(partial, staging);
    return meta;
  } catch (err) {
    try { fs.rmSync(partial, { force: true }); } catch { /* ignore */ }
    log.error({ err }, "Could not take the pre-upgrade database copy; continuing without it.");
    return null;
  }
}

export function readPreUpgradeMeta(dbPath: string): PreUpgradeMeta | null {
  try {
    return JSON.parse(fs.readFileSync(metaPath(dbPath), "utf8")) as PreUpgradeMeta;
  } catch {
    return null;
  }
}

export function clearPreUpgradeStaging(dbPath: string): void {
  fs.rmSync(preUpgradeStagingPath(dbPath), { force: true });
  fs.rmSync(metaPath(dbPath), { force: true });
}

/** Stamp the version that has just booted (after migrations succeeded). */
export function recordBootedVersion(db: Database.Database, version: string): void {
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(LAST_BOOTED_VERSION_KEY, version);
}
