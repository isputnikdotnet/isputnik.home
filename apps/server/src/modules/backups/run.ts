import fs from "node:fs";
import path from "node:path";
import { ZipArchive } from "archiver";
import { db, logActivity, preRestoreSnapshotPath } from "../../db.js";
import { config, mfaKeyFilePath } from "../../config.js";
import { resolveAppLocation } from "../../core/app-storage.js";
import { configuredThumbnailPathValue } from "../library/shared/thumbnail.js";
import { clearPreUpgradeStaging, preUpgradeStagingPath, readPreUpgradeMeta } from "../../db/pre-upgrade.js";
import { log } from "../../core/logger.js";
import type { AppSettingRow } from "../../db/rows.js";

// What a backup is, how it is named, and how one is taken. The routes live in
// index.ts; this half is here on its own so the scheduled jobs (modules/maintenance)
// can start a backup without importing the plugin, and the plugin can import the
// scheduler without a cycle.
//
// Three kinds, told apart by the file name:
//
//   full      isputnik-<stamp>.zip           database + mfa.key + every cover image
//   minimal   isputnik-<stamp>-minimal.zip   database + mfa.key
//   database  isputnik-<stamp>.sqlite        the database file alone, a quick copy
//
// The database is a consistent online snapshot (db.backup) and mfa.key, when the
// install keeps one, is the only thing that can decrypt the TOTP secrets inside it:
// a backup without the key restores an install whose two-factor users must all
// re-enrol. So the key travels in both zips, and "minimal" is exactly the two things
// that cannot be recreated. Covers mostly regenerate from the originals; the ones
// that do not (uploaded art, art fetched from a provider) live only in the thumbnail
// store, which is what a full backup adds. The metadata cache is never included
// (the DB is the source of truth) and source media is never touched.
//
// The quick .sqlite copy is what an admin takes before trying something: no zip, no
// key, done in seconds. Restore accepts it like the pre-restore safety snapshot
// db.ts writes, which has the same shape.
//
// One more .sqlite shape is written by the app itself, never on request: the copy of
// the database taken as a new version boots, before its migrations run
// (db/pre-upgrade.ts), named isputnik-<stamp>-pre-upgrade.sqlite. It is a database
// copy like any other to list, download and restore, but it keeps its own retention
// (the newest PRE_UPGRADE_KEEP) so upgrading never pushes an admin's own copies out,
// nor theirs it.

export type BackupKind = "full" | "minimal" | "database";
export const BACKUP_KINDS: BackupKind[] = ["full", "minimal", "database"];

const BACKUP_PREFIX = "isputnik-";
export const NAME_PATTERN = /^isputnik-[0-9]{8}-[0-9]{6}(?:(?:-minimal)?\.zip|(?:-pre-upgrade)?\.sqlite)$/;
export const PRE_UPGRADE_SUFFIX = "-pre-upgrade.sqlite";
export const PRE_UPGRADE_KEEP = 2;

export function isPreUpgradeCopy(name: string): boolean {
  return name.endsWith(PRE_UPGRADE_SUFFIX);
}
export const SETTINGS_KEY = "backup_schedule";

export interface BackupFile {
  name: string;
  sizeBytes: number;
  createdAt: string;
  kind: BackupKind;
}

export interface BackupSettings {
  retention: number;  // keep the newest N of EACH kind
}

export function backupKindOf(name: string): BackupKind {
  if (name.endsWith("-minimal.zip")) return "minimal";
  return name.endsWith(".zip") ? "full" : "database";
}

// The words the activity log and the job summaries use for a kind.
export const KIND_WORDS: Record<BackupKind, string> = {
  full: "full",
  minimal: "minimal",
  database: "database copy"
};

export function defaultSettings(): BackupSettings {
  return { retention: Math.max(1, config.backupRetention) };
}

// The stored blob is the retention count. Before 3.89.0 it also carried the
// module's own daily schedule (enabled/time/includeCovers); index.ts moves that
// into the scheduled jobs on startup and rewrites the row, so reading here only
// ever needs the one field, and tolerates the old shape meanwhile.
export function getSettings(): BackupSettings {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(SETTINGS_KEY) as Pick<AppSettingRow, "value"> | undefined;
  const base = defaultSettings();
  if (!row) return base;
  try {
    const parsed = JSON.parse(row.value) as Partial<BackupSettings>;
    return {
      retention: Number.isFinite(parsed.retention) && parsed.retention! >= 1 ? Math.floor(parsed.retention!) : base.retention
    };
  } catch {
    return base;
  }
}

export function saveSettings(settings: BackupSettings, userId: string | null) {
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_by, updated_at)
    VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `).run(SETTINGS_KEY, JSON.stringify(settings), userId);
}

/** Where backups go: App storage's Backups room when that room is switched on
 *  (docs/app-storage-plan.md), else BACKUP_PATH / data/backups. Read at call time,
 *  never cached — the room can change while the server runs. */
export function backupDir(): string {
  return resolveAppLocation("backups", config.backupPath) ?? config.backupPath;
}

export function ensureBackupDir() {
  fs.mkdirSync(backupDir(), { recursive: true });
}

function timestampName(kind: BackupKind | "pre-upgrade", date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
  const suffix = kind === "pre-upgrade" ? PRE_UPGRADE_SUFFIX : kind === "database" ? ".sqlite" : kind === "minimal" ? "-minimal.zip" : ".zip";
  return `${BACKUP_PREFIX}${stamp}${suffix}`;
}

// A timestamp name not already taken in the backup folder (uploads can collide with
// a backup taken in the same second, and so can two kinds scheduled for the same
// minute); step forward a second until free.
export function uniqueBackupName(kind: BackupKind | "pre-upgrade", from = new Date()): string {
  let date = from;
  let name = timestampName(kind, date);
  while (fs.existsSync(path.join(backupDir(), name))) {
    date = new Date(date.getTime() + 1000);
    name = timestampName(kind, date);
  }
  return name;
}

export function listBackupFiles(): BackupFile[] {
  if (!fs.existsSync(backupDir())) {
    return [];
  }
  return fs.readdirSync(backupDir())
    .filter((name) => NAME_PATTERN.test(name))
    .map((name) => {
      const stat = fs.statSync(path.join(backupDir(), name));
      return { name, sizeBytes: stat.size, createdAt: stat.mtime.toISOString(), kind: backupKindOf(name) };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// Retention is per kind: a nightly minimal backup must not push the weekly full
// ones out of the folder, nor the other way round. Each kind keeps its newest N.
export function pruneBackups(kind: BackupKind, keep: number): number {
  const stale = listBackupFiles().filter((file) => file.kind === kind && !isPreUpgradeCopy(file.name)).slice(Math.max(1, keep));
  for (const file of stale) {
    try { fs.unlinkSync(path.join(backupDir(), file.name)); } catch { /* best-effort */ }
  }
  return stale.length;
}

async function writeZip(destination: string, tmpDb: string, withCovers: boolean): Promise<boolean> {
  let coversIncluded = false;
  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(destination);
    const archive = new ZipArchive({ zlib: { level: 1 } });
    output.on("close", () => resolve());
    output.on("error", reject);
    archive.on("error", reject);
    archive.pipe(output);
    archive.file(tmpDb, { name: "database.sqlite" });
    // Only when the install actually keeps one: with MFA_ENCRYPTION_KEY set there
    // is no file, and the env key is expected to be configured on the host that
    // restores. Absent is therefore normal, not a fault.
    const keyFile = mfaKeyFilePath();
    if (fs.existsSync(keyFile)) {
      archive.file(keyFile, { name: "mfa.key" });
    }
    // Where the covers actually are, which is not necessarily THUMBNAIL_PATH: the
    // store is an admin setting that overrides the environment (see
    // library/shared/thumbnail.ts), and everything else in the app reads it that
    // way. Reading only the environment here meant a backup that quietly carried no
    // covers at all — or carried the wrong, empty folder — while still reporting
    // itself as "with covers".
    const coverRoot = withCovers ? configuredThumbnailPathValue() : "";
    if (coverRoot && fs.existsSync(coverRoot)) {
      archive.directory(coverRoot, "thumbnails");
      coversIncluded = true;
    }
    void archive.finalize();
  });
  return coversIncluded;
}

// Take one backup of the given kind and prune that kind to the retention limit.
async function runBackup(actorUserId: string | null, trigger: "manual" | "scheduled", kind: BackupKind): Promise<BackupFile> {
  ensureBackupDir();
  const settings = getSettings();
  const name = uniqueBackupName(kind);
  const destination = path.join(backupDir(), name);
  const tmpDb = path.join(backupDir(), `.tmp-${Date.now()}.sqlite`);

  let coversIncluded = false;
  await db.backup(tmpDb);
  try {
    if (kind === "database") {
      // The snapshot IS the backup: rename it into place rather than copy it.
      fs.renameSync(tmpDb, destination);
    } else {
      coversIncluded = await writeZip(destination, tmpDb, kind === "full");
    }
  } finally {
    fs.rmSync(tmpDb, { force: true });
  }

  const pruned = pruneBackups(kind, settings.retention);
  const stat = fs.statSync(destination);
  logActivity({
    event: "backup.created",
    actorUserId,
    targetType: "backup",
    targetId: name,
    detail: `${trigger === "scheduled" ? "Scheduled" : "Manual"} ${KIND_WORDS[kind]} backup "${name}" (${stat.size} bytes${coversIncluded ? ", with covers" : ""})${pruned > 0 ? `, pruned ${pruned} old` : ""}.`,
    ipAddress: null
  });
  return { name, sizeBytes: stat.size, createdAt: stat.mtime.toISOString(), kind };
}

// ── Run state ───────────────────────────────────────────────────────
// A backup takes minutes on a real library, which is longer than proxies in
// front of the app will hold a request open (Cloudflare cuts the origin off
// at ~100s and the page shows a failure for a backup that succeeded). So
// creation is start-and-poll: POST starts the run and returns at once, and
// GET /api/backups reports the run until the finished file shows up in the
// list. One run at a time — the second starter is told no, not queued.
let backupStartedAt: string | null = null;
let backupRunningKind: BackupKind | null = null;
let backupLastError: string | null = null;
let backupRunPromise: Promise<void> | null = null;

export function backupRunState(): { startedAt: string | null; kind: BackupKind | null; lastError: string | null } {
  return { startedAt: backupStartedAt, kind: backupRunningKind, lastError: backupLastError };
}

/** Kick off a backup unless one is already running. True if this call started it. */
export function startBackup(actorUserId: string | null, trigger: "manual" | "scheduled", kind: BackupKind): boolean {
  if (backupRunPromise) {
    return false;
  }
  backupStartedAt = new Date().toISOString();
  backupRunningKind = kind;
  backupLastError = null;
  const who = `${trigger === "scheduled" ? "Scheduled" : "Manual"} ${KIND_WORDS[kind]} backup`;
  backupRunPromise = runBackup(actorUserId, trigger, kind)
    .then(() => undefined)
    .catch((err) => {
      backupLastError = err instanceof Error ? err.message : "Backup failed";
      log.error({ err }, `${who} failed`);
      logActivity({
        event: "backup.failed",
        actorUserId,
        targetType: "backup",
        targetId: null,
        detail: `${who} failed: ${backupLastError}`,
        ipAddress: null
      });
    })
    .finally(() => {
      backupStartedAt = null;
      backupRunningKind = null;
      backupRunPromise = null;
    });
  return true;
}

// What the two scheduled jobs call. A job's run is synchronous and answers with a
// sentence for the Scheduled jobs page; the backup itself carries on in the
// background and the Backup page (and the activity log) has the outcome.
export function startScheduledBackup(kind: BackupKind): string {
  if (!startBackup(null, "scheduled", kind)) {
    return "Skipped — a backup is already running; will retry at the next scheduled time.";
  }
  return `Started a ${KIND_WORDS[kind]} backup — it finishes in the background and appears on the Backup page.`;
}

// ── The pre-upgrade copy ────────────────────────────────────────────
// db.ts stages it beside the database before migrating (db/pre-upgrade.ts); here it
// moves into the backups folder, named by when it was taken, and the older ones
// beyond PRE_UPGRADE_KEEP go. Best-effort: a copy that can't be filed stays staged
// and is tried again next boot, never lost and never allowed to fail the boot.
export function adoptPreUpgradeCopy(): string | null {
  const staging = preUpgradeStagingPath(config.dbPath);
  if (!fs.existsSync(staging)) return null;
  const meta = readPreUpgradeMeta(config.dbPath);
  try {
    ensureBackupDir();
    const name = uniqueBackupName("pre-upgrade", meta ? new Date(meta.takenAt) : new Date());
    const destination = path.join(backupDir(), name);
    try {
      fs.renameSync(staging, destination);
    } catch {
      // The backups folder may be another filesystem (App storage, a share).
      fs.copyFileSync(staging, destination);
      fs.rmSync(staging, { force: true });
    }
    clearPreUpgradeStaging(config.dbPath);
    const stale = listBackupFiles().filter((file) => isPreUpgradeCopy(file.name)).slice(PRE_UPGRADE_KEEP);
    for (const file of stale) {
      try { fs.unlinkSync(path.join(backupDir(), file.name)); } catch { /* best-effort */ }
    }
    const from = meta?.from ? `version ${meta.from}` : "the previous version";
    logActivity({
      event: "backup.created",
      actorUserId: null,
      targetType: "backup",
      targetId: name,
      detail: `Automatic pre-upgrade database copy "${name}" — the database as ${from} left it, before ${meta?.to ?? config.version} changed anything.${stale.length > 0 ? ` Pruned ${stale.length} older.` : ""}`,
      ipAddress: null
    });
    return name;
  } catch (err) {
    log.error({ err }, "Could not move the pre-upgrade database copy into the backups folder; will try again next start.");
    return null;
  }
}

// ── The restore's safety snapshot ───────────────────────────────────
// db.ts keeps the database a restore replaced, staged beside it (it can't know
// where the backups folder is that early). File it as an ordinary database copy.
// Before this it went straight to BACKUP_PATH, which with App storage's Backups
// room switched on is a folder the Backup page never lists.
export function adoptPreRestoreSnapshot(): string | null {
  const staging = preRestoreSnapshotPath(config.dbPath);
  if (!fs.existsSync(staging)) return null;
  try {
    ensureBackupDir();
    const name = uniqueBackupName("database", fs.statSync(staging).mtime);
    const destination = path.join(backupDir(), name);
    try {
      fs.renameSync(staging, destination);
    } catch {
      fs.copyFileSync(staging, destination);
      fs.rmSync(staging, { force: true });
    }
    logActivity({
      event: "backup.created",
      actorUserId: null,
      targetType: "backup",
      targetId: name,
      detail: `Safety copy "${name}" of the database a restore replaced.`,
      ipAddress: null
    });
    return name;
  } catch (err) {
    log.error({ err }, "Could not move the pre-restore safety copy into the backups folder; will try again next start.");
    return null;
  }
}

/** Test hook: resolves when no backup is running (immediately if none is). */
export function backupRunSettled(): Promise<void> {
  return backupRunPromise ?? Promise.resolve();
}
