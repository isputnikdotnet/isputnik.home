import type { FastifyBaseLogger } from "fastify";

// The server's logger for code that runs outside a request — scan and render
// workers, job recovery, the face engine, backups. Inside a handler use
// request.log; out here there is no request, and these used to write with
// console.*, which put plain lines in the middle of pino's JSON (no level, no
// time, nothing a log shipper can filter on).
//
// index.ts hands Fastify's own pino instance over once it exists, so everything
// shares one stream, one format and LOG_LEVEL. Before that (module import time)
// and in tests, which never boot index.ts, the calls fall through to the console.

let current: FastifyBaseLogger | null = null;

export function setAppLogger(logger: FastifyBaseLogger): void {
  current = logger;
}

type Level = "info" | "warn" | "error";

function emit(level: Level, first: object | string, message?: string): void {
  if (current) {
    if (typeof first === "string") current[level](first);
    else current[level](first, message);
    return;
  }
  const out = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  if (typeof first === "string") out(first);
  else out(message ?? "", first);
}

/** `log.warn("text")`, or `log.error({ err }, "text")` to attach an error or fields. */
export const log = {
  info: (first: object | string, message?: string) => emit("info", first, message),
  warn: (first: object | string, message?: string) => emit("warn", first, message),
  error: (first: object | string, message?: string) => emit("error", first, message)
};
