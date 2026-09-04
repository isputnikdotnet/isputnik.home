// The log row a share link actually produces, driven through the route.
//
// The unit tests beside this one cover optionalUser; what they cannot show is the
// part the whole feature rests on — that a signed-in visitor's cookie reaches a
// route with no preHandler at all, and that the resulting activity_logs row
// carries their name. The share page is same-origin and the session cookie is
// SameSite=lax, so it does; this holds the wiring to it.
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { sha256 } from "../src/crypto.js";
import { librarySharesPlugin } from "../src/modules/library/shared/shares.js";
import { registerAuthDecorators } from "../src/auth.js";
import { resetDb, makeUser, makeLibrary, futureIso } from "./helpers/seed.js";

const TOKEN = "a-share-token";
const ITEM = "item-1";
let app: FastifyInstance;

function openShare(cookieHeader?: string) {
  return app.inject({
    method: "GET",
    url: `/api/share/${TOKEN}`,
    headers: cookieHeader ? { cookie: cookieHeader } : {},
    remoteAddress: "203.0.113.7"
  });
}

const accessRow = () =>
  db.prepare(
    "SELECT actor_user_id, ip_address, detail FROM activity_logs WHERE event = 'share.accessed' ORDER BY rowid DESC"
  ).get() as { actor_user_id: string | null; ip_address: string | null; detail: string } | undefined;

beforeEach(async () => {
  resetDb();
  makeUser("owner", "admin");
  makeUser("viewer");
  makeLibrary("lib-1", { createdBy: "owner", type: "audiobook" });

  db.prepare("INSERT INTO library_items (id, library_id, type, folder_path) VALUES (?, 'lib-1', 'audiobook', '/media/books/x')").run(ITEM);
  db.prepare("INSERT INTO item_metadata (item_id, title) VALUES (?, 'The Book')").run(ITEM);
  db.prepare(
    "INSERT INTO share_links (id, module, resource_id, token_hash, expires_at, created_by) VALUES ('link-1', 'audiobook', ?, ?, ?, 'owner')"
  ).run(ITEM, sha256(TOKEN), futureIso());

  app = Fastify();
  await app.register(cookie);
  await registerAuthDecorators(app);
  await app.register(librarySharesPlugin);
  await app.ready();
});

afterEach(async () => {
  await app?.close();
});

describe("who opened a shared thing", () => {
  it("records a signed-in visitor by name", () => {
    db.prepare(
      "INSERT INTO sessions (id, token_hash, user_id, expires_at) VALUES ('s1', ?, 'viewer', ?)"
    ).run(sha256("session-token"), futureIso());

    return openShare("isputnik_sid=session-token").then((res) => {
      expect(res.statusCode).toBe(200);
      const row = accessRow();
      expect(row?.actor_user_id).toBe("viewer");
      expect(row?.detail).toContain("The Book");
    });
  });

  it("records an anonymous visitor by address alone", async () => {
    const res = await openShare();

    expect(res.statusCode).toBe(200);
    const row = accessRow();
    expect(row?.actor_user_id).toBeNull();
    expect(row?.ip_address).toBe("203.0.113.7");
  });

  it("still serves a visitor whose session has expired, just without a name", async () => {
    // The link authenticates nobody: a stale cookie must never turn into a refusal.
    db.prepare(
      "INSERT INTO sessions (id, token_hash, user_id, expires_at) VALUES ('s2', ?, 'viewer', '2020-01-01T00:00:00.000Z')"
    ).run(sha256("stale-token"));

    const res = await openShare("isputnik_sid=stale-token");

    expect(res.statusCode).toBe(200);
    expect(accessRow()?.actor_user_id).toBeNull();
  });

  it("does not mark the visit as the account being used", async () => {
    // last_seen_at drives "devices still signed in". A share link must not keep a
    // session looking alive — see the note on optionalUser.
    db.prepare(
      "INSERT INTO sessions (id, token_hash, user_id, expires_at, last_seen_at) VALUES ('s3', ?, 'viewer', ?, '2020-01-01T00:00:00.000Z')"
    ).run(sha256("session-token"), futureIso());

    await openShare("isputnik_sid=session-token");

    const seen = db.prepare("SELECT last_seen_at FROM sessions WHERE id = 's3'").get() as { last_seen_at: string };
    expect(seen.last_seen_at).toBe("2020-01-01T00:00:00.000Z");
  });
});
