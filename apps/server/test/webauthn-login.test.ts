import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";

// The ceremony crypto is simplewebauthn's job and is tested upstream. What matters
// here is OUR branching around its verdict: which failures feed the lockout, which
// count as abuse, and that a verified sign-in really does skip the second factor.
// So the library is stubbed and each test states the verdict it wants.
const verdict: { value: unknown; throws: boolean } = { value: null, throws: false };

vi.mock("@simplewebauthn/server", () => ({
  generateRegistrationOptions: vi.fn(async () => ({ challenge: "register-challenge" })),
  verifyRegistrationResponse: vi.fn(async () => ({ verified: false })),
  generateAuthenticationOptions: vi.fn(async () => ({ challenge: "login-challenge" })),
  verifyAuthenticationResponse: vi.fn(async () => {
    if (verdict.throws) throw new Error("signature mismatch");
    return verdict.value;
  })
}));

const { db } = await import("../src/db.js");
const { config } = await import("../src/config.js");
const { insertPasskey } = await import("../src/core/webauthn.js");
const { webauthnRoutes } = await import("../src/core/webauthn-routes.js");
const { resetDb, makeUser } = await import("./helpers/seed.js");

const realAppUrl = config.appUrl;
let app: FastifyInstance;

const PASSKEY = {
  credentialId: "cred-aaa",
  publicKey: "cHVibGljLWtleQ",
  counter: 0,
  transports: null,
  backedUp: true
};

function accepted(overrides: Record<string, unknown> = {}) {
  return {
    verified: true,
    authenticationInfo: {
      credentialID: "cred-aaa",
      newCounter: 1,
      userVerified: true,
      credentialDeviceType: "multiDevice",
      credentialBackedUp: true,
      origin: "https://library.example.com",
      rpID: "library.example.com",
      ...overrides
    }
  };
}

beforeEach(async () => {
  resetDb();
  config.appUrl = "https://library.example.com";
  verdict.value = accepted();
  verdict.throws = false;

  makeUser("u1");
  // Two-factor is ON for this account throughout: the point of a passkey sign-in is
  // that it is already two factors, so none of these tests should ever see a code step.
  db.prepare("UPDATE users SET mfa_enabled = 1, email = 'owner@test.local' WHERE id = 'u1'").run();
  insertPasskey("u1", "iPhone", PASSKEY);

  app = fastify();
  await app.register(cookie);
  // The profile half of the plugin is gated on it; the sign-in routes under test
  // are deliberately anonymous.
  app.decorate("authenticate", async () => {});
  await app.register(webauthnRoutes);
  await app.ready();
});

afterEach(async () => {
  config.appUrl = realAppUrl;
  await app.close();
});

/** Run the sign-in ceremony: open a challenge, then present an assertion. */
async function signIn(credentialId = "cred-aaa") {
  const options = await app.inject({ method: "POST", url: "/api/auth/passkey/options", payload: {} });
  const challengeCookie = options.cookies.find((c) => c.name === "isputnik_pk_login");
  return app.inject({
    method: "POST",
    url: "/api/auth/passkey/verify",
    cookies: { isputnik_pk_login: String(challengeCookie?.value) },
    payload: { response: { id: credentialId } }
  });
}

const failedAttempts = (email: string) =>
  (db.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE email = ? AND successful = 0").get(email) as { n: number }).n;

const sessionCount = () =>
  (db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n;

const logged = (event: string) =>
  (db.prepare("SELECT COUNT(*) AS n FROM activity_logs WHERE event = ?").get(event) as { n: number }).n;

describe("passkey sign-in", () => {
  it("issues a session and skips the second factor", async () => {
    const response = await signIn();

    expect(response.statusCode).toBe(200);
    expect(sessionCount()).toBe(1);
    expect(logged("auth.passkey_login")).toBe(1);
    // No MFA challenge was opened even though the account has two-factor on.
    expect(db.prepare("SELECT COUNT(*) AS n FROM mfa_challenges").get()).toEqual({ n: 0 });
    // A completed sign-in, so it clears the failure tally like a password success.
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE successful = 1").get()
    ).toEqual({ n: 1 });
  });

  it("records the device and the address it was used from", async () => {
    await signIn();
    const row = db.prepare("SELECT counter, last_used_at, last_ip FROM webauthn_credentials").get() as {
      counter: number;
      last_used_at: string | null;
      last_ip: string | null;
    };
    expect(row.counter).toBe(1);
    expect(row.last_used_at).not.toBeNull();
    expect(row.last_ip).not.toBeNull();
  });

  it("refuses a signature that doesn't verify, and counts it against the account", async () => {
    verdict.throws = true;
    const response = await signIn();

    expect(response.statusCode).toBe(401);
    expect(sessionCount()).toBe(0);
    expect(failedAttempts("owner@test.local")).toBe(1);
  });

  it("refuses a valid signature the device didn't verify the user for", async () => {
    // A bare presence tap is one factor. Accepting it would quietly turn the
    // skip-the-code promise into a single-factor sign-in.
    verdict.value = accepted({ userVerified: false });
    const response = await signIn();

    expect(response.statusCode).toBe(401);
    expect(response.json().error).toMatch(/didn't confirm it was you/i);
    expect(sessionCount()).toBe(0);
    expect(failedAttempts("owner@test.local")).toBe(1);
  });

  it("treats an unregistered credential as a guess, not a failed sign-in", async () => {
    const response = await signIn("cred-unknown");

    expect(response.statusCode).toBe(401);
    expect(sessionCount()).toBe(0);
    // It counts toward the per-IP block as an anonymous abuse hit, and against no
    // account — there is no account to blame for a credential nobody owns.
    expect(failedAttempts("owner@test.local")).toBe(0);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE email IS NULL").get()
    ).toEqual({ n: 1 });
  });

  it("won't sign in a deactivated account", async () => {
    db.prepare("UPDATE users SET is_active = 0 WHERE id = 'u1'").run();
    const response = await signIn();

    expect(response.statusCode).toBe(401);
    expect(sessionCount()).toBe(0);
  });

  it("refuses without a live challenge, so an assertion can't be replayed", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/passkey/verify",
      payload: { response: { id: "cred-aaa" } }
    });
    expect(response.statusCode).toBe(401);
    expect(sessionCount()).toBe(0);
  });

  it("burns the challenge, so the same one can't be used twice", async () => {
    const options = await app.inject({ method: "POST", url: "/api/auth/passkey/options", payload: {} });
    const value = String(options.cookies.find((c) => c.name === "isputnik_pk_login")?.value);
    const send = () =>
      app.inject({
        method: "POST",
        url: "/api/auth/passkey/verify",
        cookies: { isputnik_pk_login: value },
        payload: { response: { id: "cred-aaa" } }
      });

    expect((await send()).statusCode).toBe(200);
    expect((await send()).statusCode).toBe(401);
    expect(sessionCount()).toBe(1);
  });

  it("notes a counter that didn't advance without blocking the sign-in", async () => {
    db.prepare("UPDATE webauthn_credentials SET counter = 9").run();
    verdict.value = accepted({ newCounter: 4 });
    const response = await signIn();

    // Still a good signature from a key we know, so the user gets in — but the one
    // thing the counter exists to flag is on the record.
    expect(response.statusCode).toBe(200);
    expect(logged("auth.passkey_counter_regressed")).toBe(1);
  });

  it("stops a locked-out account before the ceremony is even checked", async () => {
    for (let i = 0; i < 20; i += 1) {
      db.prepare(
        "INSERT INTO login_attempts (id, email, ip_address, successful) VALUES (?, 'owner@test.local', '127.0.0.1', 0)"
      ).run(`a${i}`);
    }
    const response = await signIn();

    expect(response.statusCode).toBe(429);
    expect(sessionCount()).toBe(0);
  });
});

describe("an install that can't do passkeys", () => {
  it("answers 501 rather than starting a ceremony that could only fail", async () => {
    config.appUrl = "http://192.168.1.50:4000";
    const response = await app.inject({ method: "POST", url: "/api/auth/passkey/options", payload: {} });
    expect(response.statusCode).toBe(501);
  });
});
