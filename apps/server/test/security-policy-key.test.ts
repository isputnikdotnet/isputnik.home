// The AbuseIPDB API key is a stored secret. GET /api/security must report only
// whether one is set (hasAbuseIpdbKey), never the value, and a policy save that
// omits or blanks the key must keep the stored one — the same contract the SMTP
// password follows. These pin that.
import { beforeEach, describe, expect, it } from "vitest";
import fastify, { type FastifyInstance } from "fastify";
import { db } from "../src/db.js";
import { securityRoutes } from "../src/core/security-routes.js";
import { getSecurityPolicy, getStoredAbuseIpdbKeyRaw, DEFAULT_SECURITY_POLICY } from "../src/core/security.js";
import { resetDb, makeUser } from "./helpers/seed.js";

let app: FastifyInstance;

// A full, valid policy PATCH body, minus abuseIpdbKey (which the caller adds).
function policyBody(overrides: Record<string, unknown> = {}) {
  const { abuseIpdbKey: _omit, ...rest } = DEFAULT_SECURITY_POLICY;
  return { ...rest, ...overrides };
}

async function patch(body: Record<string, unknown>) {
  return app.inject({
    method: "PATCH",
    url: "/api/security/policy",
    headers: { "x-test-user": "admin", "content-type": "application/json" },
    payload: JSON.stringify(body)
  });
}

beforeEach(async () => {
  resetDb();
  db.prepare("DELETE FROM app_settings WHERE key = 'security_policy'").run();
  makeUser("admin", "admin");

  app = fastify();
  const auth = async (request: { headers: Record<string, unknown>; user?: unknown }, reply: { code: (n: number) => { send: (b: unknown) => void } }) => {
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

describe("AbuseIPDB key is never echoed", () => {
  it("GET reports only presence, not the value", async () => {
    const res = await app.inject({ method: "GET", url: "/api/security", headers: { "x-test-user": "admin" } });
    const body = JSON.parse(res.body);
    expect(body.policy.hasAbuseIpdbKey).toBe(false);
    expect(body.policy).not.toHaveProperty("abuseIpdbKey");
    expect(res.body).not.toContain("abuseIpdbKey");
  });

  it("stores a submitted key but reflects it back only as hasAbuseIpdbKey", async () => {
    const res = await patch(policyBody({ abuseIpdbKey: "secret-key-123" }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.policy.hasAbuseIpdbKey).toBe(true);
    expect(body.policy).not.toHaveProperty("abuseIpdbKey");
    // …but it really is stored server-side.
    expect(getSecurityPolicy().abuseIpdbKey).toBe("secret-key-123");
  });

  it("keeps the stored key when a later save omits or blanks it", async () => {
    await patch(policyBody({ abuseIpdbKey: "secret-key-123" }));

    // A threshold-style save with no key field at all.
    await patch(policyBody({ lockoutThreshold: 9 }));
    expect(getSecurityPolicy().abuseIpdbKey).toBe("secret-key-123");
    expect(getSecurityPolicy().lockoutThreshold).toBe(9);

    // An explicit blank must not wipe it either.
    await patch(policyBody({ abuseIpdbKey: "" }));
    expect(getSecurityPolicy().abuseIpdbKey).toBe("secret-key-123");
  });

  it("replaces the key when a new non-blank one is sent", async () => {
    await patch(policyBody({ abuseIpdbKey: "old-key" }));
    await patch(policyBody({ abuseIpdbKey: "new-key" }));
    expect(getSecurityPolicy().abuseIpdbKey).toBe("new-key");
  });

  it("seals a fresh key that literally starts with the seal prefix (no false-positive passthrough)", async () => {
    // "enc:v1:..." must be sealed, not stored verbatim as if already-sealed — else
    // it would read back empty (decrypt fails) and leak plaintext in a backup.
    const res = await patch(policyBody({ abuseIpdbKey: "enc:v1:tricky-key" }));
    expect(res.statusCode).toBe(200);
    expect(getStoredAbuseIpdbKeyRaw()).not.toBe("enc:v1:tricky-key"); // actually encrypted, not verbatim
    expect(getSecurityPolicy().abuseIpdbKey).toBe("enc:v1:tricky-key"); // round-trips
  });

  it("clears the key on an explicit clearAbuseIpdbKey", async () => {
    await patch(policyBody({ abuseIpdbKey: "secret-key-123" }));
    await patch(policyBody({ clearAbuseIpdbKey: true }));
    expect(getSecurityPolicy().abuseIpdbKey).toBe("");
  });

  it("preserves the sealed key across a blank save without re-sealing it", async () => {
    await patch(policyBody({ abuseIpdbKey: "secret-key-123" }));
    // A blank save must keep the RAW stored ciphertext, not re-seal an opened
    // value — the raw column stays a single-layer seal that still opens cleanly.
    const rawBefore = getStoredAbuseIpdbKeyRaw();
    await patch(policyBody({ lockoutThreshold: 7 }));
    expect(getStoredAbuseIpdbKeyRaw()).toBe(rawBefore); // byte-identical, not double-sealed
    expect(getSecurityPolicy().abuseIpdbKey).toBe("secret-key-123");
  });
});
