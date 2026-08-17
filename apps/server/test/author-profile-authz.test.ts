// People (authors/narrators) are global rows shared across every book library.
// The by-name profile-write routes were gated only on `authenticate`, so any
// signed-in member — including a viewer with no write access anywhere — could
// rename an author, overwrite their bio, or replace their photo globally. These
// pin the write gate: a viewer is refused, a writer (or admin) gets through.
import { beforeEach, describe, expect, it } from "vitest";
import fastify, { type FastifyInstance } from "fastify";
import { db } from "../src/db.js";
import { audiobookPeoplePlugin } from "../src/modules/library/audiobook/people.js";
import { resetDb, makeUser, grant } from "./helpers/seed.js";

let app: FastifyInstance;

async function renameAuthor(user: string, from = "Jane Author", to = "Renamed") {
  const res = await app.inject({
    method: "PATCH",
    url: `/api/library/people/by-name?name=${encodeURIComponent(from)}`,
    headers: { "x-test-user": user, "content-type": "application/json" },
    payload: JSON.stringify({ name: to })
  });
  return res.statusCode;
}

beforeEach(async () => {
  resetDb();
  makeUser("viewer");
  makeUser("writer");
  makeUser("admin", "admin");
  // A book library the writer can edit; the viewer only reads it.
  db.prepare(
    "INSERT INTO libraries (id, name, type, source_path, created_by, policy_json) VALUES ('AUD', 'AUD', 'audiobook', '/src', 'writer', '{}')"
  ).run();
  grant("user", "writer", "AUD", "contributor");
  grant("user", "viewer", "AUD", "viewer");
  db.prepare("INSERT INTO people (id, name, sort_name) VALUES ('p1', 'Jane Author', 'Author, Jane')").run();

  app = fastify();
  app.decorate("authenticate", async (request, reply) => {
    const id = request.headers["x-test-user"] as string | undefined;
    const row = id ? (db.prepare("SELECT id, role FROM users WHERE id = ?").get(id) as { id: string; role: string } | undefined) : undefined;
    if (!row) { reply.code(401).send({ error: "no" }); return; }
    request.user = row as never;
  });
  await app.register(audiobookPeoplePlugin);
  await app.ready();
});

describe("author-profile write routes require write access to a book library", () => {
  it("403s a viewer-only member", async () => {
    expect(await renameAuthor("viewer")).toBe(403);
    // The name was not changed.
    const row = db.prepare("SELECT name FROM people WHERE id = 'p1'").get() as { name: string };
    expect(row.name).toBe("Jane Author");
  });

  it("lets a member who can write a book library rename the author", async () => {
    expect(await renameAuthor("writer")).toBe(200);
    const row = db.prepare("SELECT name FROM people WHERE id = 'p1'").get() as { name: string };
    expect(row.name).toBe("Renamed");
  });

  it("always lets an admin through", async () => {
    expect(await renameAuthor("admin")).toBe(200);
  });
});
