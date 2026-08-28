import { beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";

import { db } from "../src/db.js";
import { issueSession, registerAuthDecorators } from "../src/auth.js";
import { logsPlugin } from "../src/core/logs.js";
import { makeUser, resetDb } from "./helpers/seed.js";

// /api/logs, windowed. The Logs page and the Dashboard's Activity view both ask
// it for a slice of a range and then page through the answer, so what "in range"
// means here has to match what the charts above those tables are drawn from.

let app: FastifyInstance;
let admin: string;

async function buildApp(): Promise<FastifyInstance> {
  const instance = Fastify();
  await instance.register(cookie);
  await registerAuthDecorators(instance);
  await instance.register(logsPlugin);

  instance.post("/test/sign-in/:userId", async (request, reply) => {
    const { userId } = request.params as { userId: string };
    issueSession(reply, userId, request);
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

let logSeq = 0;

function logLogin(event: string, at: Date, ip = "192.168.1.5", actor: string | null = "boss"): void {
  logSeq += 1;
  db.prepare(`
    INSERT INTO activity_logs (id, event, actor_user_id, detail, ip_address, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(`log-${logSeq}`, event, actor, "Signed in.", ip, at.toISOString());
}

const hoursAgo = (n: number) => new Date(Date.now() - n * 3_600_000);
const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 3_600_000);

beforeEach(async () => {
  resetDb();
  logSeq = 0;
  admin = makeUser("boss", "admin");
  app = await buildApp();
});

describe("GET /api/logs with a time window", () => {
  it("returns only the entries inside it, and pages them", async () => {
    for (let i = 0; i < 12; i += 1) logLogin("auth.login", hoursAgo(i + 1));
    logLogin("auth.login", hoursAgo(40));

    const session = await signIn(admin);
    const query = new URLSearchParams({
      from: hoursAgo(24).toISOString(),
      to: new Date().toISOString(),
      event: "auth.login",
      page: "1",
      pageSize: "10"
    });
    const first = await app.inject({ method: "GET", url: `/api/logs?${query}`, headers: { cookie: session } });
    const firstBody = first.json();

    expect(firstBody.total).toBe(12);
    expect(firstBody.totalPages).toBe(2);
    expect(firstBody.logs.length).toBe(10);
    expect(firstBody.logs[0].ipAddress).toBe("192.168.1.5");
    expect(firstBody.logs[0].actorName).toBeTruthy();

    query.set("page", "2");
    const second = await app.inject({ method: "GET", url: `/api/logs?${query}`, headers: { cookie: session } });
    expect(second.json().logs.length).toBe(2);
  });

  it("sorts by user, method and time on request", async () => {
    makeUser("zoe");
    makeUser("adam");
    logLogin("auth.passkey_login", hoursAgo(3), "192.168.1.5", "zoe");
    logLogin("auth.login", hoursAgo(2), "192.168.1.6", "adam");
    logLogin("auth.login_failed", hoursAgo(1), "192.168.1.7", "zoe");

    const session = await signIn(admin);
    const ask = async (sort: string, dir: string) => {
      const query = new URLSearchParams({ sort, dir, page: "1", pageSize: "10" });
      ["auth.login", "auth.passkey_login", "auth.login_failed"].forEach((event) => query.append("event", event));
      const res = await app.inject({ method: "GET", url: `/api/logs?${query}`, headers: { cookie: session } });
      return res.json().logs as { actorName: string; event: string; createdAt: string }[];
    };

    expect((await ask("user", "asc")).map((row) => row.actorName)).toEqual(["adam", "zoe", "zoe"]);
    expect((await ask("user", "desc")).map((row) => row.actorName)).toEqual(["zoe", "zoe", "adam"]);
    expect((await ask("event", "asc")).map((row) => row.event)).toEqual([
      "auth.login",
      "auth.login_failed",
      "auth.passkey_login"
    ]);

    const oldestFirst = await ask("time", "asc");
    const newestFirst = await ask("time", "desc");
    expect(oldestFirst.map((row) => row.createdAt)).toEqual([...newestFirst.map((row) => row.createdAt)].reverse());
  });

  it("defaults to newest first when no sort is asked for", async () => {
    logLogin("auth.login", hoursAgo(3));
    logLogin("auth.login", hoursAgo(1));

    const session = await signIn(admin);
    const res = await app.inject({ method: "GET", url: "/api/logs?event=auth.login", headers: { cookie: session } });
    const rows = res.json().logs as { createdAt: string }[];
    expect(new Date(rows[0].createdAt).getTime()).toBeGreaterThan(new Date(rows[1].createdAt).getTime());
  });

  it("leaves an unwindowed query alone", async () => {
    logLogin("auth.login", hoursAgo(1));
    logLogin("auth.login", daysAgo(400));

    const session = await signIn(admin);
    const res = await app.inject({ method: "GET", url: "/api/logs?event=auth.login", headers: { cookie: session } });
    expect(res.json().total).toBe(2);
  });
});
