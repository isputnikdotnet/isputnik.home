// A passive witness for a worker that dies mid-run — the state vitest reports as
// "Worker exited unexpectedly", losing a whole file's results from the count.
// Vitest swallows the exit code, so this keeps a log of its own: which test file
// and which TEST the worker was on when it went, and how it went.
//
// Passive on purpose. It registers nothing for 'uncaughtException' or
// 'unhandledRejection' — a listener for either CHANGES whether Node treats it as
// fatal, which would mask the very thing being measured.
//
//   CRASH_LOG=/tmp/crash.log npm test --workspace apps/server
//
// vitest.config.ts only loads this file when CRASH_LOG is set, so an ordinary run
// carries none of it. What killed the worker in the end is written up in
// modules/library/shared/thumbnail.ts (renderInTurn).
import fs from "node:fs";
import { beforeAll, afterAll, beforeEach, afterEach, expect } from "vitest";

const LOG = process.env.CRASH_LOG;

let current = "?";

function write(line: string): void {
  if (!LOG) return;
  try {
    fs.appendFileSync(LOG, `${new Date().toISOString()} pid=${process.pid} ${line}\n`);
  } catch { /* the log is a convenience; never fail a run over it */ }
}

if (LOG) {
  beforeAll(() => {
    current = (expect.getState().testPath ?? "?").split(/[\\/]/).pop() ?? "?";
    write(`enter ${current}`);
  });
  afterAll(() => { write(`leave ${current}`); });
  // Per test as well: when a worker dies mid-file, the last line names the test
  // it was on.
  beforeEach((ctx) => { write(`  > ${current} :: ${ctx.task.name}`); });
  afterEach((ctx) => { write(`  < ${current} :: ${ctx.task.name}`); });

  process.on("exit", (code) => write(`EXIT code=${code} on=${current}`));
  process.on("beforeExit", (code) => write(`beforeExit code=${code} on=${current}`));
  // The forks pool talks to its children over IPC; a closed channel is one way a
  // child goes quiet without a fault.
  process.on("disconnect", () => write(`DISCONNECT on=${current}`));
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP", "SIGBREAK"] as const) {
    process.on(signal, () => write(`SIGNAL ${signal} on=${current}`));
  }
}
