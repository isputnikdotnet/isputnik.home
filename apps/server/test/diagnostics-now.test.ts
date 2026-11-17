// The machine right now (modules/diagnostics/now.ts): CPU busy and memory free,
// read when a part's page asks, for an admin only.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diagnosticsPlugin } from "../src/modules/diagnostics/index.js";
import { memAvailable } from "../src/modules/diagnostics/now.js";
import { bootApp, type BootedApp } from "./helpers/boot.js";
import { makeUser, resetDb } from "./helpers/seed.js";

let booted: BootedApp | null = null;

beforeEach(async () => {
  resetDb();
  makeUser("admin", "admin");
  makeUser("kid", "member");
  booted = await bootApp({ plugins: [[diagnosticsPlugin, { settings: { video: { upstream: "", secret: "" }, games: { upstream: "", secret: "" }, faces: { upstream: "", secret: "" } } }]] });
});

afterEach(async () => {
  await booted?.app.close();
  booted = null;
});

describe("right now", () => {
  it("says how busy the CPU is and how much memory is free, to an admin", async () => {
    const as = async (who: string) => booted!.app.inject({ method: "GET", url: "/api/admin/diagnostics/now", headers: { cookie: await booted!.signIn(who) } });
    expect((await as("kid")).statusCode).toBe(403);
    const now = (await as("admin")).json();
    expect(now.cpu.percent).toBeGreaterThanOrEqual(0);
    expect(now.cpu.percent).toBeLessThanOrEqual(100);
    expect(now.cpu.cores).toBeGreaterThan(0);
    expect(now.memory.totalBytes).toBeGreaterThan(0);
    expect(now.memory.availableBytes).toBeGreaterThan(0);
    expect(now.memory.availableBytes).toBeLessThanOrEqual(now.memory.totalBytes);
    expect(now.memory.homeBytes).toBeGreaterThan(0);
  });

  it("reads MemAvailable, not MemFree, on Linux", () => {
    expect(memAvailable("MemTotal:       16000000 kB\nMemFree:          500000 kB\nMemAvailable:    9000000 kB\n")).toBe(9_000_000 * 1024);
    expect(memAvailable("MemTotal: 1 kB\n")).toBeNull();
  });
});
