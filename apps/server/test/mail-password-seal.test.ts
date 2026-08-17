// The SMTP password is a stored operator secret sealed at rest (see mfa.sealSecret)
// so a leaked backup zip is inert. PUT /api/config/mail must: seal a freshly typed
// password, keep the stored one on a blank/omitted save WITHOUT re-sealing (no double
// layer), never echo the value back, and — the case this pins — MIGRATE a legacy
// plaintext password (configured before sealing existed) to sealed-at-rest on the
// next save, the same keep-path contract security-policy-key.test.ts holds for the
// AbuseIPDB key.
import { beforeEach, describe, expect, it } from "vitest";
import fastify, { type FastifyInstance } from "fastify";
import { db } from "../src/db.js";
import { mailPlugin } from "../src/core/mail-routes.js";
import { MAIL_SETTINGS_KEY, getMailSettings, getStoredMailPasswordRaw, type MailSettings } from "../src/core/mail.js";
import { resetDb, makeUser } from "./helpers/seed.js";

let app: FastifyInstance;

// A full, valid mail PUT body minus password (the caller adds it when present).
function mailBody(overrides: Record<string, unknown> = {}) {
  return {
    host: "smtp.example.com",
    port: 587,
    secure: false,
    username: "postmaster",
    fromAddress: "noreply@example.com",
    fromName: "isputnik",
    ...overrides
  };
}

async function put(body: Record<string, unknown>) {
  return app.inject({
    method: "PUT",
    url: "/api/config/mail",
    headers: { "x-test-user": "admin", "content-type": "application/json" },
    payload: JSON.stringify(body)
  });
}

// Seed the mail blob straight into app_settings — used to plant a LEGACY plaintext
// password (no enc:v1: prefix), i.e. one saved before sealing was introduced.
function seedRawMail(settings: Partial<MailSettings>) {
  const full: MailSettings = {
    host: "smtp.example.com",
    port: 587,
    secure: false,
    username: "postmaster",
    password: "",
    fromAddress: "noreply@example.com",
    fromName: "isputnik",
    ...settings
  };
  db.prepare(
    "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
  ).run(MAIL_SETTINGS_KEY, JSON.stringify(full));
}

beforeEach(async () => {
  resetDb();
  db.prepare("DELETE FROM app_settings WHERE key = ?").run(MAIL_SETTINGS_KEY);
  makeUser("admin", "admin");

  app = fastify();
  const auth = async (request: { headers: Record<string, unknown>; user?: unknown }, reply: { code: (n: number) => { send: (b: unknown) => void } }) => {
    const id = request.headers["x-test-user"] as string | undefined;
    const row = id ? (db.prepare("SELECT * FROM users WHERE id = ?").get(id) as Record<string, unknown> | undefined) : undefined;
    if (!row) { reply.code(401).send({ error: "Unauthenticated" }); return; }
    request.user = row;
  };
  app.decorate("authenticate", auth);
  app.decorate("requireAdmin", auth);
  await app.register(mailPlugin);
  await app.ready();
});

describe("SMTP password sealing", () => {
  it("seals a freshly typed password at rest and reads it back", async () => {
    const res = await put(mailBody({ password: "smtp-p@ss" }));
    expect(res.statusCode).toBe(200);

    const raw = getStoredMailPasswordRaw();
    expect(raw.startsWith("enc:v1:")).toBe(true);   // sealed, not plaintext
    expect(raw).not.toContain("smtp-p@ss");
    expect(getMailSettings().password).toBe("smtp-p@ss"); // round-trips

    // …and never leaves the server verbatim.
    expect(res.body).not.toContain("smtp-p@ss");
    expect(JSON.parse(res.body).mail).not.toHaveProperty("password");
    expect(JSON.parse(res.body).mail.hasPassword).toBe(true);
  });

  it("keeps the stored password on a blank/omitted save without double-sealing", async () => {
    await put(mailBody({ password: "smtp-p@ss" }));
    const rawBefore = getStoredMailPasswordRaw();

    // A save with no password field (e.g. editing the from-name) keeps the secret…
    await put(mailBody({ fromName: "Renamed" }));
    expect(getStoredMailPasswordRaw()).toBe(rawBefore); // byte-identical, single seal
    expect(getMailSettings().password).toBe("smtp-p@ss");

    // …and an explicit blank keeps it too (blank = keep, not clear).
    await put(mailBody({ password: "" }));
    expect(getStoredMailPasswordRaw()).toBe(rawBefore);
    expect(getMailSettings().password).toBe("smtp-p@ss");
  });

  it("migrates a legacy plaintext password to sealed-at-rest on the next save", async () => {
    // An install configured before sealing existed has the password stored in the
    // clear. A routine keep-save (no password field) must upgrade it in place — it
    // reads back the same, but the raw column is now sealed so a backup zip is inert.
    seedRawMail({ password: "legacy-plaintext-pw" });
    expect(getStoredMailPasswordRaw()).toBe("legacy-plaintext-pw"); // plaintext to start

    await put(mailBody({ fromName: "Touch" })); // no password field → keep path

    const raw = getStoredMailPasswordRaw();
    expect(raw.startsWith("enc:v1:")).toBe(true);   // now sealed
    expect(raw).not.toContain("legacy-plaintext-pw");
    expect(getMailSettings().password).toBe("legacy-plaintext-pw"); // still reads
  });

  it("seals a fresh password that literally starts with the seal prefix", async () => {
    // "enc:v1:…" typed as an actual password must be sealed, not stored verbatim as
    // if already-sealed — else it would read back empty (decrypt fails) and sit in a
    // backup in the clear.
    const res = await put(mailBody({ password: "enc:v1:not-really-sealed" }));
    expect(res.statusCode).toBe(200);
    expect(getStoredMailPasswordRaw()).not.toBe("enc:v1:not-really-sealed"); // actually encrypted
    expect(getMailSettings().password).toBe("enc:v1:not-really-sealed");     // round-trips
  });
});
