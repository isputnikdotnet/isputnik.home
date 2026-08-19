// Changing the login email was password-only, so a stolen password plus a live
// session could repoint it — and for the email MFA method, that's where sign-in
// codes are delivered. While MFA is on, /api/profile/email now also requires a
// current second factor. A user without MFA is unaffected. These pin both.
import { beforeEach, describe, expect, it } from "vitest";
import fastify, { type FastifyInstance } from "fastify";
import { totpCode } from "./helpers/totp.js";
import { db, type User } from "../src/db.js";
import { hashPassword } from "../src/crypto.js";
import { beginMfaSetup, activateMfa } from "../src/core/mfa-routes.js";
import { profilePlugin } from "../src/modules/users/profile.js";
import { resetDb, makeUser } from "./helpers/seed.js";

let app: FastifyInstance;
let totpSecret = "";

async function patchEmail(user: string, body: Record<string, unknown>) {
  const res = await app.inject({
    method: "PATCH",
    url: "/api/profile/email",
    headers: { "x-test-user": user, "content-type": "application/json" },
    payload: JSON.stringify(body)
  });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

function emailOf(userId: string): string {
  return (db.prepare("SELECT email FROM users WHERE id = ?").get(userId) as { email: string }).email;
}

beforeEach(async () => {
  resetDb();
  makeUser("mfauser");
  makeUser("plainuser");
  const hash = await hashPassword("correct-horse");
  db.prepare("UPDATE users SET email = 'mfa@test.local', password_hash = ? WHERE id = 'mfauser'").run(hash);
  db.prepare("UPDATE users SET email = 'plain@test.local', password_hash = ? WHERE id = 'plainuser'").run(hash);
  const setup = beginMfaSetup("mfauser", "totp");
  if (setup.method !== "totp") throw new Error("expected totp");
  totpSecret = setup.secret;
  if (!activateMfa("mfauser", totpCode(setup.secret))) throw new Error("activation failed");

  app = fastify();
  app.decorate("authenticate", async (request, reply) => {
    const id = request.headers["x-test-user"] as string | undefined;
    const row = id ? (db.prepare("SELECT * FROM users WHERE id = ?").get(id) as User | undefined) : undefined;
    if (!row) { reply.code(401).send({ error: "no" }); return; }
    request.user = row;
  });
  await app.register(profilePlugin);
  await app.ready();
});

describe("changing the login email with MFA on requires a second factor", () => {
  it("400s the right password but no code", async () => {
    const { status, body } = await patchEmail("mfauser", { currentPassword: "correct-horse", newEmail: "new@test.local" });
    expect(status).toBe(400);
    expect(body.needsSecondFactor).toBe(true);
    expect(emailOf("mfauser")).toBe("mfa@test.local");
  });

  it("403s a wrong code", async () => {
    const { status } = await patchEmail("mfauser", { currentPassword: "correct-horse", newEmail: "new@test.local", code: "000000" });
    expect(status).toBe(403);
    expect(emailOf("mfauser")).toBe("mfa@test.local");
  });

  it("changes the email with password + a valid authenticator code", async () => {
    const { status } = await patchEmail("mfauser", {
      currentPassword: "correct-horse",
      newEmail: "new@test.local",
      code: totpCode(totpSecret)
    });
    expect(status).toBe(200);
    expect(emailOf("mfauser")).toBe("new@test.local");
  });

  it("does not demand a code for a no-op (same address)", async () => {
    const { status } = await patchEmail("mfauser", { currentPassword: "correct-horse", newEmail: "mfa@test.local" });
    expect(status).toBe(200);
  });
});

describe("a user without MFA still changes email with just the password", () => {
  it("succeeds with no code", async () => {
    const { status } = await patchEmail("plainuser", { currentPassword: "correct-horse", newEmail: "moved@test.local" });
    expect(status).toBe(200);
    expect(emailOf("plainuser")).toBe("moved@test.local");
  });
});
