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
import { APPS, appConfigured, type AppDefinition, type AppId } from "./registry.js";

/** Long enough for a large catalog's database over the Docker network; short
 *  enough that a hung container cannot hold a nightly backup for long. */
const FETCH_TIMEOUT_MS = 60_000;
/** Nothing a container keeps as metadata comes near this; a bigger answer is a
 *  misbehaving container, not a database to put in every backup. */
const MAX_BYTES = 512 * 1024 * 1024;
/** SQLite's file header, so an error page is never stored as a database. */
const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "latin1");

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
  // The admin who started it, as the container's log should name them; else
  // (scheduled, or an account since gone) the scheduled-backup identity.
  const person = actorUserId
    ? db.prepare("SELECT id, display_name, role, language, theme FROM users WHERE id = ? AND deleted_at IS NULL").get(actorUserId) as User | undefined
    : undefined;
  const actor = person && person.role === "admin" ? person : SCHEDULED_ACTOR;
  const snapshots: AppSnapshot[] = [];
  for (const app of APPS) snapshots.push(await snapshotOne(app, dir, actor, settings));
  return snapshots;
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
