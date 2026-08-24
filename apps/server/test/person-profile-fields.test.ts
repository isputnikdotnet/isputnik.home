// Website and location on an author/narrator profile: plain saved/read-back
// text fields (no URL validation — the web side displays whatever was typed),
// carried across a merge the same way bio already is.
import { beforeEach, describe, expect, it } from "vitest";
import fastify, { type FastifyInstance } from "fastify";
import { db } from "../src/db.js";
import { audiobookPeoplePlugin } from "../src/modules/library/audiobook/people.js";
import { resetDb, makeUser, grant } from "./helpers/seed.js";

let app: FastifyInstance;

beforeEach(async () => {
  resetDb();
  makeUser("writer");
  makeUser("admin", "admin");
  db.prepare(
    "INSERT INTO libraries (id, name, type, source_path, created_by, policy_json) VALUES ('AUD', 'AUD', 'audiobook', '/src', 'writer', '{}')"
  ).run();
  grant("user", "writer", "AUD", "contributor");
  db.prepare("INSERT INTO people (id, name, sort_name) VALUES ('p1', 'Jane Author', 'Author, Jane')").run();

  app = fastify();
  app.decorate("authenticate", async (request, reply) => {
    const id = request.headers["x-test-user"] as string | undefined;
    const row = id ? (db.prepare("SELECT id, role FROM users WHERE id = ?").get(id) as { id: string; role: string } | undefined) : undefined;
    if (!row) { reply.code(401).send({ error: "no" }); return; }
    request.user = row as never;
  });
  app.decorate("requireAdmin", async (request, reply) => {
    await app.authenticate(request, reply);
    if (reply.sent) return;
    if (request.user?.role !== "admin") reply.code(403).send({ error: "Admin only" });
  });
  await app.register(audiobookPeoplePlugin);
  await app.ready();
});

describe("author/narrator profile: website and location", () => {
  it("saves and reads back both fields", async () => {
    const patch = await app.inject({
      method: "PATCH",
      url: `/api/library/people/by-name?name=${encodeURIComponent("Jane Author")}`,
      headers: { "x-test-user": "writer", "content-type": "application/json" },
      payload: JSON.stringify({ website: "agriddle.com", location: "Seattle, Washington, USA" })
    });
    expect(patch.statusCode).toBe(200);

    const get = await app.inject({
      method: "GET",
      url: `/api/library/people/by-name?name=${encodeURIComponent("Jane Author")}`,
      headers: { "x-test-user": "writer" }
    });
    const body = JSON.parse(get.body) as { person: { website: string | null; location: string | null } };
    expect(body.person.website).toBe("agriddle.com");
    expect(body.person.location).toBe("Seattle, Washington, USA");
  });

  it("clears a field back to null", async () => {
    db.prepare("UPDATE people SET website = 'old.example', location = 'Old City' WHERE id = 'p1'").run();

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/library/people/by-name?name=${encodeURIComponent("Jane Author")}`,
      headers: { "x-test-user": "writer", "content-type": "application/json" },
      payload: JSON.stringify({ website: null, location: null })
    });
    expect(patch.statusCode).toBe(200);

    const row = db.prepare("SELECT website, location FROM people WHERE id = 'p1'").get() as
      { website: string | null; location: string | null };
    expect(row.website).toBeNull();
    expect(row.location).toBeNull();
  });

  it("removes a photo, clearing the key and leaving the rest of the profile alone", async () => {
    db.prepare("UPDATE people SET image_storage_key = 'people/p1/p1-photo-1.webp', bio = 'Kept' WHERE id = 'p1'").run();

    const res = await app.inject({
      method: "DELETE",
      url: `/api/library/people/by-name/photo?name=${encodeURIComponent("Jane Author")}`,
      headers: { "x-test-user": "writer" }
    });
    expect(res.statusCode).toBe(200);

    const row = db.prepare("SELECT image_storage_key, bio FROM people WHERE id = 'p1'").get() as
      { image_storage_key: string | null; bio: string | null };
    expect(row.image_storage_key).toBeNull();
    expect(row.bio).toBe("Kept");
  });

  it("refuses a photo removal from a viewer-only member", async () => {
    makeUser("viewer");
    grant("user", "viewer", "AUD", "viewer");
    db.prepare("UPDATE people SET image_storage_key = 'people/p1/p1-photo-1.webp' WHERE id = 'p1'").run();

    const res = await app.inject({
      method: "DELETE",
      url: `/api/library/people/by-name/photo?name=${encodeURIComponent("Jane Author")}`,
      headers: { "x-test-user": "viewer" }
    });
    expect(res.statusCode).toBe(403);

    const row = db.prepare("SELECT image_storage_key FROM people WHERE id = 'p1'").get() as { image_storage_key: string | null };
    expect(row.image_storage_key).toBe("people/p1/p1-photo-1.webp");
  });

  it("carries both fields forward when a merge creates the target person", async () => {
    db.prepare("UPDATE people SET website = 'agriddle.com', location = 'Seattle, WA' WHERE id = 'p1'").run();

    const merge = await app.inject({
      method: "POST",
      url: "/api/library/people/merge",
      headers: { "x-test-user": "admin", "content-type": "application/json" },
      payload: JSON.stringify({ from: "Jane Author", into: "New Pen Name" })
    });
    expect(merge.statusCode).toBe(200);

    const row = db.prepare("SELECT website, location FROM people WHERE name = 'New Pen Name'").get() as
      { website: string | null; location: string | null };
    expect(row.website).toBe("agriddle.com");
    expect(row.location).toBe("Seattle, WA");
  });
});
