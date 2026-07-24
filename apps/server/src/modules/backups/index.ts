import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import archiver from "archiver";
import AdmZip from "adm-zip";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, logActivity } from "../../db.js";
import { config } from "../../config.js";
import { parseBody } from "../../core/shared.js";
import { receiveUpload, UploadError } from "../uploads/index.js";

// Database backups. A backup is a zip containing database.sqlite (a consistent
// online snapshot) and, optionally, the thumbnail cache under thumbnails/ — those
// cover images can't all be regenerated from source (uploaded and provider-fetched
// covers live only in the cache). The metadata cache is not included (the DB is the
// source of truth) and source media is never touched.
//
// Restore is split: cover images are written back into the cache live (static
// files), and the database is staged as "<dbPath>.restore" for db.ts to swap in on
// the next startup (it can't be replaced while better-sqlite3 holds it open).
//
// A pre-restore safety snapshot of the current DB is written as a .sqlite file, so
// the list accepts both .zip (full) and .sqlite (database-only) backups.

const BACKUP_PREFIX = "isputnik-";
const NAME_PATTERN = /^isputnik-[0-9]{8}-[0-9]{6}\.(zip|sqlite)$/;
const SETTINGS_KEY = "backup_schedule";

interface BackupFile {
  name: string;
  sizeBytes: number;
  createdAt: string;
  kind: "full" | "database";
}

interface BackupSettings {
  enabled: boolean;
  time: string;       // "HH:MM", 24h local time
  retention: number;  // keep newest N
  includeCovers: boolean;
}

function defaultSettings(): BackupSettings {
  return { enabled: false, time: "03:00", retention: Math.max(1, config.backupRetention), includeCovers: true };
}

function getSettings(): BackupSettings {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(SETTINGS_KEY) as { value: string } | undefined;
  const base = defaultSettings();
  if (!row) {
    return base;
  }
  try {
    const parsed = JSON.parse(row.value) as Partial<BackupSettings>;
    return {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : base.enabled,
      time: /^([01]\d|2[0-3]):[0-5]\d$/.test(parsed.time ?? "") ? parsed.time! : base.time,
      retention: Number.isFinite(parsed.retention) && parsed.retention! >= 1 ? Math.floor(parsed.retention!) : base.retention,
      includeCovers: typeof parsed.includeCovers === "boolean" ? parsed.includeCovers : base.includeCovers
    };
  } catch {
    return base;
  }
}

function saveSettings(settings: BackupSettings, userId: string | null) {
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_by, updated_at)
    VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `).run(SETTINGS_KEY, JSON.stringify(settings), userId);
}

function ensureBackupDir() {
  fs.mkdirSync(config.backupPath, { recursive: true });
}

function timestampName(ext: "zip" | "sqlite", date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
  return `${BACKUP_PREFIX}${stamp}.${ext}`;
}

// A timestamp name not already taken in the backup folder (uploads can collide with
// an existing backup taken in the same second); step forward a second until free.
function uniqueBackupName(ext: "zip" | "sqlite"): string {
  let date = new Date();
  let name = timestampName(ext, date);
  while (fs.existsSync(path.join(config.backupPath, name))) {
    date = new Date(date.getTime() + 1000);
    name = timestampName(ext, date);
  }
  return name;
}

function listBackupFiles(): BackupFile[] {
  if (!fs.existsSync(config.backupPath)) {
    return [];
  }
  return fs.readdirSync(config.backupPath)
    .filter((name) => NAME_PATTERN.test(name))
    .map((name) => {
      const stat = fs.statSync(path.join(config.backupPath, name));
      return { name, sizeBytes: stat.size, createdAt: stat.mtime.toISOString(), kind: name.endsWith(".zip") ? "full" as const : "database" as const };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function pruneBackups(keep: number): number {
  const stale = listBackupFiles().slice(Math.max(1, keep));
  for (const file of stale) {
    try { fs.unlinkSync(path.join(config.backupPath, file.name)); } catch { /* best-effort */ }
  }
  return stale.length;
}

function resolveBackupPath(name: string): string | null {
  if (!NAME_PATTERN.test(name)) {
    return null;
  }
  const resolved = path.join(config.backupPath, name);
  return path.dirname(resolved) === path.resolve(config.backupPath) ? resolved : null;
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

// Create a zip backup (DB + optional covers) and prune to the retention limit.
async function runBackup(actorUserId: string | null, trigger: "manual" | "scheduled"): Promise<BackupFile> {
  ensureBackupDir();
  const settings = getSettings();
  const name = timestampName("zip");
  const destination = path.join(config.backupPath, name);
  const tmpDb = path.join(config.backupPath, `.tmp-${Date.now()}.sqlite`);

  await db.backup(tmpDb);
  try {
    await new Promise<void>((resolve, reject) => {
      const output = fs.createWriteStream(destination);
      const archive = archiver("zip", { zlib: { level: 1 } });
      output.on("close", () => resolve());
      output.on("error", reject);
      archive.on("error", reject);
      archive.pipe(output);
      archive.file(tmpDb, { name: "database.sqlite" });
      if (settings.includeCovers && config.thumbnailPath && fs.existsSync(config.thumbnailPath)) {
        archive.directory(config.thumbnailPath, "thumbnails");
      }
      void archive.finalize();
    });
  } finally {
    fs.rmSync(tmpDb, { force: true });
  }

  const pruned = pruneBackups(settings.retention);
  const stat = fs.statSync(destination);
  logActivity({
    event: "backup.created",
    actorUserId,
    targetType: "backup",
    targetId: name,
    detail: `${trigger === "scheduled" ? "Scheduled" : "Manual"} backup "${name}" (${stat.size} bytes${settings.includeCovers ? ", with covers" : ""})${pruned > 0 ? `, pruned ${pruned} old` : ""}.`,
    ipAddress: null
  });
  return { name, sizeBytes: stat.size, createdAt: stat.mtime.toISOString(), kind: "full" };
}

// ── Scheduler ───────────────────────────────────────────────────────
let scheduleTimer: NodeJS.Timeout | null = null;

function nextRunDelayMs(time: string): number {
  const [h, m] = time.split(":").map(Number);
  const now = new Date();
  const next = new Date(now);
  next.setHours(h, m, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime() - now.getTime();
}

function rescheduleBackups() {
  if (scheduleTimer) {
    clearTimeout(scheduleTimer);
    scheduleTimer = null;
  }
  const settings = getSettings();
  if (!settings.enabled) {
    return;
  }
  scheduleTimer = setTimeout(() => {
    runBackup(null, "scheduled")
      .catch((err) => console.error("Scheduled backup failed:", err))
      .finally(() => rescheduleBackups());
  }, nextRunDelayMs(settings.time));
}

const settingsSchema = z.object({
  enabled: z.boolean(),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Time must be HH:MM (24-hour)"),
  retention: z.number().int().min(1).max(100),
  includeCovers: z.boolean()
});

export async function backupsPlugin(app: FastifyInstance) {
  app.get("/api/backups", { preHandler: app.requireAdmin }, async () => {
    const backups = listBackupFiles();
    return {
      backups,
      backupPath: config.backupPath,
      settings: getSettings(),
      coversAvailable: Boolean(config.thumbnailPath),
      totalSizeBytes: backups.reduce((sum, b) => sum + b.sizeBytes, 0)
    };
  });

  app.post("/api/backups", { preHandler: app.requireAdmin }, async (request, reply) => {
    try {
      const backup = await runBackup(request.user!.id, "manual");
      reply.code(201).send({ backup });
    } catch (err) {
      reply.code(500).send({ error: err instanceof Error ? err.message : "Backup failed" });
    }
  });

  app.patch("/api/backups/settings", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(settingsSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid backup settings", details: parsed.error });
      return;
    }
    saveSettings(parsed.data, request.user!.id);
    rescheduleBackups();
    logActivity({
      event: "backup.settings_updated",
      actorUserId: request.user!.id,
      targetType: "setting",
      targetId: SETTINGS_KEY,
      detail: `Backup schedule ${parsed.data.enabled ? `enabled at ${parsed.data.time}` : "disabled"}, keep ${parsed.data.retention}, covers ${parsed.data.includeCovers ? "on" : "off"}.`,
      ipAddress: request.ip
    });
    reply.send({ settings: parsed.data });
  });

  app.get("/api/backups/:name/download", { preHandler: app.requireAdmin }, async (request, reply) => {
    const name = (request.params as { name: string }).name;
    const filePath = resolveBackupPath(name);
    if (!filePath || !fs.existsSync(filePath)) {
      reply.code(404).send({ error: "Backup not found" });
      return;
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
      reply.code(404).send({ error: "Backup not found" });
      return;
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
    reply.send({ deleted: true });
  });

  // Restore: extract covers back into the cache immediately (static files) and
  // stage the database as "<dbPath>.restore" for db.ts to apply on next startup.
  app.post("/api/backups/:name/restore", { preHandler: app.requireAdmin }, async (request, reply) => {
    const name = (request.params as { name: string }).name;
    const filePath = resolveBackupPath(name);
    if (!filePath || !fs.existsSync(filePath)) {
      reply.code(404).send({ error: "Backup not found" });
      return;
    }

    const stagedDb = `${config.dbPath}.restore`;
    let coversRestored = 0;

    try {
      if (name.endsWith(".sqlite")) {
        assertValidSqlite(filePath);
        fs.copyFileSync(filePath, stagedDb);
      } else {
        const zip = new AdmZip(filePath);
        const entries = zip.getEntries();
        const dbEntry = entries.find((e) => !e.isDirectory && (e.entryName === "database.sqlite" || e.entryName.endsWith("/database.sqlite")));
        if (!dbEntry) {
          reply.code(400).send({ error: "Backup is missing its database." });
          return;
        }
        // Write DB to a temp file, validate, then promote to the staging path.
        const tmp = `${config.dbPath}.restore.tmp`;
        fs.writeFileSync(tmp, dbEntry.getData());
        try {
          assertValidSqlite(tmp);
        } catch {
          fs.rmSync(tmp, { force: true });
          reply.code(400).send({ error: "Backup database is not a valid SQLite file." });
          return;
        }
        fs.renameSync(tmp, stagedDb);

        // Restore covers live into the thumbnail cache.
        if (config.thumbnailPath) {
          for (const entry of entries) {
            if (entry.isDirectory || !entry.entryName.startsWith("thumbnails/")) {
              continue;
            }
            const dest = path.join(config.thumbnailPath, entry.entryName.slice("thumbnails/".length));
            if (!isInside(dest, config.thumbnailPath)) {
              continue;
            }
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, entry.getData());
            coversRestored += 1;
          }
        }
      }
    } catch (err) {
      reply.code(500).send({ error: err instanceof Error ? err.message : "Restore failed" });
      return;
    }

    logActivity({
      event: "backup.restore_staged",
      actorUserId: request.user!.id,
      targetType: "backup",
      targetId: name,
      detail: `Staged restore from "${name}"${coversRestored > 0 ? `, restored ${coversRestored} cover file(s)` : ""}; database applies on next restart.`,
      ipAddress: request.ip
    });
    reply.send({ staged: true, coversRestored });
  });

  // Upload a backup file (.zip full backup, or .sqlite database-only) from the admin's
  // computer. It streams to disk under the standard backup name so it joins the list
  // and can be restored like any other. We confirm it is actually an isputnik backup
  // before accepting it. Admin-only and uncapped — a trusted operator restoring a
  // possibly-large full backup (DB + covers).
  app.post("/api/backups/upload", { preHandler: app.requireAdmin }, async (request, reply) => {
    ensureBackupDir();

    let received;
    try {
      received = await receiveUpload(request, { accept: ["zip", "sqlite"], maxBytes: null }, config.backupPath);
    } catch (err) {
      const status = err instanceof UploadError ? err.statusCode : 400;
      reply.code(status).send({ error: err instanceof Error ? err.message : "Upload failed" });
      return;
    }

    // Reject anything that isn't a real isputnik backup before it joins the list.
    try {
      if (received.extension === "sqlite") {
        assertValidSqlite(received.tmpPath);
      } else {
        const zip = new AdmZip(received.tmpPath);
        const hasDb = zip.getEntries().some(
          (entry) => !entry.isDirectory && (entry.entryName === "database.sqlite" || entry.entryName.endsWith("/database.sqlite"))
        );
        if (!hasDb) {
          throw new Error("This zip is not an isputnik backup — it has no database.sqlite inside.");
        }
      }
    } catch (err) {
      fs.rmSync(received.tmpPath, { force: true });
      reply.code(400).send({ error: err instanceof Error ? err.message : "Not a valid backup file." });
      return;
    }

    const name = uniqueBackupName(received.extension as "zip" | "sqlite");
    const destination = path.join(config.backupPath, name);
    try {
      fs.renameSync(received.tmpPath, destination);
    } catch (err) {
      fs.rmSync(received.tmpPath, { force: true });
      reply.code(500).send({ error: err instanceof Error ? err.message : "Could not store the uploaded backup." });
      return;
    }

    const stat = fs.statSync(destination);
    logActivity({
      event: "backup.uploaded",
      actorUserId: request.user!.id,
      targetType: "backup",
      targetId: name,
      detail: `Uploaded backup "${name}" (${stat.size} bytes) from "${received.filename}".`,
      ipAddress: request.ip
    });
    reply.code(201).send({
      backup: {
        name,
        sizeBytes: stat.size,
        createdAt: stat.mtime.toISOString(),
        kind: received.extension === "zip" ? "full" : "database"
      }
    });
  });

  app.addHook("onReady", async () => { rescheduleBackups(); });
  app.addHook("onClose", async () => { if (scheduleTimer) clearTimeout(scheduleTimer); });
}
