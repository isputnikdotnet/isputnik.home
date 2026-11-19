// The server's last log lines, kept in memory for the diagnostics report
// (docs/diagnostic-logging-plan.md): home's own output otherwise reaches only
// Docker, where a bug report can't get at it. Every line the logger writes goes
// to stdout as before and into this ring; the report reads its warnings and
// errors, and every line while a detailed level is on (core/logging.ts).
//
// The ring holds 500 lines, 2000 while a detailed level is on, so a reproduced
// problem doesn't scroll out before the report is made. Lines are pino's JSON,
// already masked by the logger's redaction (tokens in URLs).

const NORMAL_LINES = 500;
const DETAILED_LINES = 2000;

let capacity = NORMAL_LINES;
const lines: string[] = [];

export function pushLogLine(line: string): void {
  const text = line.endsWith("\n") ? line.slice(0, -1) : line;
  if (!text) return;
  lines.push(text);
  if (lines.length > capacity) lines.splice(0, lines.length - capacity);
}

/** More room while a detailed level is on; back to the usual afterwards (the newest kept). */
export function setLogBufferDetailed(detailed: boolean): void {
  capacity = detailed ? DETAILED_LINES : NORMAL_LINES;
  if (lines.length > capacity) lines.splice(0, lines.length - capacity);
}

export interface BufferedLine {
  level: number;
  time: number;
  text: string;
}

/** The lines since a moment, at a level and up, oldest first. Lines that aren't pino's JSON count as info, now. */
export function logLinesSince(since: number, minLevel: number): BufferedLine[] {
  const out: BufferedLine[] = [];
  for (const text of lines) {
    let level = 30;
    let time = Date.now();
    try {
      const entry = JSON.parse(text) as { level?: unknown; time?: unknown };
      if (typeof entry.level === "number") level = entry.level;
      if (typeof entry.time === "number") time = entry.time;
    } catch {
      // A plain line: kept as it is.
    }
    if (time >= since && level >= minLevel) out.push({ level, time, text });
  }
  return out;
}

/** The newest lines, oldest first, and how many the ring holds now: Diagnostics ›
 *  iSputnik › Logs reads them (GET /api/admin/log), as the containers' pages do theirs. */
export function tailLogLines(count: number): { lines: string[]; capacity: number } {
  return { lines: lines.slice(-Math.max(0, count)), capacity };
}

/** The stream the logger writes to: stdout, and this ring. */
export const logStream = {
  write(line: string): void {
    process.stdout.write(line);
    pushLogLine(line);
  }
};

/** Tests only. */
export function clearLogBuffer(): void {
  lines.length = 0;
  capacity = NORMAL_LINES;
}
