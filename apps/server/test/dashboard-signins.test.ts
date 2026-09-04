import { beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";

import { db } from "../src/db.js";
import { issueSession, registerAuthDecorators } from "../src/auth.js";
import { dashboardPlugin } from "../src/core/dashboard.js";
import { makeUser, resetDb } from "./helpers/seed.js";

// The Dashboard's Sign-ins view asks one endpoint for everything it shows,
// scoped to an address, a person, or a place. These pin the scoping: every panel
// of the response must describe the same rows, failures must gather under the
// null actor rather than vanish, and the side tables (blocks, scanner traffic,
// live sessions) must follow the same scope as the main counts. The second
// block pins the window itself — those cases came from /api/dashboard/logins,
// which this endpoint absorbed along with the view.

let app: FastifyInstance;
let admin: string;
let member: string;

async function buildApp(): Promise<FastifyInstance> {
  const instance = Fastify();
  await instance.register(cookie);
  await registerAuthDecorators(instance);
  await instance.register(dashboardPlugin);

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

let seq = 0;

function logLogin(event: string, ip: string, actor: string | null, hoursBack = 1): void {
  seq += 1;
  db.prepare(`
    INSERT INTO activity_logs (id, event, actor_user_id, detail, ip_address, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(`log-${seq}`, event, actor, "Signed in.", ip, new Date(Date.now() - hoursBack * 3_600_000).toISOString());
}

function logAttempt(email: string | null, ip: string, kind: string, hoursBack = 1): void {
  seq += 1;
  db.prepare(`
    INSERT INTO login_attempts (id, email, ip_address, successful, kind, created_at)
    VALUES (?, ?, ?, 0, ?, ?)
  `).run(`att-${seq}`, email, ip, kind, new Date(Date.now() - hoursBack * 3_600_000).toISOString());
}

function block(ip: string, at: Date): void {
  db.prepare(
    "INSERT INTO blocked_ips (ip_address, reason, auto, created_at) VALUES (?, 'Too many failed sign-ins', 1, ?)"
  ).run(ip, at.toISOString());
}

function makeSession(userId: string, ip: string, agent: string): void {
  seq += 1;
  db.prepare(`
    INSERT INTO sessions (id, token_hash, user_id, expires_at, last_seen_at, device_name, ip_address, kind)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'browser')
  `).run(
    `ses-${seq}`,
    `hash-${seq}`,
    userId,
    new Date(Date.now() + 7 * 24 * 3_600_000).toISOString(),
    new Date().toISOString(),
    agent,
    ip
  );
}

const dayAgo = () => new Date(Date.now() - 24 * 3_600_000);
const hoursAgo = (n: number) => new Date(Date.now() - n * 3_600_000);
const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 3_600_000);

/** `extra` is spread last, so a case can widen or move the default 24h window. */
const window = (from: Date, to = new Date()) => ({ from: from.toISOString(), to: to.toISOString() });

async function signins(session: string, extra: Record<string, string> = {}) {
  const query = new URLSearchParams({ from: dayAgo().toISOString(), to: new Date().toISOString(), ...extra });
  const res = await app.inject({ method: "GET", url: `/api/dashboard/signins?${query}`, headers: { cookie: session } });
  if (res.statusCode >= 500) console.error("SERVER ERROR:", res.body);
  return { status: res.statusCode, body: res.json() };
}

beforeEach(async () => {
  resetDb();
  seq = 0;
  admin = makeUser("boss", "admin");
  member = makeUser("kid", "member");
  app = await buildApp();
});

describe("GET /api/dashboard/signins", () => {
  it("refuses anyone but an admin", async () => {
    const session = await signIn(member);
    const { status } = await signins(session);
    expect(status).toBe(403);
  });

  it("answers the unscoped view with totals, series and both breakdowns agreeing", async () => {
    logLogin("auth.login", "9.9.9.9", admin);
    logLogin("auth.passkey_login", "9.9.9.9", member);
    logLogin("auth.login_failed", "8.8.8.8", null);
    logLogin("auth.login", "9.9.9.9", admin, 30); // outside the window

    const session = await signIn(admin);
    const { status, body } = await signins(session);
    expect(status).toBe(200);
    expect(body.scope.kind).toBe("all");
    expect(body.totals.attempts).toBe(3);
    expect(body.totals.success).toBe(2);
    expect(body.totals.failed).toBe(1);
    expect(body.methods.password).toBe(1);
    expect(body.methods.passkey).toBe(1);
    // The chart counts the same rows the totals do.
    const chartSuccess = body.series.success.reduce((a: number, b: number) => a + b, 0);
    expect(chartSuccess).toBe(2);
    // Failures gather under the null actor instead of vanishing.
    const unknown = body.users.find((u: { userId: string | null }) => u.userId === null);
    expect(unknown.failed).toBe(1);
    expect(body.ips.map((r: { ip: string }) => r.ip).sort()).toEqual(["8.8.8.8", "9.9.9.9"]);
  });

  it("scopes to one address, and carries its block and scanner traffic with it", async () => {
    logLogin("auth.login_failed", "8.8.8.8", null);
    logLogin("auth.login_failed", "8.8.8.8", null);
    logLogin("auth.login", "9.9.9.9", admin);
    logAttempt(null, "8.8.8.8", "probe");
    logAttempt(null, "8.8.8.8", "token");
    logAttempt("root@nowhere.example", "8.8.8.8", "signin");
    db.prepare("INSERT INTO blocked_ips (ip_address, reason, auto) VALUES ('8.8.8.8', 'test', 1)").run();

    const session = await signIn(admin);
    const { body } = await signins(session, { ip: "8.8.8.8" });
    expect(body.scope).toMatchObject({ kind: "ip", label: "8.8.8.8" });
    expect(body.totals.attempts).toBe(2); // 9.9.9.9 is out of scope
    expect(body.ips).toHaveLength(1);
    expect(body.ips[0]).toMatchObject({ ip: "8.8.8.8", probes: 1, tokens: 1 });
    expect(body.ips[0].blocked).toMatchObject({ auto: true, lapsed: false });
    // The name the stranger guessed shows; real accounts never would.
    expect(body.guessedNames).toEqual([
      expect.objectContaining({ email: "root@nowhere.example", attempts: 1 })
    ]);
  });

  it("scopes to one person, including only their live sessions", async () => {
    logLogin("auth.login", "9.9.9.9", admin);
    logLogin("auth.login", "7.7.7.7", member);
    makeSession(admin, "9.9.9.9", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0");
    makeSession(member, "7.7.7.7", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X)");

    const session = await signIn(admin);
    const { body } = await signins(session, { user: member });
    expect(body.scope.kind).toBe("user");
    expect(body.totals.attempts).toBe(1);
    expect(body.ips).toEqual([expect.objectContaining({ ip: "7.7.7.7" })]);
    expect(body.devices).toHaveLength(1);
    expect(body.devices[0].personId).toBe(member);
    // A person's page has no guessing wordlist — attempts carry emails, not ids.
    expect(body.guessedNames).toEqual([]);
  });

  it("treats an unknown person as not found and an unplaceable country as empty, not an error", async () => {
    logLogin("auth.login", "9.9.9.9", admin);
    const session = await signIn(admin);

    const missing = await signins(session, { user: "no-such-user" });
    expect(missing.status).toBe(404);

    // No GeoIP database in tests: a country scope resolves to zero addresses,
    // which is an empty page, never a crash.
    const country = await signins(session, { country: "DE" });
    expect(country.status).toBe(200);
    expect(country.body.totals.attempts).toBe(0);
    expect(country.body.ips).toEqual([]);
  });
});

describe("GET /api/dashboard/signins over a window", () => {
  it("buckets a short window by hour and counts only what falls inside it", async () => {
    logLogin("auth.login", "9.9.9.9", admin, 2);
    logLogin("auth.passkey_login", "9.9.9.9", member, 2);
    logLogin("auth.login_failed", "8.8.8.8", null, 1);
    logLogin("auth.login", "9.9.9.9", admin, 30); // outside a 24h window

    const session = await signIn(admin);
    const { status, body } = await signins(session, window(hoursAgo(24)));

    expect(status).toBe(200);
    expect(body.series.bucket).toBe("hour");
    // 24 hours of buckets, plus the partial one the window opened in.
    expect(body.series.buckets.length).toBe(25);
    expect(body.series.buckets.length).toBe(body.series.success.length);
    expect(body.totals).toMatchObject({ attempts: 3, success: 2, failed: 1 });
    expect(body.methods).toMatchObject({ password: 1, passkey: 1, deviceLink: 0 });
    expect(body.series.success.reduce((sum: number, n: number) => sum + n, 0)).toBe(2);
    expect(body.series.failed.reduce((sum: number, n: number) => sum + n, 0)).toBe(1);
  });

  it("counts a two-factor sign-in, which is the only kind an MFA household makes", async () => {
    // With a second factor on, the password step logs auth.mfa_required and stops;
    // the session is issued when the code is accepted, logging auth.mfa_verified.
    // No auth.login is ever written, so leaving mfa_verified out made every such
    // sign-in invisible here while the Logs page listed them (3.11.0 did exactly
    // that). auth.mfa_required is the middle of one sign-in, and must NOT add a
    // second count for it.
    logLogin("auth.mfa_required", "9.9.9.9", admin, 2);
    logLogin("auth.mfa_verified", "9.9.9.9", admin, 2);
    logLogin("auth.mfa_failed", "8.8.8.8", null, 1);

    const session = await signIn(admin);
    const { body } = await signins(session, window(hoursAgo(24)));

    expect(body.totals).toMatchObject({ attempts: 2, success: 1, failed: 1 });
    expect(body.methods.twoFactor).toBe(1);
    expect(body.methods.password).toBe(0);
  });

  it("adds every method up to the success total", async () => {
    logLogin("auth.login", "9.9.9.9", admin, 4);
    logLogin("auth.passkey_login", "9.9.9.9", admin, 3);
    logLogin("auth.mfa_verified", "9.9.9.9", admin, 2);
    logLogin("auth.device_link_approved", "9.9.9.9", admin, 1);

    const session = await signIn(admin);
    const { body } = await signins(session, window(hoursAgo(24)));

    expect(body.methods).toMatchObject({ password: 1, passkey: 1, twoFactor: 1, deviceLink: 1 });
    expect(body.totals.success).toBe(4);
  });

  it("buckets a long window by day", async () => {
    logLogin("auth.login", "9.9.9.9", admin, 3 * 24);
    logLogin("auth.device_link_approved", "9.9.9.9", admin, 10 * 24);

    const session = await signIn(admin);
    const { body } = await signins(session, window(daysAgo(30)));

    expect(body.series.bucket).toBe("day");
    expect(body.series.buckets.length).toBe(31);
    expect(body.totals.success).toBe(2);
    expect(body.methods.deviceLink).toBe(1);
  });

  it("counts the addresses blocked during the window, and narrows them with the scope", async () => {
    logLogin("auth.login_failed", "203.0.113.7", null, 2);
    logLogin("auth.login", "9.9.9.9", admin, 2);
    block("203.0.113.7", hoursAgo(2));
    block("203.0.113.8", daysAgo(5)); // outside the window

    const session = await signIn(admin);
    const unscoped = await signins(session, window(hoursAgo(24)));
    expect(unscoped.body.totals.blockedIps).toBe(1);

    // An address scope counts its own blocks, not the house's.
    const scoped = await signins(session, { ...window(hoursAgo(24)), ip: "9.9.9.9" });
    expect(scoped.body.totals.blockedIps).toBe(0);
  });

  it("counts each person once, however often they signed in", async () => {
    logLogin("auth.login", "9.9.9.9", admin, 3);
    logLogin("auth.login", "9.9.9.9", admin, 2);
    logLogin("auth.passkey_login", "7.7.7.7", member, 1);

    const session = await signIn(admin);
    const { body } = await signins(session, window(hoursAgo(24)));

    expect(body.totals.success).toBe(3);
    expect(body.totals.people).toBe(2);
  });

  it("returns the scope's raw rows in the shape /api/logs uses, so one table renders both", async () => {
    logLogin("auth.login", "9.9.9.9", admin, 1);

    const session = await signIn(admin);
    const { body } = await signins(session, window(hoursAgo(24)));

    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({ event: "auth.login", ipAddress: "9.9.9.9", actorId: admin });
    expect(body.events[0].createdAt).toBeTruthy();
    expect(body.events[0].actorName).toBeTruthy();
  });

  it("lists guest share-link visits beside the sign-ins, as their own kind", async () => {
    logLogin("auth.login", "9.9.9.9", admin, 2);
    logLogin("auth.login_failed", "8.8.8.8", null, 2);
    // Two strangers through a link, and a member who opened one while signed
    // in — the member is already on the page as themselves, so only the
    // strangers count as guests.
    logLogin("share.accessed", "6.6.6.6", null, 1);
    logLogin("share.accessed", "6.6.6.6", null, 1);
    logLogin("share.accessed", "9.9.9.9", member, 1);

    const session = await signIn(admin);
    const { body } = await signins(session, window(hoursAgo(24)));

    // Guests are not attempts: nobody typed a password.
    expect(body.totals.attempts).toBe(2);
    expect(body.totals.guests).toBe(2);
    expect(body.series.guests.reduce((a: number, b: number) => a + b, 0)).toBe(2);
    // Their own row, apart from the failed-attempts row.
    const guests = body.users.find((u: { guest: boolean }) => u.guest);
    expect(guests).toMatchObject({ userId: null, guests: 2, failed: 0, connections: 2 });
    const unknown = body.users.find((u: { userId: string | null; guest: boolean }) => u.userId === null && !u.guest);
    expect(unknown).toMatchObject({ failed: 1, guests: 0 });
    // The address they came from carries the count.
    const guestIp = body.ips.find((r: { ip: string }) => r.ip === "6.6.6.6");
    expect(guestIp).toMatchObject({ guests: 2, failed: 0 });
    // A person's own dive never lists them: nobody is signed in on a guest link.
    const mine = await signins(session, { ...window(hoursAgo(24)), user: member });
    expect(mine.body.totals.guests).toBe(0);
    expect(mine.body.users.some((u: { guest: boolean }) => u.guest)).toBe(false);
  });

  it("rejects a backwards range and a garbage date", async () => {
    const session = await signIn(admin);

    const backwards = await signins(session, window(new Date(), hoursAgo(1)));
    expect(backwards.status).toBe(400);

    const garbage = await signins(session, { from: "yesterday", to: "now" });
    expect(garbage.status).toBe(400);
  });
});
