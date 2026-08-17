// The audiobook playback-progress routes key on the :id book but were gated only
// on `authenticate`. They only ever touch the caller's own progress rows, so no
// other user's data leaked — but a signed-in member could confirm a private
// book's id and create/read/delete progress against a book they can't see. These
// pin the access gate (404 for an outsider, works for a member).
import { beforeEach, describe, expect, it } from "vitest";
import fastify, { type FastifyInstance } from "fastify";
import { db } from "../src/db.js";
import { registerBookRoutes } from "../src/modules/library/audiobook/books-routes.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { resetDb, makeUser, grant } from "./helpers/seed.js";

let app: FastifyInstance;

function makeAudiobook(id: string, libraryId: string): void {
  db.prepare(
    "INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES (?, ?, 'audiobook', ?, 'ready')"
  ).run(id, libraryId, id);
  db.prepare("INSERT INTO audiobook_details (item_id, duration_seconds) VALUES (?, 3600)").run(id);
  db.prepare(
    "INSERT INTO audio_files (id, item_id, relative_path, track_number, duration_seconds, status) VALUES (?, ?, 'track1.mp3', 1, 3600, 'available')"
  ).run(`${id}-f1`, id);
}

async function req(method: string, url: string, user: string, body?: unknown) {
  const res = await app.inject({
    method: method as "GET",
    url,
    headers: { "x-test-user": user, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { payload: JSON.stringify(body) } : {})
  });
  return res.statusCode;
}

beforeEach(async () => {
  resetDb();
  makeUser("owner");
  makeUser("member");
  makeUser("outsider");
  // A private library (Everyone denied by absence), the member granted in.
  db.prepare(
    "INSERT INTO libraries (id, name, type, source_path, created_by, policy_json) VALUES ('AUD', 'AUD', 'audiobook', '/src/AUD', 'owner', '{}')"
  ).run();
  grant("user", "member", "AUD", "member");
  makeAudiobook("book1", "AUD");

  app = fastify();
  app.decorate("authenticate", async (request, reply) => {
    const id = request.headers["x-test-user"] as string | undefined;
    const row = id
      ? (db.prepare("SELECT id, role FROM users WHERE id = ?").get(id) as { id: string; role: string } | undefined)
      : undefined;
    if (!row) {
      reply.code(401).send({ error: "Unauthenticated" });
      return;
    }
    request.user = row as never;
  });
  registerBookRoutes(app);
  await app.ready();
});

describe("playback-progress routes reject users without book access", () => {
  it("404s every progress route for an outsider", async () => {
    expect(await req("GET", "/api/library/books/book1/progress", "outsider")).toBe(404);
    expect(await req("GET", "/api/library/books/book1/tracks/progress", "outsider")).toBe(404);
    expect(await req("DELETE", "/api/library/books/book1/progress", "outsider")).toBe(404);
    expect(await req("POST", "/api/library/books/book1/progress/complete", "outsider")).toBe(404);
    expect(await req("PATCH", "/api/library/books/book1/progress", "outsider", { fileId: "book1-f1", positionSeconds: 5 })).toBe(404);

    // The outsider wrote no rows — the gate ran before any INSERT.
    const rows = db.prepare("SELECT COUNT(*) AS n FROM playback_progress WHERE item_id = 'book1'").get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it("lets a member with access read and write progress", async () => {
    expect(await req("GET", "/api/library/books/book1/progress", "member")).toBe(200);
    expect(await req("PATCH", "/api/library/books/book1/progress", "member", { fileId: "book1-f1", positionSeconds: 5 })).toBe(200);
    const rows = db.prepare("SELECT COUNT(*) AS n FROM playback_progress WHERE item_id = 'book1' AND user_id = 'member'").get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it("404s a nonexistent book id too, so it can't be used to probe", async () => {
    expect(await req("GET", "/api/library/books/nope/progress", "member")).toBe(404);
  });
});
