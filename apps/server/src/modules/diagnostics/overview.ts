// The Diagnostics page's cards (docs/diagnostics-pages-plan.md): one per part of
// iSputnik — this server, then each container — with how it is and what, if
// anything, needs attention. Asked when the page opens, never in the background.
// The folder checks are async and short: a sleeping disk makes its library "slow
// to answer", it doesn't hold the page.
import fs from "node:fs";
import path from "node:path";
import type { FastifyRequest } from "fastify";
import { db } from "../../db.js";
import { config } from "../../config.js";
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
}

/** A folder that hasn't answered by then is reported slow, not missing. */
const FOLDER_TIMEOUT_MS = 3000;
/** No backup for longer than this needs a look. */
const BACKUP_DAYS = 7;

async function folderState(folder: string): Promise<"ok" | "missing" | "slow"> {
  let timer: NodeJS.Timeout | undefined;
  const slow = new Promise<"slow">((resolve) => { timer = setTimeout(() => resolve("slow"), FOLDER_TIMEOUT_MS); });
  const look = fs.promises.stat(folder).then((stat) => (stat.isDirectory() ? "ok" as const : "missing" as const), () => "missing" as const);
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
  const folders = await Promise.all(rows.map((row) => (ours(row) ? folderState(row.source_path) : Promise.resolve("ok" as const))));
  rows.forEach((row, at) => {
    const library = { library: row.name, libraryId: row.id };
    if (folders[at] === "missing") problems.push({ kind: "folderMissing", ...library });
    else if (folders[at] === "slow") problems.push({ kind: "folderSlow", ...library });
    else if (row.scan_status === "error") problems.push({ kind: "scanFailed", ...library });
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
    uptimeSeconds: Math.floor(process.uptime())
  };
}

export async function containerOverviews(request: FastifyRequest, settings: AppSettings): Promise<PartOverview[]> {
  return Promise.all(APPS.map(async (definition): Promise<PartOverview> => {
    const { upstream, secret, source, urlSource } = settings(definition.id);
    const status = await appStatus(definition, upstream, secret, request, source, urlSource);
    const base = { id: definition.id, version: status.server?.version ?? null, roundTripMs: status.server?.roundTripMs ?? null };
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
