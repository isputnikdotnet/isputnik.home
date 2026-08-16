import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/core/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/mail.js")>();
  return { ...actual, sendMail: vi.fn(async () => {}), isMailConfigured: () => false };
});

import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";

import { db } from "../src/db.js";
import { issueSession, registerAuthDecorators } from "../src/auth.js";
import { usersPlugin } from "../src/modules/users/users.js";
import { isAccountLocked, recordLoginAttempt } from "../src/core/security.js";
import { verifyPassword } from "../src/crypto.js";
import { makeUser, resetDb } from "./helpers/seed.js";

// Deleting an account is a soft delete, and failed sign-ins are counted per email
// rather than per account. Both outlive the account, and together they used to
// strand an admin: the address stayed reserved by a row nothing on screen showed,
// and a lockout followed the address across a password reset and a delete.

const PASSWORD = "correct-horse-battery";
const RECRUIT = "recruit@test.local";

let app: FastifyInstance;

async function buildApp(): Promise<FastifyInstance> {
  const instance = Fastify();
  await instance.register(cookie);
  await registerAuthDecorators(instance);
  await instance.register(usersPlugin);

  instance.post("/test/sign-in/:userId", async (request, reply) => {
    const { userId } = request.params as { userId: string };
    issueSession(reply, userId, request);
    return reply.send({ ok: true });
  });

  await instance.ready();
  return instance;
}

function cookieFrom(headers: Record<string, unknown>): string {
  const raw = headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : [String(raw)];
  const found = list.find((entry) => entry.startsWith("isputnik_sid="));
  if (!found) throw new Error("no session cookie was set");
  return found.split(";")[0];
}

async function signIn(userId: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: `/test/sign-in/${userId}` });
  return cookieFrom(res.headers as Record<string, unknown>);
}

function createRecruit(admin: string, displayName = "New Recruit") {
  return app.inject({
    method: "POST",
    url: "/api/users",
    headers: { cookie: admin },
    payload: { email: RECRUIT, displayName, password: PASSWORD, role: "member" }
  });
}

// Enough failures to cross the default threshold of five.
function failSignIns(email: string, count = 5): void {
  for (let i = 0; i < count; i += 1) recordLoginAttempt(email, "203.0.113.10", false);
}

beforeEach(async () => {
  resetDb();
  makeUser("boss", "admin");
  app = await buildApp();
});

describe("re-creating an account with a deleted account's email", () => {
  it("takes over the deleted row instead of refusing the address", async () => {
    const admin = await signIn("boss");
    const first = await createRecruit(admin);
    const id = first.json().user.id as string;

    const deleted = await app.inject({ method: "DELETE", url: `/api/users/${id}`, headers: { cookie: admin } });
    expect(deleted.statusCode).toBe(200);

    const again = await createRecruit(admin, "Someone Else");
    expect(again.statusCode).toBe(201);
    expect(again.json()).toMatchObject({ restored: true });
    expect(again.json().user).toMatchObject({ id, displayName: "Someone Else", isActive: true });

    // One row, live again — not a second one alongside the tombstone.
    const rows = db.prepare("SELECT id, deleted_at FROM users WHERE email = ?").all(RECRUIT) as {
      id: string;
      deleted_at: string | null;
    }[];
    expect(rows).toEqual([{ id, deleted_at: null }]);
  });

  it("opens to the new password and not the one it replaced", async () => {
    const admin = await signIn("boss");
    const id = (await createRecruit(admin)).json().user.id as string;
    await app.inject({ method: "DELETE", url: `/api/users/${id}`, headers: { cookie: admin } });

    await app.inject({
      method: "POST",
      url: "/api/users",
      headers: { cookie: admin },
      payload: { email: RECRUIT, displayName: "Someone Else", password: "a-second-password", role: "member" }
    });

    const { password_hash: hash } = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(id) as {
      password_hash: string;
    };
    expect(await verifyPassword("a-second-password", hash)).toBe(true);
    expect(await verifyPassword(PASSWORD, hash)).toBe(false);
  });

  it("drops the old account's second factor and passkeys with it", async () => {
    const admin = await signIn("boss");
    const id = (await createRecruit(admin)).json().user.id as string;
    db.prepare("UPDATE users SET mfa_enabled = 1, mfa_secret = 'kept' WHERE id = ?").run(id);
    await app.inject({ method: "DELETE", url: `/api/users/${id}`, headers: { cookie: admin } });

    await createRecruit(admin);

    expect(db.prepare("SELECT mfa_enabled, mfa_secret FROM users WHERE id = ?").get(id)).toMatchObject({
      mfa_enabled: 0,
      mfa_secret: null
    });
  });

  it("still refuses an email a live account is using", async () => {
    const admin = await signIn("boss");
    await createRecruit(admin);

    const again = await createRecruit(admin);
    expect(again.statusCode).toBe(409);
  });
});

describe("a lockout outliving the account it locked", () => {
  it("is cleared when an admin sets a new password", async () => {
    const admin = await signIn("boss");
    const id = (await createRecruit(admin)).json().user.id as string;
    failSignIns(RECRUIT);
    expect(isAccountLocked(RECRUIT)).toBe(true);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/users/${id}/password`,
      headers: { cookie: admin },
      payload: { password: "a-brand-new-password" }
    });

    expect(res.statusCode).toBe(200);
    expect(isAccountLocked(RECRUIT)).toBe(false);
  });

  it("does not follow the email into the account that replaces it", async () => {
    const admin = await signIn("boss");
    const id = (await createRecruit(admin)).json().user.id as string;
    failSignIns(RECRUIT);

    await app.inject({ method: "DELETE", url: `/api/users/${id}`, headers: { cookie: admin } });
    expect(isAccountLocked(RECRUIT)).toBe(false);

    failSignIns(RECRUIT);
    await createRecruit(admin);
    expect(isAccountLocked(RECRUIT)).toBe(false);
  });
});
