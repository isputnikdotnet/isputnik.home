// One container's backups (docs/dashboard-and-backups-plan.md): back it up, download
// it and restore it apart from Home and from the other containers. Home keeps every
// file in the backups folder and a container keeps none; what is particular to one
// container is in the registry (modules/apps), so a new one gets a card by itself.
//
// A backup of a container can come from two places, and both restore the same way:
//
//   its own file    isputnik-<app>-<stamp>-v<version>.sqlite   Back up now, or uploaded
//   inside a zip    apps/<app>.sqlite in a full or minimal     the database that backup
//                   backup                                     took along
//
// The version is in the file's name so a download that comes back as an upload still
// says what it is. A zip's copy is found through its manifest, read once per zip.
//
// Restoring happens on the container: Home sends the file and the container checks
// it, swaps it in and keeps what it replaced, which is the one thing a container ever
// holds (POST <prefix>/api/admin/restore; isputnik.games and isputnik.video restore.ts).
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { logActivity, type User } from "../../db.js";
import { parseBody } from "../../core/shared.js";
import { log } from "../../core/logger.js";
import { receiveUpload, UploadError } from "../uploads/index.js";
import {
  APP_BACKUP_MAX_BYTES,
  APP_KEEP_MAX,
  SQLITE_MAGIC,
  appBackupSettings,
  runAfterRestore,
  saveAppBackupSettings,
  snapshotApp
} from "../apps/backup.js";
import { forwardedFrom, identityHeaders } from "../apps/gateway.js";
import { resolveAppSecret } from "../apps/pairing.js";
import { APPS, appConfigured, appDefinition, type AppId } from "../apps/registry.js";
import { extractFromZip, isBackupManifestEntry, readZipEntryText } from "./zip-read.js";
import { APP_BACKUP_PATTERN, NAME_PATTERN, backupDir, backupRunState, ensureBackupDir, listBackupFiles } from "./run.js";

/** A container answers about its restore at once or is treated as not there: the
 *  Backup page asks each of them every time it opens. */
const PROBE_TIMEOUT_MS = 3_000;
/** The body is at most the backup cap, over the Docker network. */
const RESTORE_TIMEOUT_MS = 120_000;

export interface AppBackupFile {
  name: string;
  sizeBytes: number;
  createdAt: string;
  version: string | null;
  /** Its own file, or the copy inside a full or minimal backup. */
  source: "own" | "full" | "minimal";
}

export interface AppBackupView {
  id: AppId;
  configured: boolean;
  /** Why a half-set container stays off. */
  problem: string | null;
  include: boolean;
  keep: number;
  files: AppBackupFile[];
  /** true: it can restore. false: too old to. null: it did not answer. */
  restoreSupported: boolean | null;
  undo: { takenAt: string; version: string; bytes: number } | null;
}

const isAppId = (value: string): value is AppId => APPS.some((app) => app.id === value);

/** The version a file's name says it is from. It starts with a digit, which is what
 *  tells it from the "-video-" of the container's own name. */
function versionInName(name: string): string | null {
  return /-v([0-9][0-9A-Za-z.-]{0,39})\.sqlite$/.exec(name)?.[1] ?? null;
}

const safeVersion = (version: string | null) => (version && /^[0-9][0-9A-Za-z.-]{0,39}$/.test(version) ? version : null);

function stamp(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/** A name not taken yet: two in the same second step forward, as Home's own do. */
function uniqueName(id: AppId, version: string | null): string {
  let at = new Date();
  for (;;) {
    const name = `isputnik-${id}-${stamp(at)}${version ? `-v${version}` : ""}.sqlite`;
    if (!fs.existsSync(path.join(backupDir(), name))) return name;
    at = new Date(at.getTime() + 1000);
  }
}

function ownFiles(id: AppId): AppBackupFile[] {
  if (!fs.existsSync(backupDir())) return [];
  return fs.readdirSync(backupDir())
    .filter((name) => APP_BACKUP_PATTERN.exec(name)?.[1] === id)
    .map((name): AppBackupFile => {
      const stat = fs.statSync(path.join(backupDir(), name));
      return { name, sizeBytes: stat.size, createdAt: stat.mtime.toISOString(), version: versionInName(name), source: "own" };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Keep the newest N of its own files; the zips have their own retention. */
function prune(id: AppId, keep: number): number {
  const stale = ownFiles(id).slice(Math.max(1, keep));
  for (const file of stale) {
    try { fs.unlinkSync(path.join(backupDir(), file.name)); } catch { /* best-effort */ }
  }
  return stale.length;
}

type ManifestApps = Partial<Record<AppId, { included: boolean; bytes?: number; version?: string | null }>>;

// Finding the manifest walks the zip's directory, tens of thousands of entries in a
// full backup, and a finished zip never changes: once per name, size and date.
const manifests = new Map<string, ManifestApps>();

async function manifestApps(name: string, sizeBytes: number, createdAt: string): Promise<ManifestApps> {
  const key = `${name}|${sizeBytes}|${createdAt}`;
  const known = manifests.get(key);
  if (known) return known;
  let apps: ManifestApps = {};
  try {
    const text = await readZipEntryText(path.join(backupDir(), name), isBackupManifestEntry);
    apps = (JSON.parse(text ?? "{}") as { apps?: ManifestApps }).apps ?? {};
  } catch { /* a zip with no readable manifest holds no container's database */ }
  manifests.set(key, apps);
  return apps;
}

/** The copies inside the zips, newest first. A zip still being written is not one. */
async function filesInZips(): Promise<Map<AppId, AppBackupFile[]>> {
  const found = new Map<AppId, AppBackupFile[]>();
  const run = backupRunState();
  for (const zip of listBackupFiles()) {
    if (zip.kind === "database" || (run.startedAt && zip.createdAt >= run.startedAt)) continue;
    const apps = await manifestApps(zip.name, zip.sizeBytes, zip.createdAt);
    for (const app of APPS) {
      const part = apps[app.id];
      if (!part?.included) continue;
      const list = found.get(app.id) ?? [];
      list.push({ name: zip.name, sizeBytes: part.bytes ?? 0, createdAt: zip.createdAt, version: part.version ?? null, source: zip.kind });
      found.set(app.id, list);
    }
  }
  return found;
}

/** Who the container is told is asking: the administrator pressing the button. */
function asAdmin(request: FastifyRequest, secret: string): Record<string, string> {
  return identityHeaders(request.user as User, secret, forwardedFrom(request));
}

async function askUndo(request: FastifyRequest, id: AppId): Promise<Pick<AppBackupView, "restoreSupported" | "undo">> {
  const { upstream, secret } = resolveAppSecret(id);
  if (!appConfigured(appDefinition(id), upstream, secret).enabled) return { restoreSupported: null, undo: null };
  try {
    const response = await fetch(`${upstream}${appDefinition(id).prefix}/api/admin/restore/undo`, {
      headers: asAdmin(request, secret),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    });
    if (response.status === 404) return { restoreSupported: false, undo: null };
    if (!response.ok) return { restoreSupported: null, undo: null };
    return { restoreSupported: true, undo: ((await response.json()) as { undo: AppBackupView["undo"] }).undo };
  } catch {
    return { restoreSupported: null, undo: null };
  }
}

export class AppBackupError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** The bytes of a backup and the version they are from, whichever kind of file it is. */
async function readBackup(id: AppId, name: string): Promise<{ bytes: Buffer; version: string | null; downloadName: string }> {
  const file = path.join(backupDir(), name);
  if (path.dirname(file) !== path.resolve(backupDir())) throw new AppBackupError(404, "Backup not found");
  if (APP_BACKUP_PATTERN.exec(name)?.[1] === id && fs.existsSync(file)) {
    return { bytes: fs.readFileSync(file), version: versionInName(name), downloadName: name };
  }
  if (!NAME_PATTERN.test(name) || !name.endsWith(".zip") || !fs.existsSync(file)) throw new AppBackupError(404, "Backup not found");
  const entry = `apps/${id}.sqlite`;
  const tmp = path.join(backupDir(), `.tmp-app-restore-${id}-${Date.now()}.sqlite`);
  try {
    const got = await extractFromZip(file, (entryName) => (entryName === entry || entryName.endsWith(`/${entry}`) ? tmp : null));
    if (got === 0) throw new AppBackupError(404, "That backup does not hold this container's database.");
    const stat = fs.statSync(file);
    const version = safeVersion((await manifestApps(name, stat.size, stat.mtime.toISOString()))[id]?.version ?? null);
    const at = /^isputnik-([0-9]{8}-[0-9]{6})/.exec(name)?.[1] ?? stamp(stat.mtime);
    return { bytes: fs.readFileSync(tmp), version, downloadName: `isputnik-${id}-${at}${version ? `-v${version}` : ""}.sqlite` };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** A restore or an undo, on the container; its refusal is the admin's to read. */
async function callRestore(
  request: FastifyRequest,
  id: AppId,
  route: "restore" | "restore/undo",
  body?: { bytes: Buffer; version: string | null }
): Promise<void> {
  const definition = appDefinition(id);
  const { upstream, secret } = resolveAppSecret(id);
  if (!appConfigured(definition, upstream, secret).enabled) throw new AppBackupError(409, "This container is not set up on Settings › Apps.");
  let response: Response;
  try {
    response = await fetch(`${upstream}${definition.prefix}/api/admin/${route}`, {
      method: "POST",
      headers: {
        ...asAdmin(request, secret),
        ...(body ? { "content-type": "application/vnd.sqlite3", ...(body.version ? { "x-isputnik-backup-version": body.version } : {}) } : {})
      },
      ...(body ? { body: new Uint8Array(body.bytes) } : {}),
      signal: AbortSignal.timeout(RESTORE_TIMEOUT_MS)
    });
  } catch (err) {
    throw new AppBackupError(502, `The container did not answer (${err instanceof Error ? err.message : String(err)}).`);
  }
  if (response.ok) return;
  if (response.status === 404 && route === "restore") throw new AppBackupError(409, "This container is too old to restore a backup. Update it first.");
  if (response.status === 401) throw new AppBackupError(502, "The container refused this server's secret.");
  const said = await response.json().then((answer: { error?: unknown }) => answer.error, () => null);
  throw new AppBackupError(response.status >= 500 ? 502 : response.status, typeof said === "string" ? said : `The container answered ${response.status}.`);
}

/** The container's own module has its say. A failure is not the restore's. */
async function afterRestore(id: AppId): Promise<void> {
  try {
    await runAfterRestore(id);
  } catch (err) {
    log.warn({ err }, `Could not tell ${id} about the restore`);
  }
}

const settingsSchema = z.object({
  include: z.boolean().optional(),
  keep: z.number().int().min(1).max(APP_KEEP_MAX).optional()
}).refine((body) => body.include !== undefined || body.keep !== undefined, { message: "Nothing to change." });

export function registerAppBackupRoutes(app: FastifyInstance): void {
  // One thing at a time per container: a restore must not land while a backup of
  // the same database is being stored, and a second press is told no, not queued.
  const busy = new Set<AppId>();
  const once = async <T>(id: AppId, run: () => Promise<T>): Promise<T> => {
    if (busy.has(id)) throw new AppBackupError(409, "This container's backup or restore is already running.");
    busy.add(id);
    try {
      return await run();
    } finally {
      busy.delete(id);
    }
  };

  const appIdOf = (request: FastifyRequest): AppId => {
    const id = (request.params as { id: string }).id;
    if (!isAppId(id)) throw new AppBackupError(404, "No such container");
    return id;
  };
  const nameOf = (request: FastifyRequest) => (request.params as { name: string }).name;

  // Its own scope, so only these routes turn this error into their answer.
  void app.register(async (scope) => {
    scope.setErrorHandler((error, _request, reply) => {
      if (error instanceof AppBackupError) return reply.code(error.status).send({ error: error.message });
      throw error;
    });

    scope.get("/api/backups/apps", { preHandler: app.requireAdmin }, async (request) => {
      const zipped = await filesInZips();
      const apps = await Promise.all(APPS.map(async (definition): Promise<AppBackupView> => {
        const { upstream, secret } = resolveAppSecret(definition.id);
        const configured = appConfigured(definition, upstream, secret);
        const files = [...ownFiles(definition.id), ...(zipped.get(definition.id) ?? [])]
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return {
          id: definition.id,
          configured: configured.enabled,
          problem: configured.reason ?? null,
          ...appBackupSettings(definition.id),
          files,
          ...(await askUndo(request, definition.id))
        };
      }));
      return { apps };
    });

    scope.post("/api/backups/apps/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
      const id = appIdOf(request);
      const definition = appDefinition(id);
      const { upstream, secret } = resolveAppSecret(id);
      if (!appConfigured(definition, upstream, secret).enabled) throw new AppBackupError(409, "This container is not set up on Settings › Apps.");
      ensureBackupDir();
      const backup = await once(id, async () => {
        const snapshot = await snapshotApp(id, backupDir(), request.user!.id);
        if (!snapshot.included) throw new AppBackupError(502, `Could not back it up: ${snapshot.reason}.`);
        const name = uniqueName(id, safeVersion(snapshot.version));
        fs.renameSync(snapshot.file, path.join(backupDir(), name));
        const pruned = prune(id, appBackupSettings(id).keep);
        logActivity({
          event: "backup.app_created",
          actorUserId: request.user!.id,
          targetType: "backup",
          targetId: name,
          detail: `Backed up ${id} on its own: "${name}" (${snapshot.bytes} bytes)${pruned > 0 ? `, pruned ${pruned} old` : ""}.`,
          ipAddress: request.ip
        });
        return { name, sizeBytes: snapshot.bytes, version: snapshot.version };
      });
      return reply.code(201).send({ backup });
    });

    scope.patch("/api/backups/apps/:id/settings", { preHandler: app.requireAdmin }, async (request, reply) => {
      const id = appIdOf(request);
      const parsed = parseBody(settingsSchema, request.body);
      if (parsed.error) return reply.code(400).send({ error: "Invalid backup settings", details: parsed.error });
      const next = { ...appBackupSettings(id), ...parsed.data };
      saveAppBackupSettings(id, next, request.user!.id);
      logActivity({
        event: "backup.settings_updated",
        actorUserId: request.user!.id,
        targetType: "setting",
        targetId: `backup_apps.${id}`,
        detail: `${id}: ${next.include ? "taken along by" : "left out of"} full and minimal backups; keeps the newest ${next.keep} of its own.`,
        ipAddress: request.ip
      });
      return { settings: next };
    });

    // A file downloaded here before, or from another install of this app. Kept whole
    // and checked for being SQLite only: which app's it is, and whether it can go in,
    // is the container's to say when it is restored.
    scope.post("/api/backups/apps/:id/upload", { preHandler: app.requireAdmin }, async (request, reply) => {
      const id = appIdOf(request);
      ensureBackupDir();
      let received;
      try {
        received = await receiveUpload(request, { accept: ["sqlite"], maxBytes: APP_BACKUP_MAX_BYTES }, backupDir());
      } catch (err) {
        const status = err instanceof UploadError ? err.statusCode : 400;
        return reply.code(status).send({ error: err instanceof Error ? err.message : "Upload failed" });
      }
      const refuse = (message: string) => {
        fs.rmSync(received.tmpPath, { force: true });
        return reply.code(400).send({ error: message });
      };
      const head = Buffer.alloc(SQLITE_MAGIC.length);
      const handle = fs.openSync(received.tmpPath, "r");
      try { fs.readSync(handle, head, 0, head.length, 0); } finally { fs.closeSync(handle); }
      if (!head.equals(SQLITE_MAGIC)) return refuse("That file is not a database.");
      const namedFor = /^isputnik-([a-z]+)-[0-9]{8}-[0-9]{6}/.exec(received.filename)?.[1];
      if (namedFor && isAppId(namedFor) && namedFor !== id) return refuse(`That file is a backup of ${namedFor}.`);

      const name = uniqueName(id, safeVersion(versionInName(received.filename)));
      fs.renameSync(received.tmpPath, path.join(backupDir(), name));
      const pruned = prune(id, appBackupSettings(id).keep);
      const sizeBytes = fs.statSync(path.join(backupDir(), name)).size;
      logActivity({
        event: "backup.app_uploaded",
        actorUserId: request.user!.id,
        targetType: "backup",
        targetId: name,
        detail: `Uploaded a backup of ${id}: "${name}" (${sizeBytes} bytes) from "${received.filename}"${pruned > 0 ? `, pruned ${pruned} old` : ""}.`,
        ipAddress: request.ip
      });
      return reply.code(201).send({ backup: { name, sizeBytes } });
    });

    scope.get("/api/backups/apps/:id/files/:name/download", { preHandler: app.requireAdmin }, async (request, reply) => {
      const id = appIdOf(request);
      const { bytes, downloadName } = await readBackup(id, nameOf(request));
      logActivity({
        event: "backup.app_downloaded",
        actorUserId: request.user!.id,
        targetType: "backup",
        targetId: nameOf(request),
        detail: `Downloaded the ${id} database as "${downloadName}".`,
        ipAddress: request.ip
      });
      return reply
        .type("application/vnd.sqlite3")
        .header("Content-Disposition", `attachment; filename="${downloadName}"`)
        .header("Cache-Control", "private, no-cache")
        .send(bytes);
    });

    // Only its own files: a zip's copy goes when the zip does.
    scope.delete("/api/backups/apps/:id/files/:name", { preHandler: app.requireAdmin }, async (request) => {
      const id = appIdOf(request);
      const name = nameOf(request);
      if (APP_BACKUP_PATTERN.exec(name)?.[1] !== id || !fs.existsSync(path.join(backupDir(), name))) {
        throw new AppBackupError(404, "Backup not found");
      }
      fs.unlinkSync(path.join(backupDir(), name));
      logActivity({
        event: "backup.app_deleted",
        actorUserId: request.user!.id,
        targetType: "backup",
        targetId: name,
        detail: `Deleted the backup of ${id} "${name}".`,
        ipAddress: request.ip
      });
      return { deleted: true };
    });

    // destructive: restoring replaces the container's database — refused from
    // untrusted networks under the deletions-only policy (see deletionBlocked).
    scope.post("/api/backups/apps/:id/files/:name/restore", { preHandler: app.requireAdmin, config: { destructive: true } }, async (request) => {
      const id = appIdOf(request);
      const name = nameOf(request);
      await once(id, async () => {
        const backup = await readBackup(id, name);
        await callRestore(request, id, "restore", backup);
        logActivity({
          event: "backup.app_restored",
          actorUserId: request.user!.id,
          targetType: "backup",
          targetId: name,
          detail: `Restored ${id} from "${name}"${backup.version ? ` (version ${backup.version})` : ""}.`,
          ipAddress: request.ip
        });
        await afterRestore(id);
      });
      return { restored: true };
    });

    scope.post("/api/backups/apps/:id/undo", { preHandler: app.requireAdmin, config: { destructive: true } }, async (request) => {
      const id = appIdOf(request);
      await once(id, async () => {
        await callRestore(request, id, "restore/undo");
        logActivity({
          event: "backup.app_restore_undone",
          actorUserId: request.user!.id,
          targetType: "backup",
          targetId: id,
          detail: `Undid the last restore of ${id}: the database it replaced is back.`,
          ipAddress: request.ip
        });
        await afterRestore(id);
      });
      return { undone: true };
    });
  });
}
