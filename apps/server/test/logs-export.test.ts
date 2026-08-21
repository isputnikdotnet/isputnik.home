import { beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";

import { db } from "../src/db.js";
import { issueSession, registerAuthDecorators } from "../src/auth.js";
import { logsPlugin } from "../src/core/logs.js";
import { makeUser, resetDb } from "./helpers/seed.js";

// The Logs page's CSV export goes through the same query builder as the page, so
// these pin what matters about the file: it honours the filters, it is a real
// CSV (quoted where it must be), and a detail string that looks like a formula
// can't become one when the file opens in a spreadsheet.

let app: FastifyInstance;
let admin: string;

async function buildApp(): Promise<FastifyInstance> {
  const instance = Fastify();
  await instance.register(cookie);
  await registerAuthDecorators(instance);
  await instance.register(logsPlugin);
  instance.post("/test/sign-in/:userId", async (request, reply) => {
    issueSession(reply, (request.params as { userId: string }).userId, request);
    return reply.send({ ok: true });
  });
  await instance.ready();
  return instance;
}

async function signIn(userId: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: `/test/sign-in/${userId}` });
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : [String(raw)];
  const found = list.find((entry) => entry.startsWith("isputnik_sid="));
  if (!found) throw new Error("no session cookie was set");
  return found.split(";")[0];
}

let seq = 0;
function log(event: string, detail: string, actor: string | null = admin, ip = "9.9.9.9"): void {
  seq += 1;
  db.prepare("INSERT INTO activity_logs (id, event, actor_user_id, detail, ip_address, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    `log-${seq}`, event, actor, detail, ip, new Date(Date.now() - seq * 1000).toISOString()
  );
}

beforeEach(async () => {
  resetDb();
  seq = 0;
  admin = makeUser("boss", "admin");
  app = await buildApp();
});

describe("GET /api/logs/export", () => {
  it("is admin-only", async () => {
    const member = makeUser("kid", "member");
    const res = await app.inject({ method: "GET", url: "/api/logs/export", headers: { cookie: await signIn(member) } });
    expect(res.statusCode).toBe(403);
  });

  it("exports the filtered rows as a CSV download, quoting and neutralising as needed", async () => {
    log("auth.login", "Signed in.");
    log("auth.login_failed", 'Sign-in failed: "wrong" password, twice', null, "8.8.8.8");
    log("library.ebook.book_uploaded", "=HYPERLINK(\"http://evil\")");

    const res = await app.inject({
      method: "GET",
      url: "/api/logs/export?event=auth.login_failed&event=library.ebook.book_uploaded",
      headers: { cookie: await signIn(admin) }
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toMatch(/attachment; filename="isputnik-logs-.*\.csv"/);

    const lines = res.body.replace(/^﻿/, "").split("\r\n").filter(Boolean);
    expect(lines[0]).toBe("time,event,user,ip_address,detail");
    // Only the two filtered events, newest first; the login is out.
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("auth.login_failed,System,8.8.8.8,");
    // Embedded quotes and commas are quoted CSV-style...
    expect(lines[1]).toContain('"Sign-in failed: ""wrong"" password, twice"');
    // ...and a leading = is defused with an apostrophe so no spreadsheet runs it
    // (the apostrophe goes inside the quoting the embedded quotes already earn).
    expect(lines[2]).toContain(",\"'=HYPERLINK(");
  });

  it("lists every event by its full name in the facet, so one outcome is one filter", async () => {
    log("auth.login", "ok");
    log("auth.login_failed", "no");
    const res = await app.inject({ method: "GET", url: "/api/logs", headers: { cookie: await signIn(admin) } });
    expect(res.json().facets.event).toEqual(["auth.login", "auth.login_failed"]);
    expect(res.json().logs[0].actorId).toBe(admin);
  });
});
