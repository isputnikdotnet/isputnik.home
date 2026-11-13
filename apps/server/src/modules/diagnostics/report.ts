// The diagnostics report (Control panel › Infrastructure › Diagnostics): what a bug
// report needs to be answered, as plain text an admin copies into a GitHub issue.
// Sections, each one the admin can leave out: this server and its machine, the
// containers beside it, the libraries, the failures in the activity log, and one
// for every container that answers GET <prefix>/api/admin/diagnostics with its own
// facts (the video engine: ffmpeg, the GPU check, conversion, its log's problems).
//
// The report is made here and shown whole before anything is copied; nothing is
// ever sent anywhere by the server. Names and paths are hidden (redact.ts) unless
// the admin asks to include them.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyRequest } from "fastify";
import { db } from "../../db.js";
import { config } from "../../config.js";
import { identityHeaders } from "../apps/gateway.js";
import { appStatus, type AppStatus } from "../apps/status.js";
import { APPS, appConfigured, type AppDefinition, type AppId } from "../apps/registry.js";
import { keepEverything, makeRedactor, type Redactor } from "./redact.js";

export type SectionKey = "system" | "containers" | "libraries" | "failures" | `container:${AppId}`;

export interface ReportSection {
  key: SectionKey;
  /** Its heading in the report: English, as the issue tracker is. */
  title: string;
  lines: string[];
}

export interface DiagnosticsReport {
  generatedAt: string;
  /** Names, paths and addresses included as they are. */
  includesPrivate: boolean;
  sections: ReportSection[];
}

export type AppSettings = (id: AppId) => { upstream: string; secret: string; source: AppStatus["secretSource"]; urlSource: AppStatus["urlSource"] };

/** How long a container gets to answer; the page waits for the slowest. */
const CONTAINER_TIMEOUT_MS = 5000;
/** How far back, and how many, of the activity log's failures. */
const FAILURE_DAYS = 14;
const FAILURE_ROWS = 40;

const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;
const gb = (bytes: number) => `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
const duration = (seconds: number) => {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return days > 0 ? `${days} d ${hours} h` : hours > 0 ? `${hours} h ${minutes} min` : `${minutes} min`;
};

function insideDocker(): boolean {
  try {
    return fs.existsSync("/.dockerenv") || /docker|containerd|kubepods/.test(fs.readFileSync("/proc/1/cgroup", "utf8"));
  } catch {
    return false;
  }
}

function dataDisk(): string {
  try {
    const stats = fs.statfsSync(path.dirname(config.dbPath));
    return `${gb(Number(stats.bavail) * Number(stats.bsize))} free of ${gb(Number(stats.blocks) * Number(stats.bsize))}`;
  } catch {
    return "unknown";
  }
}

function systemSection(): ReportSection {
  const cpus = os.cpus();
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  let dbBytes = 0;
  for (const file of [config.dbPath, `${config.dbPath}-wal`]) {
    try { dbBytes += fs.statSync(file).size; } catch { /* not there */ }
  }
  return {
    key: "system",
    title: "isputnik.home",
    lines: [
      `version: ${config.version}${config.stage ? ` (${config.stage})` : ""}`,
      `node: ${process.version}`,
      `os: ${process.platform} ${os.release()} ${process.arch}${insideDocker() ? ", in a container" : ""}`,
      `cpu: ${cpus.length} × ${cpus[0]?.model?.trim() ?? "unknown"}`,
      `memory: ${gb(os.totalmem())} total, ${gb(os.freemem())} free; this server uses ${mb(process.memoryUsage().rss)}`,
      `uptime: ${duration(process.uptime())}`,
      `timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
      `data disk: ${dataDisk()}; database ${mb(dbBytes)}`,
      `address: ${config.appUrl.startsWith("https:") ? "https" : "http"}, ${process.env.TRUST_PROXY?.trim() ? "behind a proxy (TRUST_PROXY set)" : "no TRUST_PROXY"}`,
      `accounts: ${count("SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL")}; libraries: ${count("SELECT COUNT(*) AS n FROM libraries")}`
    ]
  };
}

function containersSection(statuses: AppStatus[]): ReportSection {
  return {
    key: "containers",
    title: "Containers",
    lines: statuses.map((status) => {
      if (!status.configured) return `${status.id}: not set up${status.reason ? ` (${status.reason})` : ""}`;
      const server = status.server;
      const answer = server?.ok ? `answers, version ${server.version ?? "?"}, ${server.roundTripMs ?? "?"} ms` : `does not answer (${server?.error ?? "unknown"})`;
      const signature = status.secretAccepted === false ? "; refuses this server's secret" : status.secretAccepted === null && server?.ok ? "; secret not checked" : "";
      return `${status.id}: ${answer}${signature}; address from ${status.urlSource}, secret from ${status.secretSource}; at ${status.url ?? "?"}`;
    })
  };
}

interface LibraryRow {
  name: string;
  type: string;
  source_path: string;
  scan_status: string;
  last_scanned_at: string | null;
  role: string | null;
}

function librariesSection(rows: LibraryRow[]): ReportSection {
  return {
    key: "libraries",
    title: "Libraries",
    lines: rows.length === 0 ? ["none"] : rows.map((row) =>
      `${row.type}${row.role ? ` (${row.role})` : ""}: "${row.name}" at ${row.source_path}; ${row.scan_status}, last scanned ${row.last_scanned_at ?? "never"}`)
  };
}

function failuresSection(): ReportSection {
  const since = new Date(Date.now() - FAILURE_DAYS * 86400_000).toISOString();
  const rows = db.prepare(`
    SELECT event, detail, created_at FROM activity_logs
    WHERE created_at >= ? AND (event LIKE '%fail%' OR event LIKE '%error%' OR event LIKE '%refused%' OR event LIKE '%timeout%')
    ORDER BY created_at DESC LIMIT ?
  `).all(since, FAILURE_ROWS) as { event: string; detail: string; created_at: string }[];
  return {
    key: "failures",
    title: `Failures in the activity log (last ${FAILURE_DAYS} days)`,
    lines: rows.length === 0 ? ["none"] : rows.reverse().map((row) => `${row.created_at.slice(0, 19).replace("T", " ")} ${row.event}: ${row.detail}`)
  };
}

/** A container's own facts, as nested key: value lines. */
function factLines(value: unknown, indent = ""): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${indent}(none)`];
    return value.flatMap((entry) => {
      if (typeof entry === "string") return [`${indent}- ${logLine(entry)}`];
      if (entry === null || typeof entry !== "object") return [`${indent}- ${String(entry)}`];
      const [first, ...rest] = factLines(entry, `${indent}  `);
      return first === undefined ? [] : [`${indent}- ${first.trimStart()}`, ...rest];
    });
  }
  if (typeof value !== "object") return [`${indent}${String(value)}`];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => {
    if (entry === null || entry === undefined || entry === "") return [`${indent}${key}: -`];
    if (typeof entry === "object") {
      const inner = factLines(entry, `${indent}  `);
      // A short list of words on one line ("decode: h264, hevc10"); lines of a log, or anything long, one a line.
      const short = Array.isArray(entry) && entry.length > 0 && entry.every((item) => typeof item !== "object" && String(item).length <= 40 && !String(item).startsWith("{"));
      return short ? [`${indent}${key}: ${entry.join(", ")}`] : [`${indent}${key}:`, ...inner];
    }
    return [`${indent}${key}: ${String(entry)}`];
  });
}

const LEVELS: Record<number, string> = { 10: "TRACE", 20: "DEBUG", 30: "INFO", 40: "WARN", 50: "ERROR", 60: "FATAL" };
/** Fields of a log line that say nothing about the problem. */
const NOISE = new Set(["level", "time", "msg", "pid", "hostname", "v"]);

/** A pino JSON line as one readable line; anything else as it is. */
function logLine(text: string): string {
  try {
    const entry = JSON.parse(text) as Record<string, unknown>;
    if (typeof entry.msg !== "string") return text;
    const at = typeof entry.time === "number" ? new Date(entry.time).toISOString().slice(0, 19).replace("T", " ") : "";
    const rest = Object.entries(entry).filter(([key]) => !NOISE.has(key)).map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
    return `${at} ${LEVELS[Number(entry.level)] ?? entry.level} ${entry.msg}${rest.length ? ` ${rest.join(" ")}` : ""}`.trim();
  } catch {
    return text;
  }
}

interface ContainerFacts {
  app: AppDefinition;
  /** null: it has nothing to say (too old, not set up, did not answer) — `note` says why. */
  facts: Record<string, unknown> | null;
  note: string | null;
}

async function askContainer(app: AppDefinition, settings: AppSettings, request: FastifyRequest): Promise<ContainerFacts> {
  const { upstream, secret } = settings(app.id);
  if (!appConfigured(app, upstream, secret).enabled) return { app, facts: null, note: "not set up" };
  try {
    const response = await fetch(`${upstream}${app.prefix}/api/admin/diagnostics`, {
      headers: identityHeaders(request.user!, secret, { ip: "127.0.0.1", requestId: `diagnostics-${Date.now()}` }),
      signal: AbortSignal.timeout(CONTAINER_TIMEOUT_MS)
    });
    if (response.status === 404) return { app, facts: null, note: "this version has no diagnostics of its own" };
    if (!response.ok) return { app, facts: null, note: `answered ${response.status}` };
    return { app, facts: (await response.json()) as Record<string, unknown>, note: null };
  } catch (err) {
    return { app, facts: null, note: `did not answer (${err instanceof Error ? err.message : String(err)})` };
  }
}

/** What a container named that the household would recognise: its libraries' names and folders, its paths. */
function privateOf(facts: Record<string, unknown> | null): { names: string[]; paths: string[] } {
  const names: string[] = [];
  const paths: string[] = [];
  const libraries = Array.isArray(facts?.libraries) ? (facts!.libraries as Record<string, unknown>[]) : [];
  for (const library of libraries) {
    if (typeof library.name === "string") names.push(library.name);
    if (typeof library.folder === "string") paths.push(library.folder);
  }
  const reported = facts?.paths && typeof facts.paths === "object" ? Object.values(facts.paths as Record<string, unknown>) : [];
  for (const value of reported) if (typeof value === "string" && value !== ":memory:") paths.push(value, path.dirname(value));
  return { names, paths };
}

export async function buildReport(request: FastifyRequest, settings: AppSettings, includePrivate: boolean): Promise<DiagnosticsReport> {
  const [statuses, containers] = await Promise.all([
    Promise.all(APPS.map((definition) => {
      const { upstream, secret, source, urlSource } = settings(definition.id);
      return appStatus(definition, upstream, secret, request, source, urlSource);
    })),
    Promise.all(APPS.map((definition) => askContainer(definition, settings, request)))
  ]);
  const libraries = db.prepare("SELECT name, type, source_path, scan_status, last_scanned_at, role FROM libraries ORDER BY type, name").all() as LibraryRow[];

  let redact: Redactor = keepEverything;
  if (!includePrivate) {
    const people = (db.prepare("SELECT email, display_name FROM users").all() as { email: string; display_name: string }[]).flatMap((user) => [user.email, user.display_name]);
    const fromContainers = containers.map((entry) => privateOf(entry.facts));
    const ownPaths = [config.dbPath, path.dirname(config.dbPath), config.backupPath, config.thumbnailPath, config.metadataPath, config.staticPath].filter(Boolean);
    redact = makeRedactor({
      people,
      names: [...libraries.map((row) => row.name), ...fromContainers.flatMap((entry) => entry.names)],
      paths: [...libraries.map((row) => row.source_path), ...ownPaths, ...fromContainers.flatMap((entry) => entry.paths)]
    });
  }

  const sections: ReportSection[] = [
    systemSection(),
    containersSection(statuses),
    librariesSection(libraries),
    failuresSection(),
    ...containers.filter((entry) => entry.note !== "not set up").map((entry): ReportSection => ({
      key: `container:${entry.app.id}`,
      title: `${entry.app.id} container`,
      lines: entry.facts ? factLines(entry.facts) : [entry.note ?? "nothing to say"]
    }))
  ];
  return {
    generatedAt: new Date().toISOString(),
    includesPrivate: includePrivate,
    sections: sections.map((section) => ({ ...section, lines: section.lines.map(redact) }))
  };
}
