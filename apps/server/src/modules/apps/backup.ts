// The containers' databases in this server's backups (docs/apps-platform-plan.md →
// Backups). Metadata and databases only: each container hands over a snapshot of
// its SQLite database on GET <prefix>/api/admin/backup, and a full or minimal
// backup stores it as apps/<id>.sqlite. A container that does not answer is left
// out and named — the backup itself never fails on its account.
import fs from "node:fs";
import path from "node:path";
import { db, type User } from "../../db.js";
import { identityHeaders } from "./gateway.js";
import { resolveAppSecret } from "./pairing.js";
import { APPS, appConfigured, appDefinition, type AppDefinition, type AppId } from "./registry.js";

/** Long enough for a large catalog's database over the Docker network; short
 *  enough that a hung container cannot hold a nightly backup for long. */
const FETCH_TIMEOUT_MS = 60_000;
/** Nothing a container keeps as metadata comes near this; a bigger answer is a
 *  misbehaving container, not a database to put in every backup. */
export const APP_BACKUP_MAX_BYTES = 512 * 1024 * 1024;
const MAX_BYTES = APP_BACKUP_MAX_BYTES;
/** SQLite's file header, so an error page is never stored as a database. */
export const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "latin1");

/** Who asks, when nobody does: a scheduled backup. The container sees the admin
 *  role it needs and a name its own log makes sense of. */
const SCHEDULED_ACTOR = {
  id: "system:backup",
  display_name: "Scheduled backup",
  role: "admin",
  language: "en",
  theme: "system"
} as unknown as User;

export type AppSnapshot =
  | { id: AppId; included: true; file: string; bytes: number; version: string | null }
  | { id: AppId; included: false; reason: string };

/** Override for tests: where each container is, and its secret. */
export type SnapshotSettings = (id: AppId) => { upstream: string; secret: string };

/** Per container, on the Backup page: whether Full and Minimal take it along, and
 *  how many of its own backups to keep (modules/backups/app-backups.ts). */
export interface AppBackupSettings {
  include: boolean;
  keep: number;
}

const APP_SETTINGS_KEY = "backup_apps";
export const APP_KEEP_MAX = 100;
const APP_KEEP_DEFAULT = 10;

export function appBackupSettings(id: AppId): AppBackupSettings {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(APP_SETTINGS_KEY) as { value: string } | undefined;
  let stored: Partial<AppBackupSettings> = {};
  try {
    stored = (JSON.parse(row?.value ?? "{}") as Partial<Record<AppId, Partial<AppBackupSettings>>>)[id] ?? {};
  } catch { /* an unreadable blob reads as the defaults */ }
  const keep = Math.floor(Number(stored.keep));
  return {
    include: stored.include !== false,
    keep: Number.isFinite(keep) && keep >= 1 ? Math.min(APP_KEEP_MAX, keep) : APP_KEEP_DEFAULT
  };
}

export function saveAppBackupSettings(id: AppId, next: AppBackupSettings, userId: string): void {
  const all = Object.fromEntries(APPS.map((app) => [app.id, appBackupSettings(app.id)]));
  all[id] = next;
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_by, updated_at)
    VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `).run(APP_SETTINGS_KEY, JSON.stringify(all), userId);
}

// What a container's own module wants done after its database has gone back: the
// video engine's library list is Home's, and a restored catalog may be missing one
// made since. Told, not asked: a failure here is logged and the restore stands.
const afterRestore = new Map<AppId, () => Promise<void>>();

export function onAppRestored(id: AppId, run: () => Promise<void>): void {
  afterRestore.set(id, run);
}

export async function runAfterRestore(id: AppId): Promise<void> {
  await afterRestore.get(id)?.();
}

async function snapshotOne(
  app: AppDefinition,
  dir: string,
  actor: User,
  settings: SnapshotSettings
): Promise<AppSnapshot> {
  const { upstream, secret } = settings(app.id);
  const configured = appConfigured(app, upstream, secret);
  if (!configured.enabled) return { id: app.id, included: false, reason: configured.reason ?? "not set up" };
  try {
    const response = await fetch(`${upstream}${app.prefix}/api/admin/backup`, {
      headers: identityHeaders(actor, secret, { ip: "127.0.0.1", requestId: `backup-${Date.now()}` }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (response.status === 404) return { id: app.id, included: false, reason: "the container is too old to hand over its database" };
    if (response.status === 401) return { id: app.id, included: false, reason: "the container refused this server's secret" };
    if (!response.ok) return { id: app.id, included: false, reason: `the container answered ${response.status}` };
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > MAX_BYTES) return { id: app.id, included: false, reason: "its database is larger than a backup takes" };
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > MAX_BYTES) return { id: app.id, included: false, reason: "its database is larger than a backup takes" };
    if (body.length < SQLITE_MAGIC.length || !body.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC)) {
      return { id: app.id, included: false, reason: "the container's answer was not a database" };
    }
    const file = path.join(dir, `.tmp-app-${app.id}-${Date.now()}.sqlite`);
    fs.writeFileSync(file, body);
    return { id: app.id, included: true, file, bytes: body.length, version: response.headers.get("x-isputnik-backup-version") };
  } catch (err) {
    return { id: app.id, included: false, reason: `the container did not answer (${err instanceof Error ? err.message : String(err)})` };
  }
}

/** A snapshot of every container this release knows, in turn (one at a time: a
 *  backup is not in a hurry, and the containers share the host's disk). The
 *  caller puts the files in the zip and removes them afterwards. */
export async function snapshotApps(
  dir: string,
  actorUserId: string | null,
  settings: SnapshotSettings = (id) => resolveAppSecret(id)
): Promise<AppSnapshot[]> {
  const actor = backupActor(actorUserId);
  const snapshots: AppSnapshot[] = [];
  for (const app of APPS) {
    // A container with no address is not installed: nothing to say about it. One
    // switched out of Full and Minimal on the Backup page was left out on purpose.
    if (!settings(app.id).upstream || !appBackupSettings(app.id).include) continue;
    snapshots.push(await snapshotOne(app, dir, actor, settings));
  }
  return snapshots;
}

/** The admin who started it, as the container's log should name them; else
 *  (scheduled, or an account since gone) the scheduled-backup identity. */
function backupActor(actorUserId: string | null): User {
  const person = actorUserId
    ? db.prepare("SELECT id, display_name, role, language, theme FROM users WHERE id = ? AND deleted_at IS NULL").get(actorUserId) as User | undefined
    : undefined;
  return person && person.role === "admin" ? person : SCHEDULED_ACTOR;
}

/** One container's snapshot on its own: Back up now on its card. */
export function snapshotApp(id: AppId, dir: string, actorUserId: string | null): Promise<AppSnapshot> {
  return snapshotOne(appDefinition(id), dir, backupActor(actorUserId), (app) => resolveAppSecret(app));
}

/** The fragment the activity log line adds: what went in, what was missing. */
export function snapshotNote(snapshots: AppSnapshot[]): string {
  const included = snapshots.filter((snap) => snap.included).map((snap) => snap.id);
  const missing = snapshots.filter((snap): snap is Extract<AppSnapshot, { included: false }> => !snap.included && snap.reason !== "not set up");
  const parts: string[] = [];
  if (included.length > 0) parts.push(`with the ${included.join(", ")} database${included.length === 1 ? "" : "s"}`);
  for (const snap of missing) parts.push(`without ${snap.id}: ${snap.reason}`);
  return parts.length > 0 ? `, ${parts.join("; ")}` : "";
}
