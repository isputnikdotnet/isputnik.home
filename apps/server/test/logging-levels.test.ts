// How much the server logs, for a while (core/logging.ts): Detailed or Everything
// for a set time, then back to Normal by itself; kept across a restart.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/db.js";
import { detailedLogging, loggingPlugin, loggingState, resetLoggingForTests, setLogging, startLogging } from "../src/core/logging.js";
import { clearLogBuffer, pushLogLine } from "../src/core/log-buffer.js";
import { bootApp, type BootedApp } from "./helpers/boot.js";
import { makeUser, resetDb } from "./helpers/seed.js";

const fakeLogger = () => ({ level: "info", info: vi.fn() }) as unknown as Parameters<typeof startLogging>[0];

describe("logging levels", () => {
  beforeEach(() => {
    resetDb();
    resetLoggingForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetLoggingForTests();
  });

  it("raises the level for the time chosen, then goes back to Normal by itself", () => {
    vi.useFakeTimers({ now: new Date("2026-11-14T10:00:00Z") });
    const logger = fakeLogger();
    startLogging(logger);
    const state = setLogging("detailed", 15, null);
    expect(state).toMatchObject({ level: "detailed", until: "2026-11-14T10:15:00.000Z" });
    expect(logger.level).toBe("debug");
    expect(setLogging("everything", 60, null).until).toBe("2026-11-14T11:00:00.000Z");
    expect(logger.level).toBe("trace");
    vi.advanceTimersByTime(60 * 60_000 + 1);
    expect(loggingState().level).toBe("normal");
    expect(logger.level).toBe("info");
    // The report still carries every line for an hour after.
    expect(detailedLogging()).toBe(true);
    vi.advanceTimersByTime(61 * 60_000);
    expect(detailedLogging()).toBe(false);
  });

  it("offers only the short lengths, an hour when asked for another", () => {
    vi.useFakeTimers({ now: new Date("2026-11-14T10:00:00Z") });
    expect(setLogging("detailed", 1440, null).until).toBe("2026-11-14T11:00:00.000Z");
  });

  it("keeps a level that hasn't run out across a restart, and drops one that has", () => {
    vi.useFakeTimers({ now: new Date("2026-11-14T10:00:00Z") });
    setLogging("detailed", 240, null);
    resetLoggingForTests();
    const logger = fakeLogger();
    startLogging(logger);
    expect(logger.level).toBe("debug");
    db.prepare("UPDATE app_settings SET value = ? WHERE key = 'logging.home'").run(JSON.stringify({ level: "detailed", until: "2026-11-14T09:00:00.000Z" }));
    resetLoggingForTests();
    const later = fakeLogger();
    startLogging(later);
    expect(later.level).toBe("info");
    expect(loggingState().level).toBe("normal");
  });
});

describe("/api/admin/logging", () => {
  let booted: BootedApp | null = null;
  beforeEach(async () => {
    resetDb();
    resetLoggingForTests();
    makeUser("admin", "admin");
    makeUser("kid", "member");
    booted = await bootApp({ plugins: [[loggingPlugin, {}]] });
  });
  afterEach(async () => {
    setLogging("normal", null, null);
    resetLoggingForTests();
    await booted?.app.close();
    booted = null;
  });

  it("is for an admin, and records who turned it on", async () => {
    const kid = await booted!.app.inject({ method: "GET", url: "/api/admin/logging", headers: { cookie: await booted!.signIn("kid") } });
    expect(kid.statusCode).toBe(403);
    const cookie = await booted!.signIn("admin");
    const put = await booted!.app.inject({ method: "PUT", url: "/api/admin/logging", headers: { cookie }, payload: { level: "detailed", minutes: 15 } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ level: "detailed", minutes: [15, 60, 240] });
    const row = db.prepare("SELECT actor_user_id, detail FROM activity_logs WHERE event = 'logging.level.changed'").get() as { actor_user_id: string; detail: string };
    expect(row.actor_user_id).toBe("admin");
    expect(row.detail).toMatch(/^detailed until /);
    const bad = await booted!.app.inject({ method: "PUT", url: "/api/admin/logging", headers: { cookie }, payload: { level: "loud" } });
    expect(bad.statusCode).toBe(400);
  });

  // Diagnostics › iSputnik › Logs: the newest lines, as a container's /admin/log has them.
  it("hands an admin the newest log lines, oldest first", async () => {
    clearLogBuffer();
    for (let n = 1; n <= 5; n += 1) pushLogLine(`{"level":30,"time":${n},"msg":"line ${n}"}\n`);
    const kid = await booted!.app.inject({ method: "GET", url: "/api/admin/log?lines=2", headers: { cookie: await booted!.signIn("kid") } });
    expect(kid.statusCode).toBe(403);
    const cookie = await booted!.signIn("admin");
    const tail = await booted!.app.inject({ method: "GET", url: "/api/admin/log?lines=2", headers: { cookie } });
    expect(tail.statusCode).toBe(200);
    const body = tail.json() as { lines: string[]; capacity: number; available: boolean };
    expect(body.available).toBe(true);
    expect(body.capacity).toBe(500);
    // Signing in logs lines too; the two newest are what was asked for, oldest first.
    expect(body.lines).toHaveLength(2);
    expect((await booted!.app.inject({ method: "GET", url: "/api/admin/log?lines=0", headers: { cookie } })).statusCode).toBe(400);
    clearLogBuffer();
  });
});
