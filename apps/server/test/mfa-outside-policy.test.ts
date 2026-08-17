import { beforeEach, describe, expect, it, vi } from "vitest";

// The outside-MFA policy: with `requireMfaOutside` on, a password alone is never
// enough from outside a trusted network. Enrolled accounts use their usual
// method; un-enrolled ones fall back to a code emailed to the sign-in address —
// and when the server can't send mail, the sign-in is refused rather than waved
// through. Mail is mocked so the tests can flip SMTP on and off and read the
// code out of the captured message.

const mocks = vi.hoisted(() => ({
  sendMail: vi.fn(async (_opts: { to: string; subject: string }) => {}),
  mailConfigured: { value: true }
}));

vi.mock("../src/core/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/mail.js")>();
  return { ...actual, sendMail: mocks.sendMail, isMailConfigured: () => mocks.mailConfigured.value };
});

import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";

import { db } from "../src/db.js";
import { registerAuthDecorators } from "../src/auth.js";
import { authPlugin } from "../src/core/auth-routes.js";
import { mfaRoutes } from "../src/core/mfa-routes.js";
import { hashPassword } from "../src/crypto.js";
import { addTrustedNetwork, setSecurityPolicy, DEFAULT_SECURITY_POLICY } from "../src/core/security.js";
import { resetDb } from "./helpers/seed.js";

const EMAIL = "away@test.local";
const PASSWORD = "correct-horse-battery";

let app: FastifyInstance;

async function makeAccount(): Promise<void> {
  db.prepare(
    `INSERT INTO users (id, email, password_hash, display_name, role, is_active)
     VALUES ('u-away', ?, ?, 'Traveler', 'member', 1)`
  ).run(EMAIL, await hashPassword(PASSWORD));
}

function policyOn(): void {
  setSecurityPolicy({ ...DEFAULT_SECURITY_POLICY, requireMfaOutside: true }, null);
}

function login(headers: Record<string, string> = {}) {
  return app.inject({ method: "POST", url: "/api/auth/login", headers, payload: { email: EMAIL, password: PASSWORD } });
}

// The code leads the subject line ("123456 is your iSputnik code").
function lastMailedCode(): string {
  const call = mocks.sendMail.mock.calls.at(-1)?.[0];
  return call ? call.subject.split(" ")[0] : "";
}

function mfaCookie(res: { cookies: { name: string; value: string }[] }): string {
  return res.cookies.find((c) => c.name === "isputnik_mfa")?.value ?? "";
}

beforeEach(async () => {
  resetDb();
  db.prepare("DELETE FROM app_settings WHERE key = 'security_policy'").run();
  mocks.sendMail.mockClear();
  mocks.mailConfigured.value = true;
  app = Fastify();
  await app.register(cookie);
  await registerAuthDecorators(app);
  await app.register(authPlugin);
  await app.register(mfaRoutes);
  await app.ready();
  await makeAccount();
});

describe("requireMfaOutside", () => {
  it("changes nothing while the policy is off", async () => {
    const res = await login();
    expect(res.statusCode).toBe(200);
    expect(res.json().user.email).toBe(EMAIL);
  });

  it("emails a code to an un-enrolled account and completes the sign-in with it", async () => {
    policyOn();

    const res = await login();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ mfaRequired: true, method: "email", emailSent: true });

    await vi.waitFor(() => expect(mocks.sendMail).toHaveBeenCalled());
    const verified = await app.inject({
      method: "POST",
      url: "/api/auth/mfa/verify",
      cookies: { isputnik_mfa: mfaCookie(res) },
      payload: { token: lastMailedCode() }
    });
    expect(verified.statusCode).toBe(200);
    expect(verified.json().user.email).toBe(EMAIL);

    // The completed sign-in is recorded as a success, so the tally clears.
    const attempt = db
      .prepare("SELECT successful FROM login_attempts WHERE email = ? ORDER BY rowid DESC")
      .get(EMAIL) as { successful: number };
    expect(attempt.successful).toBe(1);
  });

  it("rejects a wrong code for the fallback challenge", async () => {
    policyOn();
    const res = await login();
    const verified = await app.inject({
      method: "POST",
      url: "/api/auth/mfa/verify",
      cookies: { isputnik_mfa: mfaCookie(res) },
      payload: { token: "000000" }
    });
    expect(verified.statusCode).toBe(401);
  });

  it("can resend the fallback code even though the account never enrolled", async () => {
    policyOn();
    const res = await login();
    await vi.waitFor(() => expect(mocks.sendMail).toHaveBeenCalled());

    // The resend cooldown is real; jump the challenge's last send into the past.
    db.prepare("UPDATE mfa_challenges SET last_sent_at = '2026-01-01T00:00:00.000Z'").run();
    const resend = await app.inject({
      method: "POST",
      url: "/api/auth/mfa/resend",
      cookies: { isputnik_mfa: mfaCookie(res) }
    });
    expect(resend.statusCode).toBe(200);
  });

  it("refuses the sign-in when mail is not configured, without touching the tallies", async () => {
    policyOn();
    mocks.mailConfigured.value = false;

    const res = await login();
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain("second factor");

    // The password was right — nothing may count against the account or the IP.
    expect(db.prepare("SELECT COUNT(*) AS n FROM login_attempts").get()).toEqual({ n: 0 });
    const log = db
      .prepare("SELECT detail FROM activity_logs WHERE event = 'auth.login_refused_mfa'")
      .get() as { detail: string } | undefined;
    expect(log?.detail).toContain(EMAIL);
  });

  it("keeps trusted networks password-only", async () => {
    policyOn();
    addTrustedNetwork("127.0.0.0/8", "test loopback", null);
    const res = await login();
    expect(res.statusCode).toBe(200);
    expect(res.json().user.email).toBe(EMAIL);
  });

  it("fails toward requiring the factor when a proxy hides the source", async () => {
    policyOn();
    // Trusted network or not: with a forwarded header and TRUST_PROXY_HOPS unset,
    // request.ip proves nothing, so the trusted match must not skip the factor.
    addTrustedNetwork("127.0.0.0/8", "test loopback", null);
    const res = await login({ "x-forwarded-for": "203.0.113.50" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ mfaRequired: true, method: "email" });
  });
});
