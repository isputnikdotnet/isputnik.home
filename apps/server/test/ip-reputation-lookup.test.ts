// Reputation for a table of addresses. The rule this file pins is the one
// ip-reputation.ts is built around: reading never calls AbuseIPDB. The Logins
// table asks about every IP it just drew, and gets back only what an admin's own
// earlier lookup (or an auto-block) already cached — a local address is refused
// outright rather than sent to a third party.
import { beforeEach, describe, expect, it } from "vitest";
import fastify, { type FastifyInstance } from "fastify";
import { db } from "../src/db.js";
import { securityRoutes } from "../src/core/security-routes.js";
import { setSecurityPolicy, getSecurityPolicy, DEFAULT_SECURITY_POLICY } from "../src/core/security.js";
import { resetDb, makeUser } from "./helpers/seed.js";

let app: FastifyInstance;

function cacheReputation(ip: string, score: number, countryCode: string | null, isp: string | null): void {
  db.prepare(
    `INSERT INTO ip_reputation (ip_address, score, total_reports, last_reported_at, country_code, isp, checked_at)
     VALUES (?, ?, 4, NULL, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`
  ).run(ip, score, countryCode, isp);
}

function get(url: string) {
  return app.inject({ method: "GET", url, headers: { "x-test-user": "admin" } });
}

beforeEach(async () => {
  resetDb();
  db.prepare("DELETE FROM ip_reputation").run();
  db.prepare("DELETE FROM app_settings WHERE key = 'security_policy'").run();
  makeUser("admin", "admin");

  app = fastify();
  const auth = async (
    request: { headers: Record<string, unknown>; user?: unknown },
    reply: { code: (n: number) => { send: (b: unknown) => void } }
  ) => {
    const id = request.headers["x-test-user"] as string | undefined;
    const row = id ? (db.prepare("SELECT id, role FROM users WHERE id = ?").get(id) as { id: string; role: string } | undefined) : undefined;
    if (!row) { reply.code(401).send({ error: "Unauthenticated" }); return; }
    request.user = row;
  };
  app.decorate("authenticate", auth);
  app.decorate("requireAdmin", auth);
  await app.register(securityRoutes);
  await app.ready();
});

describe("GET /api/security/ip-reputation", () => {
  it("says reputation is off until a key is stored", async () => {
    const res = await get("/api/security/ip-reputation?ip=203.0.113.9");
    expect(res.statusCode).toBe(200);
    expect(res.json().configured).toBe(false);
  });

  it("returns the cached score, country and ISP for the addresses asked about", async () => {
    setSecurityPolicy({ ...DEFAULT_SECURITY_POLICY, abuseIpdbKey: "test-key" }, null);
    cacheReputation("203.0.113.9", 87, "NL", "Some Hosting BV");
    cacheReputation("198.51.100.4", 0, "US", "Home ISP");

    const res = await get("/api/security/ip-reputation?ip=203.0.113.9&ip=198.51.100.4&ip=203.0.113.77");
    const body = res.json();

    expect(body.configured).toBe(true);
    expect(body.reputation).toHaveLength(2); // the third was never looked up
    const flagged = body.reputation.find((row: { ip: string }) => row.ip === "203.0.113.9");
    expect(flagged).toMatchObject({ score: 87, countryCode: "NL", isp: "Some Hosting BV" });
  });
});

describe("POST /api/security/ip-reputation/:ip/check", () => {
  const check = (ip: string) =>
    app.inject({ method: "POST", url: `/api/security/ip-reputation/${ip}/check`, headers: { "x-test-user": "admin" } });

  it("refuses without a key, before any address leaves the house", async () => {
    const res = await check("203.0.113.9");
    expect(res.statusCode).toBe(409);
    expect(getSecurityPolicy().abuseIpdbKey).toBe("");
  });

  it("refuses a local address even with a key set", async () => {
    setSecurityPolicy({ ...DEFAULT_SECURITY_POLICY, abuseIpdbKey: "test-key" }, null);
    for (const ip of ["127.0.0.1", "192.168.1.20", "10.0.0.5"]) {
      const res = await check(ip);
      expect(res.statusCode).toBe(400);
    }
  });
});
