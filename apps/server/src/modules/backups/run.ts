import fs from "node:fs";
import path from "node:path";
import { ZipArchive } from "archiver";
import { db, logActivity, preRestoreSnapshotPath } from "../../db.js";
import { config, mfaKeyFilePath } from "../../config.js";
import { resolveAppLocation } from "../../core/app-storage.js";
import { configuredThumbnailPathValue } from "../library/shared/thumbnail.js";
import { listIrreplaceableArt } from "../library/shared/irreplaceable-art.js";
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
//   minimal   isputnik-<stamp>-minimal.zip   database + mfa.key + the art a rescan
//                                            could not put back
//   database  isputnik-<stamp>.sqlite        the database file alone, a quick copy
//
// The database is a consistent online snapshot (db.backup) and mfa.key, when the
// install keeps one, is the only thing that can decrypt the TOTP secrets inside it:
// a backup without the key restores an install whose two-factor users must all
// re-enrol. So the key travels in both zips.
//
// "Minimal" means exactly the things that cannot be recreated, which is why it is
// not database-and-key alone: most covers regenerate from the originals, but an
// uploaded cover, a cover fetched from a metadata provider, an author portrait, a
// category tile or a family-tree portrait exists nowhere but the thumbnail store,
// and a rescan leaves it blank for good. Those files travel in a minimal backup —
// library/shared/irreplaceable-art.ts is what decides which they are, and says why
// a gallery preview or a face crop is not one of them. A full backup instead takes
// the thumbnail store whole, derived work included, so a restore needs no re-render.
//
// The metadata cache is never included (the DB is the source of truth) and source
// media is never touched.
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

/** The small JSON file every zip carries, saying which kind it is and what of the
 *  thumbnail store went in. Read on upload (index.ts); ignored by restore. */
export const MANIFEST_NAME = "backup.json";

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
  /** How many of each kind to keep. The kinds are pruned independently, and each
   *  has its own number: a nightly minimal backup and a monthly full one are kept
   *  for different reasons and are wildly different sizes, so "keep 14" of the
   *  small one and "keep 2" of the big one is the ordinary arrangement. */
  retention: Record<BackupKind, number>;
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

export const RETENTION_MAX = 100;

/** A retention count as the settings may hold it: at least 1, whole, capped. */
export function clampRetention(value: unknown, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) return fallback;
  return Math.min(RETENTION_MAX, Math.floor(number));
}

export function defaultSettings(): BackupSettings {
  const starting = clampRetention(config.backupRetention, 10);
  return { retention: { full: starting, minimal: starting, database: starting } };
}

// The stored blob is the retention counts. Two older shapes read fine:
//
//   • before 4.3.0 one number stood for all three kinds — it still reads as "the
//     same for every kind", which is what that install had.
//   • before 3.89.0 the blob also carried the module's own daily schedule
//     (enabled/time/includeCovers); index.ts moves that into the scheduled jobs on
//     startup and rewrites the row, so that shape is seen once at most.
export function getSettings(): BackupSettings {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(SETTINGS_KEY) as Pick<AppSettingRow, "value"> | undefined;
  const base = defaultSettings();
  if (!row) return base;
  try {
    const stored = (JSON.parse(row.value) as { retention?: unknown }).retention;
    if (typeof stored === "number") {
      const same = clampRetention(stored, base.retention.full);
      return { retention: { full: same, minimal: same, database: same } };
    }
    if (stored && typeof stored === "object") {
      const per = stored as Partial<Record<BackupKind, unknown>>;
      return {
        retention: {
          full: clampRetention(per.full, base.retention.full),
          minimal: clampRetention(per.minimal, base.retention.minimal),
          database: clampRetention(per.database, base.retention.database)
        }
      };
    }
    return base;
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

/** What a zip carries from the thumbnail store: the store whole (full), or only
 *  the pictures a rescan could not put back (minimal). */
type ArtScope = "all" | "irreplaceable";

/** What went into a zip, for the activity log and the zip's own manifest. */
interface ZipContents {
  /** Files taken from the thumbnail store; -1 = the store was added whole, so
   *  they were never counted one by one. */
  artFiles: number;
  /** The sentence fragment the activity log uses for them. */
  note: string;
}

async function writeZip(destination: string, tmpDb: string, kind: BackupKind, scope: ArtScope): Promise<ZipContents> {
  const contents: ZipContents = { artFiles: 0, note: "" };
  // Where the covers actually are, which is not necessarily THUMBNAIL_PATH: the
  // store is an admin setting that overrides the environment (see
  // library/shared/thumbnail.ts), and everything else in the app reads it that
  // way. Reading only the environment here meant a backup that quietly carried no
  // covers at all — or carried the wrong, empty folder — while still reporting
  // itself as "with covers".
  const coverRoot = configuredThumbnailPathValue();
  const haveStore = Boolean(coverRoot) && fs.existsSync(coverRoot);
  const art = haveStore && scope === "irreplaceable" ? listIrreplaceableArt() : [];
  if (haveStore && scope === "all") {
    contents.artFiles = -1;
    contents.note = ", with every cover";
  } else if (art.length > 0) {
    contents.artFiles = art.length;
    contents.note = `, with ${art.length} picture${art.length === 1 ? "" : "s"} a rescan could not put back`;
  }

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
    if (haveStore && scope === "all") {
      archive.directory(coverRoot, "thumbnails");
    } else {
      // Under the same "thumbnails/" prefix a full backup uses, so restore has one
      // path for both and a minimal zip needs no special handling.
      for (const picture of art) {
        archive.file(picture.absolutePath, { name: `thumbnails/${picture.key}` });
      }
    }
    // What this zip is, in the zip: the kind used to be readable only from the file
    // name, and a minimal backup now holds thumbnails too, so "has a thumbnails/
    // folder" stopped telling full and minimal apart on upload (index.ts).
    archive.append(JSON.stringify({
      kind,
      art: contents.artFiles === -1 ? "all" : "irreplaceable",
      artFiles: contents.artFiles === -1 ? null : contents.artFiles,
      version: config.version,
      createdAt: new Date().toISOString()
    }, null, 2), { name: MANIFEST_NAME });
    void archive.finalize();
  });
  return contents;
}

// Take one backup of the given kind and prune that kind to the retention limit.
async function runBackup(actorUserId: string | null, trigger: "manual" | "scheduled", kind: BackupKind): Promise<BackupFile> {
  ensureBackupDir();
  const settings = getSettings();
  const name = uniqueBackupName(kind);
  const destination = path.join(backupDir(), name);
  const tmpDb = path.join(backupDir(), `.tmp-${Date.now()}.sqlite`);

  let artNote = "";
  await db.backup(tmpDb);
  try {
    if (kind === "database") {
      // The snapshot IS the backup: rename it into place rather than copy it.
      fs.renameSync(tmpDb, destination);
    } else {
      artNote = (await writeZip(destination, tmpDb, kind, kind === "full" ? "all" : "irreplaceable")).note;
    }
  } finally {
    fs.rmSync(tmpDb, { force: true });
  }

  const pruned = pruneBackups(kind, settings.retention[kind]);
  const stat = fs.statSync(destination);
  logActivity({
    event: "backup.created",
    actorUserId,
    targetType: "backup",
    targetId: name,
    detail: `${trigger === "scheduled" ? "Scheduled" : "Manual"} ${KIND_WORDS[kind]} backup "${name}" (${stat.size} bytes${artNote})${pruned > 0 ? `, pruned ${pruned} old` : ""}.`,
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
