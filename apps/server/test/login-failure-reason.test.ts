import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/core/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/mail.js")>();
  return { ...actual, sendMail: vi.fn(async () => {}), isMailConfigured: () => false };
});

import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";

import { db } from "../src/db.js";
import { registerAuthDecorators } from "../src/auth.js";
import { authPlugin } from "../src/core/auth-routes.js";
import { hashPassword } from "../src/crypto.js";
import { resetDb } from "./helpers/seed.js";

// A wrong password and a mistyped email give the browser the same answer, on purpose.
// They must not look the same to an admin reading the activity log: the lockout is
// keyed on the address that was typed, so a transposed letter locks out an email the
// user list has no row for — which reads, for days, as a password that won't work.

const REAL = "larrisam@minskcity.com";
const TYPO = "larissam@minskcity.com";
const PASSWORD = "correct-horse-battery";

let app: FastifyInstance;

async function makeAccount(email: string, opts: { active?: boolean; deleted?: boolean } = {}): Promise<void> {
  db.prepare(
    `INSERT INTO users (id, email, password_hash, display_name, role, is_active, deleted_at)
     VALUES (?, ?, ?, ?, 'member', ?, ?)`
  ).run(
    `id-${email}`,
    email,
    await hashPassword(PASSWORD),
    "Larissa",
    opts.active === false || opts.deleted ? 0 : 1,
    opts.deleted ? "2026-08-16T00:00:00.000Z" : null
  );
}

function attempt(email: string, password = PASSWORD) {
  return app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
}

function lastFailureDetail(): string {
  const row = db
    .prepare("SELECT detail FROM activity_logs WHERE event = 'auth.login_failed' ORDER BY rowid DESC")
    .get() as { detail: string } | undefined;
  return row?.detail ?? "";
}

beforeEach(async () => {
  resetDb();
  app = Fastify();
  await app.register(cookie);
  await registerAuthDecorators(app);
  await app.register(authPlugin);
  await app.ready();
});

describe("what the log says about a failed sign-in", () => {
  it("names a typo for what it is", async () => {
    await makeAccount(REAL);

    const res = await attempt(TYPO);

    expect(res.statusCode).toBe(401);
    expect(lastFailureDetail()).toContain(TYPO);
    expect(lastFailureDetail()).toContain("there is no account with that address");
  });

  it("calls a wrong password a wrong password", async () => {
    await makeAccount(REAL);

    await attempt(REAL, "not-the-password");

    expect(lastFailureDetail()).toContain("wrong password");
  });

  it("says when the account behind the address was deleted", async () => {
    await makeAccount(REAL, { deleted: true });

    await attempt(REAL);

    expect(lastFailureDetail()).toContain("that account was deleted");
  });

  it("says when the account is deactivated", async () => {
    await makeAccount(REAL, { active: false });

    await attempt(REAL);

    expect(lastFailureDetail()).toContain("the account is deactivated");
  });

  it("still tells the browser nothing", async () => {
    await makeAccount(REAL);

    const typo = await attempt(TYPO);
    const wrong = await attempt(REAL, "not-the-password");

    // The whole point of the split: the reason is for the log, never the response.
    expect(typo.json()).toEqual({ error: "Invalid email or password" });
    expect(wrong.json()).toEqual(typo.json());
  });
});
