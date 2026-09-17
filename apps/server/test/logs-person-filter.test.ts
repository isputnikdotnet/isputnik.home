import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { db } from "../src/db.js";
import { logsPlugin } from "../src/core/logs.js";
import { bootApp } from "./helpers/boot.js";
import { makeUser, resetDb } from "./helpers/seed.js";

// The Logs person filter matches accounts, not names. Two people can share a
// display name, and filtering by the name used to show both of them as one.

let app: FastifyInstance;
let session: string;
let logSeq = 0;

function log(actor: string | null): void {
  logSeq += 1;
  db.prepare(`
    INSERT INTO activity_logs (id, event, actor_user_id, detail, ip_address, created_at)
    VALUES (?, 'auth.login', ?, 'Signed in.', '192.168.1.5', ?)
  `).run(`log-${logSeq}`, actor, new Date(Date.now() - logSeq * 1000).toISOString());
}

beforeEach(async () => {
  resetDb();
  logSeq = 0;
  makeUser("boss", "admin");
  makeUser("anna1");
  makeUser("anna2");
  // Two accounts, one name.
  db.prepare("UPDATE users SET display_name = 'Anna' WHERE id IN ('anna1', 'anna2')").run();
  log("anna1");
  log("anna1");
  log("anna2");
  log(null);
  let signIn: (userId: string) => Promise<string>;
  ({ app, signIn } = await bootApp({ plugins: [logsPlugin] }));
  session = await signIn("boss");
});

async function get(query: string) {
  const res = await app.inject({ method: "GET", url: `/api/logs?${query}`, headers: { cookie: session } });
  expect(res.statusCode).toBe(200);
  return res.json() as {
    logs: { actorId: string | null }[];
    total: number;
    facets: { user: string[] };
    facetLabels: { user: Record<string, string> };
  };
}

describe("GET /api/logs person filter", () => {
  it("matches one account, not everyone with its name", async () => {
    const body = await get("user=anna1");
    expect(body.total).toBe(2);
    expect(body.logs.every((row) => row.actorId === "anna1")).toBe(true);
  });

  it("ORs several accounts, and System still means the rows no one did", async () => {
    expect((await get("user=anna1&user=anna2")).total).toBe(3);
    const system = await get("user=System");
    expect(system.total).toBe(1);
    expect(system.logs[0].actorId).toBeNull();
  });

  it("lists accounts by id, with the name to show for each", async () => {
    const body = await get("");
    expect(body.facets.user).toEqual(expect.arrayContaining(["System", "anna1", "anna2"]));
    expect(body.facetLabels.user).toMatchObject({ anna1: "Anna", anna2: "Anna" });
  });

  it("no longer treats a display name as a person", async () => {
    expect((await get("user=Anna")).total).toBe(0);
  });
});
