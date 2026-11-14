// The Diagnostics page's cards (docs/diagnostics-pages-plan.md): one per part of
// iSputnik — this server, then each container — with how it is and what, if
// anything, needs attention. Asked when the page opens, never in the background.
// The folder checks are async and short: a sleeping disk makes its library "slow
// to answer", it doesn't hold the page.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyRequest } from "fastify";
import { db } from "../../db.js";
import { config } from "../../config.js";
import { callsToday, type CallCount } from "../apps/calls.js";
import { appStatus } from "../apps/status.js";
import { APPS, type AppId } from "../apps/registry.js";
import { backupRunState, isPreUpgradeCopy, listBackupFiles } from "../backups/run.js";
import type { AppSettings } from "./report.js";

export type PartId = "home" | AppId;
/** ok: nothing to see · attention: something needs a look · down: doesn't answer · off: not set up. */
export type PartState = "ok" | "attention" | "down" | "off";

export type PartProblem =
  | { kind: "folderMissing" | "folderSlow" | "scanFailed"; library: string; libraryId: string }
  | { kind: "noBackup" }
  | { kind: "backupOld"; days: number }
  | { kind: "backupFailed"; error: string }
  | { kind: "notAnswering"; error: string | null }
  | { kind: "secretRefused" };

export interface PartOverview {
  id: PartId;
  state: PartState;
  version: string | null;
  /** How long its health check took from here; this server's own is null. */
  roundTripMs: number | null;
  problems: PartProblem[];
  /** This server: how many libraries, and the newest backup. */
  libraries?: number;
  lastBackupAt?: string | null;
  uptimeSeconds?: number;
  /** This server: each library and how its folder answered. */
  libraryChecks?: LibraryCheck[];
  /** This server: the newest backup, and the last run's error. */
  lastBackup?: { at: string; kind: string; sizeBytes: number } | null;
  backupError?: string | null;
  /** This server: what it runs on. */
  machine?: { node: string; os: string; cpus: number; memoryBytes: number; rssBytes: number };
  /** A container: the gateway's requests to it today (calls.ts). */
  calls?: CallCount;
}

export interface LibraryCheck {
  id: string;
  name: string;
  type: string;
  /** ok · missing · slow · scanFailed · container: a video library, its folder the container's. */
  state: "ok" | "missing" | "slow" | "scanFailed" | "container";
  /** How long the folder took to answer, in ms; null when not asked or it didn't answer. */
  ms: number | null;
}

/** A folder that hasn't answered by then is reported slow, not missing. */
const FOLDER_TIMEOUT_MS = 3000;
/** No backup for longer than this needs a look. */
const BACKUP_DAYS = 7;

async function folderState(folder: string): Promise<{ state: "ok" | "missing" | "slow"; ms: number | null }> {
  let timer: NodeJS.Timeout | undefined;
  const started = performance.now();
  const slow = new Promise<{ state: "slow"; ms: null }>((resolve) => { timer = setTimeout(() => resolve({ state: "slow", ms: null }), FOLDER_TIMEOUT_MS); });
  const look = fs.promises.stat(folder).then(
    (stat) => ({ state: stat.isDirectory() ? "ok" as const : "missing" as const, ms: Math.round(performance.now() - started) }),
    () => ({ state: "missing" as const, ms: null })
  );
  try {
    return await Promise.race([look, slow]);
  } finally {
    clearTimeout(timer);
  }
}

export async function homeOverview(): Promise<PartOverview> {
  const rows = db.prepare("SELECT id, name, type, source_path, scan_status FROM libraries ORDER BY name").all() as { id: string; name: string; type: string; source_path: string; scan_status: string }[];
  const problems: PartProblem[] = [];
  // A video library's folder is the video container's, relative to its media root:
  // this server can't see it, and the container checks its own disks.
  const ours = (row: (typeof rows)[number]) => row.type !== "video" && path.isAbsolute(row.source_path);
  const folders = await Promise.all(rows.map((row) => (ours(row) ? folderState(row.source_path) : Promise.resolve(null))));
  const libraryChecks: LibraryCheck[] = rows.map((row, at) => {
    const folder = folders[at];
    const library = { library: row.name, libraryId: row.id };
    const base = { id: row.id, name: row.name, type: row.type, ms: folder?.ms ?? null };
    if (folder?.state === "missing") { problems.push({ kind: "folderMissing", ...library }); return { ...base, state: "missing" }; }
    if (folder?.state === "slow") { problems.push({ kind: "folderSlow", ...library }); return { ...base, state: "slow" }; }
    if (row.scan_status === "error") { problems.push({ kind: "scanFailed", ...library }); return { ...base, state: "scanFailed" }; }
    return { ...base, state: folder ? "ok" : "container" };
  });

  const backups = listBackupFiles().filter((file) => !isPreUpgradeCopy(file.name));
  const lastBackupAt = backups[0]?.createdAt ?? null;
  const { lastError } = backupRunState();
  if (lastError) problems.push({ kind: "backupFailed", error: lastError });
  if (!lastBackupAt) problems.push({ kind: "noBackup" });
  else {
    const days = Math.floor((Date.now() - Date.parse(lastBackupAt)) / 86400_000);
    if (days > BACKUP_DAYS) problems.push({ kind: "backupOld", days });
  }

  return {
    id: "home",
    state: problems.length ? "attention" : "ok",
    version: config.version,
    roundTripMs: null,
    problems,
    libraries: rows.length,
    lastBackupAt,
    uptimeSeconds: Math.floor(process.uptime()),
    libraryChecks,
    lastBackup: backups[0] ? { at: backups[0].createdAt, kind: backups[0].kind, sizeBytes: backups[0].sizeBytes } : null,
    backupError: lastError,
    machine: { node: process.version, os: `${process.platform} ${os.release()} ${process.arch}`, cpus: os.cpus().length, memoryBytes: os.totalmem(), rssBytes: process.memoryUsage().rss }
  };
}

export async function containerOverviews(request: FastifyRequest, settings: AppSettings): Promise<PartOverview[]> {
  return Promise.all(APPS.map(async (definition): Promise<PartOverview> => {
    const { upstream, secret, source, urlSource } = settings(definition.id);
    const status = await appStatus(definition, upstream, secret, request, source, urlSource);
    const base = { id: definition.id, version: status.server?.version ?? null, roundTripMs: status.server?.roundTripMs ?? null, calls: callsToday(definition.id) };
    if (!status.configured) return { ...base, state: "off", problems: [] };
    if (!status.server?.ok) return { ...base, state: "down", problems: [{ kind: "notAnswering", error: status.server?.error ?? null }] };
    if (status.secretAccepted === false) return { ...base, state: "attention", problems: [{ kind: "secretRefused" }] };
    return { ...base, state: "ok", problems: [] };
  }));
}

export async function overview(request: FastifyRequest, settings: AppSettings): Promise<PartOverview[]> {
  const [home, containers] = await Promise.all([homeOverview(), containerOverviews(request, settings)]);
  return [home, ...containers];
}
