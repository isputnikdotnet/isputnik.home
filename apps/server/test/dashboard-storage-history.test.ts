import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { db } from "../src/db.js";
import { dashboardPlugin } from "../src/modules/dashboard/index.js";
import { sampleStorage } from "../src/modules/dashboard/storage-history.js";
import type { DashboardDisk } from "../src/modules/dashboard/overview.js";
import { bootApp } from "./helpers/boot.js";
import { makeUser, resetDb } from "./helpers/seed.js";

// The Dashboard's Growth (control panel v2, phase 4): one row a day per mount, the
// same day measured again replaced rather than doubled, and the history read back
// as used/total per day.

let app: FastifyInstance;
let signIn: (userId: string) => Promise<string>;
let admin: string;

const GB = 1_000_000_000;
const disk = (free: number): DashboardDisk => ({
  mount: "/media",
  filesystem: "7",
  freeBytes: free,
  totalBytes: 100 * GB,
  holds: [{ kind: "backups", path: "/media/backups", bytes: 3 * GB }],
  sharesWith: []
});

beforeEach(async () => {
  resetDb();
  db.prepare("DELETE FROM storage_samples").run();
  admin = makeUser("boss", "admin");
  ({ app, signIn } = await bootApp({ plugins: [dashboardPlugin] }));
});

describe("storage samples", () => {
  it("keeps one row a day per mount, the later measurement winning", () => {
    sampleStorage([disk(60 * GB)], "2026-11-01");
    sampleStorage([disk(55 * GB)], "2026-11-01");
    const rows = db.prepare("SELECT day, mount, free_bytes, holds_json FROM storage_samples").all() as { free_bytes: number; holds_json: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].free_bytes).toBe(55 * GB);
    expect(JSON.parse(rows[0].holds_json)).toEqual([{ kind: "backups", bytes: 3 * GB }]);
  });

  it("reads the history back as used and total per day, for admins", async () => {
    const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
    sampleStorage([disk(60 * GB)], day(3));
    sampleStorage([disk(50 * GB)], day(1));
    sampleStorage([disk(10 * GB)], day(90));
    const session = await signIn(admin);
    const res = await app.inject({ method: "GET", url: "/api/dashboard/storage-history?days=30", headers: { cookie: session } });
    expect(res.statusCode).toBe(200);
    expect(res.json().samples).toEqual([
      { day: day(3), mount: "/media", totalBytes: 100 * GB, usedBytes: 40 * GB },
      { day: day(1), mount: "/media", totalBytes: 100 * GB, usedBytes: 50 * GB }
    ]);
    const member = await signIn(makeUser("sam"));
    expect((await app.inject({ method: "GET", url: "/api/dashboard/storage-history", headers: { cookie: member } })).statusCode).toBe(403);
  });
});
