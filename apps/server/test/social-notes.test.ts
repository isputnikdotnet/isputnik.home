import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/core/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/mail.js")>();
  return { ...actual, sendMail: vi.fn(async () => {}), isMailConfigured: () => false };
});

import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";

import { db } from "../src/db.js";
import { hashPassword } from "../src/crypto.js";
import { registerAuthDecorators } from "../src/auth.js";
import { notesPlugin } from "../src/modules/social/notes.js";
import { grant, makeLibrary, resetDb } from "./helpers/seed.js";

// Notes have exactly one rule — if you can see the subject you can read and write
// its notes — so most of what is worth testing is that the rule is not quietly
// two rules, and that a note is text and stays text.

const PASSWORD = "correct-horse-battery";

let app: FastifyInstance;

async function buildApp(): Promise<FastifyInstance> {
  const instance = Fastify();
  await instance.register(cookie);
  await registerAuthDecorators(instance);
  await instance.register(notesPlugin);

  instance.post("/test/sign-in/:userId", async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const { issueSession } = await import("../src/auth.js");
    issueSession(reply, userId, request);
    return reply.send({ ok: true });
  });

  await instance.ready();
  return instance;
}

async function makeMember(id: string, role: "admin" | "member" = "member"): Promise<string> {
  db.prepare("INSERT INTO users (id, email, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)")
    .run(id, `${id}@test.local`, await hashPassword(PASSWORD), id, role);
  return id;
}

async function signIn(userId: string): Promise<string> {
  const response = await app.inject({ method: "POST", url: `/test/sign-in/${userId}` });
  const raw = response.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : [String(raw)];
  const found = list.find((entry) => entry.startsWith("isputnik_sid="));
  if (!found) throw new Error("no session cookie was set");
  return found.split(";")[0];
}

function makeEbook(itemId: string, libraryId: string, viewers: string[]): void {
  makeLibrary(libraryId, { createdBy: viewers[0], type: "ebook", ownerId: viewers[0], ownerType: "user" });
  for (const viewer of viewers) grant("user", viewer, libraryId, "viewer");
  db.prepare("INSERT INTO library_items (id, library_id, type, folder_path) VALUES (?, ?, 'ebook', ?)")
    .run(itemId, libraryId, `/src/${libraryId}/${itemId}`);
  db.prepare("INSERT INTO item_metadata (item_id, title) VALUES (?, ?)").run(itemId, "The Hobbit");
}

const post = (session: string, payload: unknown) =>
  app.inject({ method: "POST", url: "/api/social/notes", headers: { cookie: session }, payload });

const list = (session: string, entityType = "ebook", entityId = "book-1") =>
  app.inject({
    method: "GET",
    url: `/api/social/notes?entityType=${entityType}&entityId=${entityId}`,
    headers: { cookie: session }
  });

beforeEach(async () => {
  resetDb();
  app = await buildApp();
});

describe("posting and reading", () => {
  it("keeps a conversation under the thing, oldest first", async () => {
    await makeMember("dad");
    await makeMember("mom");
    makeEbook("book-1", "lib-1", ["dad", "mom"]);

    const dadSession = await signIn("dad");
    const momSession = await signIn("mom");

    await post(dadSession, { entityType: "ebook", entityId: "book-1", body: "the middle drags" });
    await post(momSession, { entityType: "ebook", entityId: "book-1", body: "it does not" });

    const response = await list(momSession);
    const notes = response.json().notes as Record<string, unknown>[];
    expect(notes.map((n) => [n.authorName, n.body, n.mine])).toEqual([
      ["dad", "the middle drags", false],
      ["mom", "it does not", true]
    ]);
  });

  it("lets a view-only member post — seeing a thing is the whole permission", async () => {
    await makeMember("dad");
    await makeMember("kid");
    makeEbook("book-1", "lib-1", ["dad", "kid"]);

    // kid has 'viewer' and nothing else: no download, no edit.
    const response = await post(await signIn("kid"), {
      entityType: "ebook",
      entityId: "book-1",
      body: "this was my favourite"
    });
    expect(response.statusCode).toBe(201);
  });

  it("refuses to read or write notes on a subject the caller cannot see", async () => {
    await makeMember("dad");
    await makeMember("guest");
    makeEbook("book-1", "lib-1", ["dad"]);

    const session = await signIn("guest");
    // 404 both ways: the shape of the refusal must not confirm the thing exists.
    expect((await list(session)).statusCode).toBe(404);
    expect((await post(session, { entityType: "ebook", entityId: "book-1", body: "hello" })).statusCode).toBe(404);
    expect(db.prepare("SELECT COUNT(*) AS n FROM notes").get()).toEqual({ n: 0 });
  });

  it("stops showing notes to somebody whose access was taken away", async () => {
    await makeMember("dad");
    await makeMember("mom");
    makeEbook("book-1", "lib-1", ["dad", "mom"]);
    const momSession = await signIn("mom");
    await post(await signIn("dad"), { entityType: "ebook", entityId: "book-1", body: "a secret opinion" });

    expect((await list(momSession)).json().notes).toHaveLength(1);
    db.prepare("DELETE FROM assignments WHERE subject_id = 'mom'").run();
    expect((await list(momSession)).statusCode).toBe(404);
  });

  it("works on a family-tree person, which everyone signed in can see", async () => {
    await makeMember("dad");
    await makeMember("mom");
    db.prepare("INSERT INTO family_tree_persons (id, name) VALUES ('p1', 'Grandma')").run();

    const created = await post(await signIn("dad"), {
      entityType: "family_tree_person",
      entityId: "p1",
      body: "she made this jam every August"
    });
    expect(created.statusCode).toBe(201);

    const response = await list(await signIn("mom"), "family_tree_person", "p1");
    expect((response.json().notes as { body: string }[])[0].body).toBe("she made this jam every August");
  });
});

describe("what a note is allowed to be", () => {
  it("stores and returns markup as the literal text it was typed as", async () => {
    await makeMember("dad");
    makeEbook("book-1", "lib-1", ["dad"]);
    const session = await signIn("dad");

    const nasty = '<script>alert("x")</script> **not bold** <img src=x onerror=1>';
    await post(session, { entityType: "ebook", entityId: "book-1", body: nasty });

    // Unchanged in and out: nothing is stripped, escaped or interpreted here,
    // because the client renders it as text. If that ever stops being true this
    // test is the thing that should be revisited first.
    const notes = (await list(session)).json().notes as { body: string }[];
    expect(notes[0].body).toBe(nasty);
    expect(db.prepare("SELECT body FROM notes").get()).toEqual({ body: nasty });
  });

  it("refuses an empty or whitespace-only note", async () => {
    await makeMember("dad");
    makeEbook("book-1", "lib-1", ["dad"]);
    const session = await signIn("dad");

    expect((await post(session, { entityType: "ebook", entityId: "book-1", body: "   " })).statusCode).toBe(400);
    expect((await post(session, { entityType: "ebook", entityId: "book-1", body: "" })).statusCode).toBe(400);
    expect(db.prepare("SELECT COUNT(*) AS n FROM notes").get()).toEqual({ n: 0 });
  });

  it("caps the length", async () => {
    await makeMember("dad");
    makeEbook("book-1", "lib-1", ["dad"]);
    const session = await signIn("dad");

    const response = await post(session, {
      entityType: "ebook",
      entityId: "book-1",
      body: "x".repeat(2001)
    });
    expect(response.statusCode).toBe(400);
  });

  it("refuses a subject type that does not exist", async () => {
    await makeMember("dad");
    const session = await signIn("dad");
    const response = await post(session, { entityType: "spaceship", entityId: "x", body: "hi" });
    expect(response.statusCode).toBe(400);
  });
});

describe("removing a note", () => {
  async function seedNote(): Promise<{ id: string }> {
    await makeMember("dad");
    await makeMember("mom");
    await makeMember("boss", "admin");
    makeEbook("book-1", "lib-1", ["dad", "mom", "boss"]);
    await post(await signIn("dad"), { entityType: "ebook", entityId: "book-1", body: "regrettable" });
    return db.prepare("SELECT id FROM notes").get() as { id: string };
  }

  const remove = (session: string, id: string) =>
    app.inject({ method: "DELETE", url: `/api/social/notes/${id}`, headers: { cookie: session } });

  it("lets the author take their own back, and keeps the row", async () => {
    const note = await seedNote();
    const session = await signIn("dad");

    expect((await remove(session, note.id)).statusCode).toBe(200);
    expect((await list(session)).json().notes).toEqual([]);
    // Soft: still there, so a mistake can be undone by hand.
    expect(db.prepare("SELECT COUNT(*) AS n FROM notes").get()).toEqual({ n: 1 });
  });

  it("will not let one family member delete another's", async () => {
    const note = await seedNote();
    const response = await remove(await signIn("mom"), note.id);
    expect(response.statusCode).toBe(403);
    expect((await list(await signIn("mom"))).json().notes).toHaveLength(1);
  });

  it("lets an admin remove anything", async () => {
    const note = await seedNote();
    expect((await remove(await signIn("boss"), note.id)).statusCode).toBe(200);
  });

  it("says who is allowed to delete each note", async () => {
    const note = await seedNote();
    void note;
    const asMom = (await list(await signIn("mom"))).json().notes as { canDelete: boolean }[];
    const asDad = (await list(await signIn("dad"))).json().notes as { canDelete: boolean }[];
    const asBoss = (await list(await signIn("boss"))).json().notes as { canDelete: boolean }[];
    expect([asMom[0].canDelete, asDad[0].canDelete, asBoss[0].canDelete]).toEqual([false, true, true]);
  });

  it("keeps the author's name after their account is gone", async () => {
    await seedNote();
    // Removing an account SET NULLs the author; the snapshot is what carries it.
    db.prepare("UPDATE notes SET user_id = NULL").run();
    const notes = (await list(await signIn("mom"))).json().notes as { authorName: string; mine: boolean }[];
    expect(notes[0]).toMatchObject({ authorName: "dad", mine: false });
  });
});
