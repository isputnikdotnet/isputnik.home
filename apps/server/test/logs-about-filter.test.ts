import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { db } from "../src/db.js";
import { logsPlugin } from "../src/core/logs.js";
import { bootApp } from "./helpers/boot.js";
import { makeUser, resetDb } from "./helpers/seed.js";

// The Logs `about` filter: everything BY or ABOUT an account. A member's page
// shows the last few of these, and the actor-only `user` filter would show
// nothing for someone who has never signed in — the very account an admin has
// just set up and is looking at.

let app: FastifyInstance;
let session: string;
let logSeq = 0;

function log(actor: string | null, target: { type: string; id: string } | null, detail = "Something happened."): void {
  logSeq += 1;
  db.prepare(`
    INSERT INTO activity_logs (id, event, actor_user_id, target_type, target_id, detail, ip_address, created_at)
    VALUES (?, 'user.updated', ?, ?, ?, ?, '192.168.1.5', ?)
  `).run(`log-${logSeq}`, actor, target?.type ?? null, target?.id ?? null, detail, new Date(Date.now() - logSeq * 1000).toISOString());
}

beforeEach(async () => {
  resetDb();
  logSeq = 0;
  makeUser("boss", "admin");
  makeUser("sam");
  makeUser("other");
  log("sam", null, "Sam signed in.");
  log("boss", { type: "user", id: "sam" }, "Updated Sam's account.");
  log("boss", { type: "user", id: "other" }, "Updated Other's account.");
  // A library called "sam" is not the person.
  log("boss", { type: "library", id: "sam" }, "Rescanned a library.");
  log("other", null, "Other signed in.");
  let signIn: (userId: string) => Promise<string>;
  ({ app, signIn } = await bootApp({ plugins: [logsPlugin] }));
  session = await signIn("boss");
});

async function get(query: string) {
  const res = await app.inject({ method: "GET", url: `/api/logs?${query}`, headers: { cookie: session } });
  expect(res.statusCode).toBe(200);
  return res.json() as { logs: { detail: string }[]; total: number };
}

describe("GET /api/logs about filter", () => {
  it("returns what the account did and what was done to it, nothing else", async () => {
    const body = await get("about=sam");
    expect(body.total).toBe(2);
    expect(body.logs.map((row) => row.detail).sort()).toEqual(["Sam signed in.", "Updated Sam's account."]);
  });

  it("finds rows about an account that has never done anything", async () => {
    log("boss", { type: "user", id: "quiet" }, "Created Quiet's account.");
    const body = await get("about=quiet");
    expect(body.total).toBe(1);
    expect((await get("user=quiet")).total).toBe(0);
  });

  it("ANDs with the other filters", async () => {
    expect((await get("about=sam&user=boss")).total).toBe(1);
  });
});
