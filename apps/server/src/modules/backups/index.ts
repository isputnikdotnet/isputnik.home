import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, logActivity } from "../../db.js";
import { config, mfaKeyFilePath } from "../../config.js";
import { parseBody } from "../../core/shared.js";
import { receiveUpload, UploadError } from "../uploads/index.js";
import { configuredThumbnailPathValue } from "../library/shared/thumbnail.js";
import { configureScheduledJob } from "../maintenance/scheduler.js";
import { extractFromZip, isBackupDatabaseEntry, isBackupMfaKeyEntry, zipHasEntry } from "./zip-read.js";
import {
  BACKUP_KINDS,
  NAME_PATTERN,
  SETTINGS_KEY,
  adoptPreRestoreSnapshot,
  adoptPreUpgradeCopy,
  backupDir,
  backupKindOf,
  backupRunState,
  ensureBackupDir,
  getSettings,
  listBackupFiles,
  saveSettings,
  startBackup,
  uniqueBackupName,
  type BackupKind
} from "./run.js";
import { log } from "../../core/logger.js";
import type { AppSettingRow } from "../../db/rows.js";

// Database backups. What a backup holds, and how one is taken, is in run.ts (three
// kinds: full, minimal, a quick database copy). This file is the admin API over
// them: list, start, retention, download, delete, restore and upload.
//
// Restore is split: cover images are written back into the cache live (static
// files), and the database is staged as "<dbPath>.restore" for db.ts to swap in on
// the next startup (it can't be replaced while better-sqlite3 holds it open).
//
// Scheduling is not this module's any more. The two backup jobs sit on the Scheduled
// jobs page beside the library scans (modules/maintenance), with the same cadence,
// day and time controls; the Backup page shows and edits the same two rows.

export { backupDir, backupRunSettled } from "./run.js";

// Until 3.89.0 the module ran its own daily timer from a {enabled, time,
// includeCovers} blob. An install upgrading with that timer on must not wake up
// silently unscheduled: the setting becomes the matching job — full when covers were
// included, minimal otherwise — daily at the same clock time. The blob is then
// rewritten to the new shape, so this runs once.
export function adoptLegacyBackupSchedule(): "full" | "minimal" | null {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(SETTINGS_KEY) as Pick<AppSettingRow, "value"> | undefined;
  if (!row) return null;
  let legacy: { enabled?: unknown; time?: unknown; includeCovers?: unknown };
  try {
    legacy = JSON.parse(row.value) as typeof legacy;
  } catch {
    return null;
  }
  if (typeof legacy.enabled !== "boolean") return null; // already the new shape
  let adopted: "full" | "minimal" | null = null;
  if (legacy.enabled) {
    adopted = legacy.includeCovers === false ? "minimal" : "full";
    const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(legacy.time)) ? String(legacy.time) : "03:00";
    configureScheduledJob(`backup_${adopted}`, true, { frequency: "daily", time }, null);
  }
  saveSettings(getSettings(), null);
  return adopted;
}

// Backups written before 2.15.1 landed in the app's own folder rather than the
// mounted data volume: the Docker image named DB_PATH, THUMBNAIL_PATH and
// METADATA_PATH but not BACKUP_PATH, so it fell back to <app>/data/backups. Inside a
// container that path is invisible from the host and is thrown away the moment the
// container is recreated — which is every update.
//
// So on startup, move anything stranded there into the configured folder. Runs once
// in practice (the old folder is left empty), does nothing when the two paths are the
// same (any non-container install), and never overwrites: a name already taken in the
// destination is the newer file and wins.
export function rescueStrandedBackups(): number {
  const legacy = path.resolve(process.cwd(), "data", "backups");
  const target = path.resolve(backupDir());
  if (legacy === target || !fs.existsSync(legacy)) return 0;

  let moved = 0;
  try {
    const names = fs.readdirSync(legacy).filter((name) => NAME_PATTERN.test(name));
    if (names.length === 0) return 0;
    fs.mkdirSync(target, { recursive: true });
    for (const name of names) {
      const to = path.join(target, name);
      if (fs.existsSync(to)) continue;
      try {
        fs.renameSync(path.join(legacy, name), to);
      } catch {
        // Different filesystems can't be renamed across; copy and drop the original.
        fs.copyFileSync(path.join(legacy, name), to);
        fs.rmSync(path.join(legacy, name), { force: true });
      }
      moved += 1;
    }
  } catch {
    return moved; // best-effort: a backup left behind is better than a failed boot
  }

  if (moved > 0) {
    log.info(`Moved ${moved} backup${moved === 1 ? "" : "s"} into ${target} — earlier versions stored them where a container update would discard them.`);
  }
  return moved;
}

function resolveBackupPath(name: string): string | null {
  if (!NAME_PATTERN.test(name)) {
    return null;
  }
  const resolved = path.join(backupDir(), name);
  return path.dirname(resolved) === path.resolve(backupDir()) ? resolved : null;
}

// Guard against zip-slip / traversal when writing extracted files.
function isInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function assertValidSqlite(filePath: string) {
  const check = new Database(filePath, { readonly: true });
  try {
    check.pragma("schema_version");
  } finally {
    check.close();
  }
}

const settingsSchema = z.object({
  retention: z.number().int().min(1).max(100)
});

// Absent means full, so an older client (or a bare "{}") gets what it always got.
const createSchema = z.object({
  kind: z.enum(BACKUP_KINDS as [BackupKind, ...BackupKind[]]).default("full")
});

// Restoring is all-or-nothing about the database and optional about the covers.
// Absent means yes, so an older client (or a bare "{}") restores everything.
const restoreSchema = z.object({
  covers: z.boolean().default(true)
});

export async function backupsPlugin(app: FastifyInstance) {
  // Before anything can list them: an install upgrading from an earlier version may
  // have backups sitting where a container update would discard them.
  rescueStrandedBackups();
  const preRestore = adoptPreRestoreSnapshot();
  if (preRestore) app.log.info(`Kept the database the restore replaced: ${preRestore} (Backup page).`);
  const preUpgrade = adoptPreUpgradeCopy();
  if (preUpgrade) app.log.info(`Saved the database as it was before this upgrade: ${preUpgrade} (Backup page).`);
  try {
    const adopted = adoptLegacyBackupSchedule();
    if (adopted) app.log.info(`The daily backup schedule is now the "${adopted}" backup job on the Scheduled jobs page.`);
  } catch (err) {
    app.log.warn({ err }, "Could not carry the old backup schedule into the scheduled jobs; set it again on the Backup page.");
  }

  app.get("/api/backups", { preHandler: app.requireAdmin }, async () => {
    const backups = listBackupFiles();
    const run = backupRunState();
    return {
      backups,
      backupPath: backupDir(),
      settings: getSettings(),
      coversAvailable: Boolean(configuredThumbnailPathValue()),
      totalSizeBytes: backups.reduce((sum, b) => sum + b.sizeBytes, 0),
      runningSince: run.startedAt,
      runningKind: run.kind,
      lastError: run.lastError
    };
  });

  app.post("/api/backups", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(createSchema, request.body ?? {});
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid backup request", details: parsed.error });
    }
    if (!startBackup(request.user!.id, "manual", parsed.data.kind)) {
      return reply.code(409).send({ error: "A backup is already running." });
    }
    return reply.code(202).send({ startedAt: backupRunState().startedAt, kind: parsed.data.kind });
  });

  app.patch("/api/backups/settings", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(settingsSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid backup settings", details: parsed.error });
    }
    saveSettings(parsed.data, request.user!.id);
    logActivity({
      event: "backup.settings_updated",
      actorUserId: request.user!.id,
      targetType: "setting",
      targetId: SETTINGS_KEY,
      detail: `Backups keep the newest ${parsed.data.retention} of each kind.`,
      ipAddress: request.ip
    });
    return reply.send({ settings: parsed.data });
  });

  app.get("/api/backups/:name/download", { preHandler: app.requireAdmin }, async (request, reply) => {
    const name = (request.params as { name: string }).name;
    const filePath = resolveBackupPath(name);
    if (!filePath || !fs.existsSync(filePath)) {
      return reply.code(404).send({ error: "Backup not found" });
    }
    const stat = fs.statSync(filePath);
    logActivity({
      event: "backup.downloaded",
      actorUserId: request.user!.id,
      targetType: "backup",
      targetId: name,
      detail: `Downloaded backup "${name}".`,
      ipAddress: request.ip
    });
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": name.endsWith(".zip") ? "application/zip" : "application/octet-stream",
      "Content-Length": stat.size,
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "private, no-cache"
    });
    const stream = fs.createReadStream(filePath);
    stream.on("error", (err) => reply.raw.destroy(err));
    stream.pipe(reply.raw);
  });

  app.delete("/api/backups/:name", { preHandler: app.requireAdmin }, async (request, reply) => {
    const name = (request.params as { name: string }).name;
    const filePath = resolveBackupPath(name);
    if (!filePath || !fs.existsSync(filePath)) {
      return reply.code(404).send({ error: "Backup not found" });
    }
    fs.unlinkSync(filePath);
    logActivity({
      event: "backup.deleted",
      actorUserId: request.user!.id,
      targetType: "backup",
      targetId: name,
      detail: `Deleted backup "${name}".`,
      ipAddress: request.ip
    });
    return reply.send({ deleted: true });
  });

  // Restore: extract covers back into the cache immediately (static files) and
  // stage the database as "<dbPath>.restore" for db.ts to apply on next startup.
  // A minimal zip simply has no thumbnails/ entries, so the same path serves it.
  // destructive: restoring replaces the live database — refused from untrusted
  // networks under the deletions-only policy (see deletionBlocked).
  app.post("/api/backups/:name/restore", { preHandler: app.requireAdmin, config: { destructive: true } }, async (request, reply) => {
    const name = (request.params as { name: string }).name;
    const filePath = resolveBackupPath(name);
    if (!filePath || !fs.existsSync(filePath)) {
      return reply.code(404).send({ error: "Backup not found" });
    }

    // Covers are the bulk of a full backup and the slow half of a restore, and an
    // admin reaching for a backup usually wants the database back — the covers in
    // the cache are often the ones they already have. Default on, so a restore that
    // says nothing still puts everything back.
    const parsed = parseBody(restoreSchema, request.body ?? {});
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid restore options", details: parsed.error });
    }
    const wantCovers = parsed.data.covers;

    const stagedDb = `${config.dbPath}.restore`;
    let coversRestored = 0;
    let mfaKeyStaged = false;

    try {
      if (name.endsWith(".sqlite")) {
        assertValidSqlite(filePath);
        fs.copyFileSync(filePath, stagedDb);
      } else {
        // The database first and on its own: an invalid one aborts the restore, and
        // it must do that before any cover is written over the live cache.
        const tmp = `${config.dbPath}.restore.tmp`;
        const gotDb = await extractFromZip(filePath, (name) => (isBackupDatabaseEntry(name) ? tmp : null));
        if (gotDb === 0) {
          return reply.code(400).send({ error: "Backup is missing its database." });
        }
        try {
          assertValidSqlite(tmp);
        } catch {
          fs.rmSync(tmp, { force: true });
          return reply.code(400).send({ error: "Backup database is not a valid SQLite file." });
        }
        fs.renameSync(tmp, stagedDb);
        // assertValidSqlite opened the temp file, and opening a WAL database writes
        // -shm/-wal beside it. The rename above moves only the main file, so without
        // this the pair is stranded in the data folder for good — a real install had
        // a .restore.tmp-shm sitting next to its database months after the restore.
        for (const ext of ["-wal", "-shm"]) {
          fs.rmSync(`${tmp}${ext}`, { force: true });
        }

        // The key is STAGED beside the database, never written live: until the next
        // restart this process still serves the current database, whose secrets the
        // current key decrypts. Swapping the key out from under it would break TOTP
        // for everyone in the meantime, then fix itself on restart — a confusing
        // window with no upside. db.ts moves the pair into place together.
        mfaKeyStaged = await extractFromZip(filePath, (entry) =>
          isBackupMfaKeyEntry(entry) ? `${mfaKeyFilePath()}.restore` : null
        ) > 0;

        // Restore covers live into the thumbnail cache — the configured one, so they
        // land where the app will look for them rather than where the environment
        // happens to point.
        const cache = wantCovers ? configuredThumbnailPathValue() : "";
        if (cache) {
          coversRestored = await extractFromZip(filePath, (name) => {
            if (!name.startsWith("thumbnails/")) return null;
            const dest = path.join(cache, name.slice("thumbnails/".length));
            return isInside(dest, cache) ? dest : null;
          });
        }
      }
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : "Restore failed" });
    }

    logActivity({
      event: "backup.restore_staged",
      actorUserId: request.user!.id,
      targetType: "backup",
      targetId: name,
      detail: `Staged restore from "${name}"${
        wantCovers
          ? coversRestored > 0 ? `, restored ${coversRestored} cover file(s)` : ""
          : ", database only (cover art left as it is)"
      }${
        mfaKeyStaged ? ", with its two-factor key" : ""
      }; database applies on next restart.`,
      ipAddress: request.ip
    });
    return reply.send({ staged: true, coversRestored, coversSkipped: !wantCovers, mfaKeyStaged });
  });

  // Upload a backup file (.zip full or minimal backup, or .sqlite database-only) from
  // the admin's computer. It streams to disk under the standard backup name so it
  // joins the list and can be restored like any other. We confirm it is actually an
  // isputnik backup before accepting it. Admin-only and uncapped — a trusted operator
  // restoring a possibly-large full backup (DB + covers).
  app.post("/api/backups/upload", { preHandler: app.requireAdmin }, async (request, reply) => {
    ensureBackupDir();

    let received;
    try {
      received = await receiveUpload(request, { accept: ["zip", "sqlite"], maxBytes: null }, backupDir());
    } catch (err) {
      const status = err instanceof UploadError ? err.statusCode : 400;
      return reply.code(status).send({ error: err instanceof Error ? err.message : "Upload failed" });
    }

    // Reject anything that isn't a real isputnik backup before it joins the list.
    // A zip with no thumbnails/ inside is filed as minimal, so the list says what it
    // holds whatever the file was called on the way in.
    let kind: BackupKind;
    try {
      if (received.extension === "sqlite") {
        assertValidSqlite(received.tmpPath);
        kind = "database";
      } else {
        if (!(await zipHasEntry(received.tmpPath, isBackupDatabaseEntry))) {
          throw new Error("This zip is not an isputnik backup — it has no database.sqlite inside.");
        }
        kind = (await zipHasEntry(received.tmpPath, (entry) => entry.startsWith("thumbnails/"))) ? "full" : "minimal";
      }
    } catch (err) {
      fs.rmSync(received.tmpPath, { force: true });
      return reply.code(400).send({ error: err instanceof Error ? err.message : "Not a valid backup file." });
    }

    const name = uniqueBackupName(kind);
    const destination = path.join(backupDir(), name);
    try {
      fs.renameSync(received.tmpPath, destination);
    } catch (err) {
      fs.rmSync(received.tmpPath, { force: true });
      return reply.code(500).send({ error: err instanceof Error ? err.message : "Could not store the uploaded backup." });
    }

    const stat = fs.statSync(destination);
    logActivity({
      event: "backup.uploaded",
      actorUserId: request.user!.id,
      targetType: "backup",
      targetId: name,
      detail: `Uploaded ${kind === "database" ? "database copy" : `${kind} backup`} "${name}" (${stat.size} bytes) from "${received.filename}".`,
      ipAddress: request.ip
    });
    return reply.code(201).send({
      backup: {
        name,
        sizeBytes: stat.size,
        createdAt: stat.mtime.toISOString(),
        kind: backupKindOf(name)
      }
    });
  });
}
