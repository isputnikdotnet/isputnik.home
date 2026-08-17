// Turning MFA off, or minting fresh backup codes, used to need only the account
// password — so a stolen password plus a live session could strip the second
// factor. Both now require a current second factor (an authenticator code or a
// backup code) while MFA is on. These pin that gate through the real routes.
import { beforeEach, describe, expect, it } from "vitest";
import fastify, { type FastifyInstance } from "fastify";
import { authenticator } from "otplib";
import { db, type User } from "../src/db.js";
import { hashPassword } from "../src/crypto.js";
import { mfaRoutes, beginMfaSetup, activateMfa } from "../src/core/mfa-routes.js";
import { resetDb, makeUser } from "./helpers/seed.js";

let app: FastifyInstance;
let totpSecret: string;
let backupCodes: string[];

// Enroll u1 in TOTP and capture the plaintext secret (for generating codes) and
// the backup codes, mirroring the enable() helper in mfa-routes.test.ts.
function enableTotp(userId: string): void {
  const setup = beginMfaSetup(userId, "totp");
  if (setup.method !== "totp") throw new Error("expected a totp setup");
  totpSecret = setup.secret;
  const codes = activateMfa(userId, authenticator.generate(setup.secret));
  if (!codes) throw new Error("activation failed");
  backupCodes = codes;
}

async function post(url: string, body: Record<string, unknown>) {
  const res = await app.inject({
    method: "POST",
    url,
    headers: { "x-test-user": "u1", "content-type": "application/json" },
    payload: JSON.stringify(body)
  });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

beforeEach(async () => {
  resetDb();
  makeUser("u1");
  db.prepare("UPDATE users SET password_hash = ? WHERE id = 'u1'").run(await hashPassword("correct-horse"));
  enableTotp("u1");

  app = fastify();
  app.decorate("authenticate", async (request, reply) => {
    const id = request.headers["x-test-user"] as string | undefined;
    const row = id ? (db.prepare("SELECT * FROM users WHERE id = ?").get(id) as User | undefined) : undefined;
    if (!row) { reply.code(401).send({ error: "no" }); return; }
    request.user = row;
  });
  await app.register(mfaRoutes);
  await app.ready();
});

describe("disabling MFA requires a second factor", () => {
  it("400s with the right password but no code", async () => {
    const { status, body } = await post("/api/profile/mfa/disable", { currentPassword: "correct-horse" });
    expect(status).toBe(400);
    expect(body.needsSecondFactor).toBe(true);
    expect(db.prepare("SELECT mfa_enabled FROM users WHERE id = 'u1'").get()).toEqual({ mfa_enabled: 1 });
  });

  it("403s the wrong password before it even asks for a code", async () => {
    const { status } = await post("/api/profile/mfa/disable", { currentPassword: "nope", code: authenticator.generate(totpSecret) });
    expect(status).toBe(403);
    expect(db.prepare("SELECT mfa_enabled FROM users WHERE id = 'u1'").get()).toEqual({ mfa_enabled: 1 });
  });

  it("403s a wrong second-factor code", async () => {
    const { status } = await post("/api/profile/mfa/disable", { currentPassword: "correct-horse", code: "000000" });
    expect(status).toBe(403);
    expect(db.prepare("SELECT mfa_enabled FROM users WHERE id = 'u1'").get()).toEqual({ mfa_enabled: 1 });
  });

  it("disables with password + a valid authenticator code", async () => {
    const { status } = await post("/api/profile/mfa/disable", {
      currentPassword: "correct-horse",
      code: authenticator.generate(totpSecret)
    });
    expect(status).toBe(200);
    expect(db.prepare("SELECT mfa_enabled FROM users WHERE id = 'u1'").get()).toEqual({ mfa_enabled: 0 });
  });

  it("also accepts a backup code as the second factor", async () => {
    const { status } = await post("/api/profile/mfa/disable", { currentPassword: "correct-horse", code: backupCodes[0] });
    expect(status).toBe(200);
    expect(db.prepare("SELECT mfa_enabled FROM users WHERE id = 'u1'").get()).toEqual({ mfa_enabled: 0 });
  });
});

describe("regenerating backup codes requires a second factor (closes the disable bypass)", () => {
  it("400s with the password but no code", async () => {
    const { status, body } = await post("/api/profile/mfa/backup-codes", { currentPassword: "correct-horse" });
    expect(status).toBe(400);
    expect(body.needsSecondFactor).toBe(true);
  });

  it("regenerates with password + a valid authenticator code", async () => {
    const { status, body } = await post("/api/profile/mfa/backup-codes", {
      currentPassword: "correct-horse",
      code: authenticator.generate(totpSecret)
    });
    expect(status).toBe(200);
    expect(body.backupCodes).toHaveLength(10);
    // Fresh set — an old backup code no longer works.
    expect(body.backupCodes).not.toContain(backupCodes[0]);
  });
});
