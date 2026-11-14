// How much the server logs, for a while (docs/diagnostic-logging-plan.md):
// Normal, or Detailed / Everything for 15 minutes, an hour or 4 hours, then back
// to Normal by itself. An admin turns it on from Diagnostics to reproduce a
// problem; the report then carries every line, not only the problems.
//
// Normal is LOG_LEVEL (info unless set). The choice and its end are kept in
// app_settings, so a restart keeps a level that hasn't run out and drops one that
// has. Changing the level needs no restart: pino takes a new level at once, and
// each request's logger is made from it.
import { z } from "zod";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { db, logActivity } from "../db.js";
import { setLogBufferDetailed } from "./log-buffer.js";
import { parseBody } from "./shared.js";

export type LoggingLevel = "normal" | "detailed" | "everything";
export const LOGGING_MINUTES = [15, 60, 240] as const;

export interface LoggingState {
  level: LoggingLevel;
  /** When it goes back to Normal; null at Normal. */
  until: string | null;
  /** The pino level Normal stands for (LOG_LEVEL). */
  normal: string;
  /** The lengths it can be turned on for, in minutes. */
  minutes: readonly number[];
  /** When a detailed level last ended: the report carries every line for an hour after. */
  endedAt: string | null;
}

const KEY = "logging.home";
const PINO: Record<Exclude<LoggingLevel, "normal">, string> = { detailed: "debug", everything: "trace" };

let logger: FastifyBaseLogger | null = null;
let timer: NodeJS.Timeout | null = null;
let endedAt: string | null = null;

const normalLevel = () => process.env.LOG_LEVEL?.trim() || "info";

interface Stored { level: LoggingLevel; until: string | null }

function read(): Stored {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(KEY) as { value: string } | undefined;
  try {
    const value = row ? (JSON.parse(row.value) as Stored) : null;
    if (value && value.level !== "normal" && value.until && Date.parse(value.until) > Date.now()) return value;
  } catch {
    // Unreadable: Normal.
  }
  return { level: "normal", until: null };
}

function write(value: Stored, userId: string | null): void {
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at
  `).run(KEY, JSON.stringify(value), userId);
}

/** Puts the stored level in force, and the timer that ends it. */
function apply(): void {
  const stored = read();
  if (timer) clearTimeout(timer);
  timer = null;
  const pino = stored.level === "normal" ? normalLevel() : PINO[stored.level];
  if (logger) logger.level = pino;
  setLogBufferDetailed(stored.level !== "normal");
  if (stored.until) {
    // setTimeout's limit is ~24 days; 4 hours is the most it is ever asked for.
    timer = setTimeout(() => {
      endedAt = new Date().toISOString();
      write({ level: "normal", until: null }, null);
      apply();
      logger?.info("logging back to Normal");
    }, Math.max(0, Date.parse(stored.until) - Date.now()));
    timer.unref();
  }
}

export function loggingState(): LoggingState {
  const stored = read();
  return { ...stored, normal: normalLevel(), minutes: LOGGING_MINUTES, endedAt };
}

/** Whether the report should carry every line: a detailed level is on, or ended within the hour. */
export function detailedLogging(now = Date.now()): boolean {
  if (read().level !== "normal") return true;
  return endedAt !== null && now - Date.parse(endedAt) < 60 * 60_000;
}

/** Called once the server's logger exists (index.ts); tests may hand one in. */
export function startLogging(appLogger: FastifyBaseLogger): void {
  logger = appLogger;
  apply();
}

export function setLogging(level: LoggingLevel, minutes: number | null, userId: string | null): LoggingState {
  const before = read();
  if (level === "normal") {
    if (before.level !== "normal") endedAt = new Date().toISOString();
    write({ level: "normal", until: null }, userId);
  } else {
    const length = LOGGING_MINUTES.includes(minutes as (typeof LOGGING_MINUTES)[number]) ? minutes! : 60;
    write({ level, until: new Date(Date.now() + length * 60_000).toISOString() }, userId);
  }
  apply();
  return loggingState();
}

const putSchema = z.object({
  level: z.enum(["normal", "detailed", "everything"]),
  minutes: z.number().int().optional()
});

export async function loggingPlugin(app: FastifyInstance) {
  app.get("/api/admin/logging", { preHandler: app.requireAdmin }, async () => loggingState());

  app.put("/api/admin/logging", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(putSchema, request.body);
    if (parsed.error) return reply.code(400).send({ error: "Invalid logging level", details: parsed.error });
    const state = setLogging(parsed.data.level, parsed.data.minutes ?? null, request.user!.id);
    logActivity({
      event: "logging.level.changed",
      actorUserId: request.user!.id,
      targetType: "server",
      targetId: "home",
      detail: state.until ? `${state.level} until ${state.until}` : "normal",
      ipAddress: request.ip
    });
    request.log.info({ level: state.level, until: state.until }, "logging level changed");
    return state;
  });
}

/** Tests only. */
export function resetLoggingForTests(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  endedAt = null;
  logger = null;
}
