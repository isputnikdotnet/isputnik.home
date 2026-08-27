// Bulk quote import. The properties that make a pack safe to feed in twice, and
// safe to feed in badly:
//   • one malformed row is reported by index, not fatal to the other 4999;
//   • duplicates are skipped against the caller's existing quotes AND against
//     the rest of the same batch;
//   • a dry run answers the same question without writing a thing;
//   • the cap is refused outright rather than silently truncating the file.
import { beforeEach, describe, expect, it } from "vitest";
import fastify, { type FastifyInstance } from "fastify";
import { db } from "../src/db.js";
import { registerQuoteImportRoutes } from "../src/modules/library/quotes-import.js";
import { registerQuoteRoutes } from "../src/modules/library/quotes.js";
import { resetDb, makeUser } from "./helpers/seed.js";

let app: FastifyInstance;

interface Summary {
  dryRun: boolean;
  total: number;
  imported: number;
  skippedDuplicates: number;
  invalidCount: number;
  invalid: { index: number; reason: string }[];
}

async function importQuotes(body: unknown, opts: { dryRun?: boolean; user?: string } = {}) {
  const res = await app.inject({
    method: "POST",
    url: `/api/library/quotes/import${opts.dryRun ? "?dryRun=1" : ""}`,
    headers: { "x-test-user": opts.user ?? "admin", "content-type": "application/json" },
    payload: JSON.stringify(body)
  });
  return { status: res.statusCode, body: res.json() as Summary & { error?: string } };
}

const rows = (...texts: string[]) => texts.map((text) => ({ text }));

function storedQuotes(user = "admin") {
  return db
    .prepare("SELECT text, source_title, source_author, origin, visibility, in_rotation, language, quote_date, context FROM quotes WHERE user_id = ? ORDER BY text")
    .all(user) as Record<string, unknown>[];
}

beforeEach(async () => {
  resetDb();
  makeUser("admin", "admin");
  makeUser("member");
  makeUser("other");

  app = fastify();
  app.decorate("authenticate", async (request, reply) => {
    const id = request.headers["x-test-user"] as string | undefined;
    const row = id
      ? (db.prepare("SELECT id, role FROM users WHERE id = ?").get(id) as { id: string; role: string } | undefined)
      : undefined;
    if (!row) { reply.code(401).send({ error: "no" }); return; }
    request.user = row as never;
  });
  app.decorate("requireAdmin", async (request, reply) => {
    await app.authenticate(request, reply);
    if (reply.sent) return;
    if (request.user?.role !== "admin") reply.code(403).send({ error: "Admin only" });
  });
  registerQuoteImportRoutes(app);
  registerQuoteRoutes(app);
  await app.ready();
});

describe("importing a pack", () => {
  it("brings quotes in as external, family-visible, rotating rows", async () => {
    const { status, body } = await importQuotes({
      version: 1,
      quotes: [{
        text: "Всё смешалось в доме Облонских.",
        author: "Лев Толстой",
        source: "Анна Каренина",
        language: "ru",
        date: "1878",
        context: "Opening line"
      }]
    });

    expect(status).toBe(200);
    expect(body).toMatchObject({ dryRun: false, total: 1, imported: 1, skippedDuplicates: 0, invalidCount: 0 });
    expect(storedQuotes()[0]).toMatchObject({
      text: "Всё смешалось в доме Облонских.",
      source_title: "Анна Каренина",
      source_author: "Лев Толстой",
      // The whole point of a pack: shared, in the daily rotation, and marked as
      // imported so it can be picked back out again.
      origin: "import",
      visibility: "family",
      in_rotation: 1,
      language: "ru",
      quote_date: "1878",
      context: "Opening line"
    });
  });

  it("applies pack defaults, and lets a row override its own language", async () => {
    await importQuotes({
      defaults: { language: "en", visibility: "private", inRotation: false },
      quotes: [{ text: "An English one" }, { text: "Русская цитата", language: "ru" }]
    });

    const stored = storedQuotes();
    expect(stored).toHaveLength(2);
    for (const row of stored) {
      expect(row).toMatchObject({ visibility: "private", in_rotation: 0 });
    }
    expect(stored.find((r) => r.text === "An English one")).toMatchObject({ language: "en" });
    expect(stored.find((r) => r.text === "Русская цитата")).toMatchObject({ language: "ru" });
  });

  it("clears an imported quote's tags when the quote is deleted", async () => {
    await importQuotes({ quotes: [{ text: "Tagged", tags: ["humour"] }] });
    const id = (db.prepare("SELECT id FROM quotes").get() as { id: string }).id;
    // taggables has no FK on entity_id, so nothing cleans these up for us.
    const res = await app.inject({
      method: "DELETE",
      url: `/api/library/quotes/${id}`,
      headers: { "x-test-user": "admin" }
    });
    expect(res.statusCode).toBe(200);
    expect(db.prepare("SELECT COUNT(*) AS n FROM taggables WHERE entity_type = 'quote'").get()).toEqual({ n: 0 });
  });

  it("attaches tags so a re-import cannot lose them", async () => {
    await importQuotes({ quotes: [{ text: "Tagged", tags: ["Humour", "wisdom"] }] });
    const id = (db.prepare("SELECT id FROM quotes").get() as { id: string }).id;
    const tags = db.prepare(
      "SELECT tags.display_name AS name FROM taggables JOIN tags ON tags.id = taggables.tag_id" +
      " WHERE taggables.entity_type = 'quote' AND taggables.entity_id = ? ORDER BY name"
    ).all(id) as { name: string }[];
    expect(tags.map((t) => t.name)).toEqual(["Humour", "wisdom"]);
  });
});

describe("who may import", () => {
  it("refuses a member — a pack curates what the whole house reads", async () => {
    const { status } = await importQuotes({ quotes: rows("Sneaked in") }, { user: "member" });
    expect(status).toBe(403);
    expect(storedQuotes("member")).toHaveLength(0);
    expect(storedQuotes("admin")).toHaveLength(0);
  });

  it("refuses a member on a dry run too, so the file is not even read", async () => {
    const { status } = await importQuotes({ quotes: rows("Peeking") }, { user: "member", dryRun: true });
    expect(status).toBe(403);
  });
});

describe("duplicate handling", () => {
  it("skips quotes the user already has, ignoring case and spacing", async () => {
    await importQuotes({ quotes: [{ text: "Know thyself", author: "Socrates" }] });

    const { body } = await importQuotes({
      quotes: [
        { text: "  know   THYSELF ", author: "socrates" },  // same quote, sloppier
        { text: "Know thyself", author: "Someone Else" },   // same words, another mouth
        { text: "A new one" }
      ]
    });

    expect(body).toMatchObject({ total: 3, imported: 2, skippedDuplicates: 1 });
    expect(storedQuotes()).toHaveLength(3);
  });

  it("dedups within a single batch", async () => {
    const { body } = await importQuotes({
      quotes: [{ text: "Repeated" }, { text: "repeated" }, { text: "Repeated" }]
    });
    expect(body).toMatchObject({ imported: 1, skippedDuplicates: 2 });
    expect(storedQuotes()).toHaveLength(1);
  });

  it("dedups against the importer only, not against what members saved", async () => {
    // A member typed this one in themselves. Dedup is scoped to the importing
    // user, so the pack still brings its own copy into the shared library.
    await app.inject({
      method: "POST",
      url: "/api/library/quotes",
      headers: { "x-test-user": "other", "content-type": "application/json" },
      payload: JSON.stringify({ text: "Shared saying" })
    });

    const { body } = await importQuotes({ quotes: rows("Shared saying") });
    expect(body).toMatchObject({ imported: 1, skippedDuplicates: 0 });
    expect(storedQuotes("other")).toHaveLength(1);
    expect(storedQuotes("admin")).toHaveLength(1);
  });

  it("makes re-importing the same pack a no-op", async () => {
    const pack = { quotes: rows("One", "Two", "Three") };
    expect((await importQuotes(pack)).body).toMatchObject({ imported: 3, skippedDuplicates: 0 });
    expect((await importQuotes(pack)).body).toMatchObject({ imported: 0, skippedDuplicates: 3 });
    expect(storedQuotes()).toHaveLength(3);
  });


});

describe("bad input", () => {
  it("reports malformed rows by index and imports the rest", async () => {
    const { status, body } = await importQuotes({
      quotes: [
        { text: "Fine" },
        { text: "" },                                  // empty
        { author: "No text at all" },                  // missing text
        { text: "Bad date", date: "May 1878" },
        { text: "Bad language", language: "english" },
        { text: "Also fine" }
      ]
    });

    expect(status).toBe(200);
    expect(body).toMatchObject({ total: 6, imported: 2, invalidCount: 4 });
    expect(body.invalid.map((entry) => entry.index)).toEqual([1, 2, 3, 4]);
    // Whoever picked the file reads these, so they must stay plain words rather
    // than reverting to zod's "Too small: expected string to have >=1 characters".
    expect(body.invalid[0].reason).toContain("the quote text is empty");
    expect(body.invalid[1].reason).toContain("the quote text is missing");
    expect(body.invalid[2].reason).toMatch(/YYYY/);
    expect(body.invalid[3].reason).toMatch(/language code/);
    expect(storedQuotes().map((r) => r.text)).toEqual(["Also fine", "Fine"]);
  });

  it("refuses a file past the cap instead of importing part of it", async () => {
    const many = Array.from({ length: 5001 }, (_, i) => ({ text: `Quote ${i}` }));
    const { status, body } = await importQuotes({ quotes: many });
    expect(status).toBe(400);
    expect(body.error).toMatch(/5001/);
    expect(storedQuotes()).toHaveLength(0);
  });

  it("refuses a format version it does not know", async () => {
    const { status, body } = await importQuotes({ version: 2, quotes: rows("Hello") });
    expect(status).toBe(400);
    expect(body.error).toMatch(/version 2/);
    expect(storedQuotes()).toHaveLength(0);
  });

  it("refuses an envelope that carries no quotes", async () => {
    expect((await importQuotes({ quotes: [] })).status).toBe(400);
    expect((await importQuotes({ notAPack: true })).status).toBe(400);
  });
});

describe("dry run", () => {
  it("answers the same counts without writing anything", async () => {
    await importQuotes({ quotes: rows("Already here") });

    const { body } = await importQuotes(
      { quotes: [{ text: "Already here" }, { text: "Brand new" }, { text: "" }] },
      { dryRun: true }
    );

    expect(body).toMatchObject({
      dryRun: true, total: 3, imported: 1, skippedDuplicates: 1, invalidCount: 1
    });
    // Still just the one quote from the real import above.
    expect(storedQuotes()).toHaveLength(1);
  });

  it("leaves no tags behind either", async () => {
    await importQuotes({ quotes: [{ text: "Tagged", tags: ["humour"] }] }, { dryRun: true });
    expect(db.prepare("SELECT COUNT(*) AS n FROM taggables WHERE entity_type = 'quote'").get()).toEqual({ n: 0 });
  });
});

describe("undoing an import", () => {
  // One click brings in thousands; without a way back out the only undo is
  // deleting them one at a time. Deliberately narrow — the caller's own
  // imported rows and nothing else.
  async function clearImported(user = "admin") {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/library/quotes/imported",
      headers: { "x-test-user": user }
    });
    return { status: res.statusCode, deleted: res.json().deleted as number };
  }

  async function addByHand(user: string, text: string) {
    await app.inject({
      method: "POST",
      url: "/api/library/quotes",
      headers: { "x-test-user": user, "content-type": "application/json" },
      payload: JSON.stringify({ text })
    });
  }

  it("removes every imported quote and reports how many", async () => {
    await importQuotes({ quotes: rows("One", "Two", "Three") });
    expect(await clearImported()).toEqual({ status: 200, deleted: 3 });
    expect(storedQuotes("admin")).toHaveLength(0);
  });

  it("never touches quotes that were not imported", async () => {
    await importQuotes({ quotes: rows("Imported one") });
    await addByHand("admin", "Typed by hand");

    expect((await clearImported()).deleted).toBe(1);
    expect(storedQuotes("admin").map((r) => r.text)).toEqual(["Typed by hand"]);
  });

  it("never touches anyone else's quotes", async () => {
    await importQuotes({ quotes: rows("Admin pack") });
    await addByHand("member", "A member's own");

    await clearImported();
    expect(storedQuotes("member")).toHaveLength(1);
  });

  it("clears the tag links too, rather than orphaning them", async () => {
    await importQuotes({ quotes: [{ text: "Tagged", tags: ["Humour"] }] });
    await clearImported();
    expect(db.prepare("SELECT COUNT(*) AS n FROM taggables WHERE entity_type = 'quote'").get()).toEqual({ n: 0 });
  });

  it("is harmless when there is nothing to clear", async () => {
    expect(await clearImported()).toEqual({ status: 200, deleted: 0 });
  });

  it("leaves a single quote's own delete route reachable", async () => {
    await importQuotes({ quotes: rows("Just this one") });
    const id = (db.prepare("SELECT id FROM quotes").get() as { id: string }).id;
    const res = await app.inject({
      method: "DELETE",
      url: `/api/library/quotes/${id}`,
      headers: { "x-test-user": "admin" }
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("imports as events", () => {
  // A pack is kept as the run it was, so one can be undone without touching
  // another — the reason quotes carry an import_id at all.
  async function listImports(user = "admin") {
    const res = await app.inject({
      method: "GET",
      url: "/api/library/quotes/imports",
      headers: { "x-test-user": user }
    });
    return res.json().imports as {
      id: string; fileName: string | null; importedCount: number; remainingCount: number;
    }[];
  }

  it("records the run, with the file name the client sent", async () => {
    await importQuotes({ fileName: "quotes-ru.json", quotes: rows("One", "Two") });
    const [entry] = await listImports();
    expect(entry).toMatchObject({ fileName: "quotes-ru.json", importedCount: 2, remainingCount: 2 });
  });

  it("records nothing for a dry run", async () => {
    await importQuotes({ fileName: "peek.json", quotes: rows("One") }, { dryRun: true });
    expect(await listImports()).toHaveLength(0);
  });

  it("deletes one pack without touching another", async () => {
    await importQuotes({ fileName: "first.json", quotes: rows("A one", "A two") });
    await importQuotes({ fileName: "second.json", quotes: rows("B one", "B two", "B three") });

    const before = await listImports();
    const first = before.find((entry) => entry.fileName === "first.json")!;

    const res = await app.inject({
      method: "DELETE",
      url: `/api/library/quotes/imports/${first.id}`,
      headers: { "x-test-user": "admin" }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().deleted).toBe(2);

    // The other pack is untouched, and the deleted run is gone from the list.
    expect(storedQuotes("admin").map((r) => r.text).sort()).toEqual(["B one", "B three", "B two"]);
    expect((await listImports()).map((e) => e.fileName)).toEqual(["second.json"]);
  });

  it("counts what is left, not what arrived", async () => {
    await importQuotes({ fileName: "pack.json", quotes: rows("Keep", "Remove") });
    const id = (db.prepare("SELECT id FROM quotes WHERE text = 'Remove'").get() as { id: string }).id;
    await app.inject({
      method: "DELETE",
      url: `/api/library/quotes/${id}`,
      headers: { "x-test-user": "admin" }
    });

    const [entry] = await listImports();
    expect(entry).toMatchObject({ importedCount: 2, remainingCount: 1 });
  });

  it("clears the tag links of the pack it deletes", async () => {
    await importQuotes({ fileName: "tagged.json", quotes: [{ text: "Tagged", tags: ["Humour"] }] });
    const [entry] = await listImports();
    await app.inject({
      method: "DELETE",
      url: `/api/library/quotes/imports/${entry.id}`,
      headers: { "x-test-user": "admin" }
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM taggables WHERE entity_type = 'quote'").get()).toEqual({ n: 0 });
  });

  it("404s an import that is not yours, and one that does not exist", async () => {
    await importQuotes({ fileName: "mine.json", quotes: rows("Mine") });
    const [entry] = await listImports();

    makeUser("admin2", "admin");
    const asOther = await app.inject({
      method: "DELETE",
      url: `/api/library/quotes/imports/${entry.id}`,
      headers: { "x-test-user": "admin2" }
    });
    expect(asOther.statusCode).toBe(404);
    expect(storedQuotes("admin")).toHaveLength(1);

    const missing = await app.inject({
      method: "DELETE",
      url: "/api/library/quotes/imports/nope",
      headers: { "x-test-user": "admin" }
    });
    expect(missing.statusCode).toBe(404);
  });

  it("is admin-only, like importing itself", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/library/quotes/imports",
      headers: { "x-test-user": "member" }
    });
    expect(res.statusCode).toBe(403);
  });
});
