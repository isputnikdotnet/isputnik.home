// The metadata a quote carries beyond its text: where it came from, who may see
// it, whether it is in the Quote-of-the-day rotation, and the optional
// language/date/context a famous or family quote wants.
//
// The sharp edges pinned here: `origin` is DERIVED (a client cannot pass a
// hand-typed quote off as a reader highlight), a quote is private until it is
// explicitly raised to 'family', and turning the rotation flag OFF must store 0
// rather than clearing the column — the PATCH setter treats falsy values as
// "clear this", which is right for an emptied text field and wrong for a boolean.
import { beforeEach, describe, expect, it } from "vitest";
import fastify, { type FastifyInstance } from "fastify";
import { db } from "../src/db.js";
import { registerQuoteRoutes } from "../src/modules/library/quotes.js";
import { resetDb, makeUser, makeLibrary, grant } from "./helpers/seed.js";

let app: FastifyInstance;

interface QuoteView {
  id: string;
  tags: string[];
  personId: string | null;
  personName: string | null;
  origin: string;
  visibility: string;
  inRotation: boolean;
  language: string | null;
  quoteDate: string | null;
  context: string | null;
}

async function post(payload: Record<string, unknown>, user = "member") {
  const res = await app.inject({
    method: "POST",
    url: "/api/library/quotes",
    headers: { "x-test-user": user, "content-type": "application/json" },
    payload: JSON.stringify(payload)
  });
  return { status: res.statusCode, quote: res.statusCode === 201 ? (res.json().quote as QuoteView) : null };
}

async function patch(id: string, payload: Record<string, unknown>, user = "member") {
  const res = await app.inject({
    method: "PATCH",
    url: `/api/library/quotes/${id}`,
    headers: { "x-test-user": user, "content-type": "application/json" },
    payload: JSON.stringify(payload)
  });
  return { status: res.statusCode, quote: res.statusCode === 200 ? (res.json().quote as QuoteView) : null };
}

beforeEach(async () => {
  resetDb();
  makeUser("member");
  makeLibrary("EB", { createdBy: "member", type: "ebook" });
  grant("user", "member", "EB", "viewer");
  // One readable ebook with a document, so a reader-captured quote has something
  // real to anchor to.
  db.prepare(
    "INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES ('item1', 'EB', 'ebook', 'books/one', 'ready')"
  ).run();
  db.prepare("INSERT INTO item_metadata (item_id, source, title) VALUES ('item1', 'scan', 'A Book')").run();
  db.prepare(
    "INSERT INTO document_files (id, item_id, role, relative_path, format, mime_type, size, status)" +
    " VALUES ('doc1', 'item1', 'content', 'one.epub', 'epub', 'application/epub+zip', 100, 'available')"
  ).run();

  app = fastify();
  app.decorate("authenticate", async (request, reply) => {
    const id = request.headers["x-test-user"] as string | undefined;
    const row = id
      ? (db.prepare("SELECT id, role FROM users WHERE id = ?").get(id) as { id: string; role: string } | undefined)
      : undefined;
    if (!row) { reply.code(401).send({ error: "no" }); return; }
    request.user = row as never;
  });
  registerQuoteRoutes(app);
  await app.ready();
});

describe("quote metadata defaults", () => {
  it("keeps a new quote private, out of rotation, and free of metadata", async () => {
    const { status, quote } = await post({ text: "A passage" });
    expect(status).toBe(201);
    expect(quote).toMatchObject({
      origin: "manual",
      visibility: "private",
      inRotation: false,
      language: null,
      quoteDate: null,
      context: null
    });
  });

  it("derives origin from the anchor rather than the client", async () => {
    const typed = await post({ text: "Typed by hand" });
    expect(typed.quote?.origin).toBe("manual");

    const captured = await post({ text: "Highlighted", itemId: "item1", documentId: "doc1", cfi: "/6/4!/2" });
    expect(captured.quote?.origin).toBe("reader");

    // `origin` is not part of the request schema, so claiming one is ignored.
    const spoofed = await post({ text: "Not an import", origin: "import" });
    expect(spoofed.quote?.origin).toBe("manual");
  });
});

describe("quote metadata round-trip", () => {
  it("stores everything supplied at creation", async () => {
    const { quote } = await post({
      text: "Всё смешалось в доме Облонских.",
      sourceAuthor: "Лев Толстой",
      language: "ru",
      quoteDate: "1878",
      context: "Opening line",
      visibility: "family",
      inRotation: true
    });
    expect(quote).toMatchObject({
      visibility: "family",
      inRotation: true,
      language: "ru",
      quoteDate: "1878",
      context: "Opening line"
    });
  });

  it("updates and clears metadata over PATCH", async () => {
    const { quote } = await post({ text: "A passage", language: "en", context: "At dinner", visibility: "family" });
    const id = quote!.id;

    const updated = await patch(id, { language: "ru", quoteDate: "1997-05", context: "" });
    expect(updated.quote).toMatchObject({ language: "ru", quoteDate: "1997-05", context: null });
    // Untouched fields survive a partial update.
    expect(updated.quote?.visibility).toBe("family");
  });

  it("turns rotation off without clearing the column", async () => {
    const { quote } = await post({ text: "A passage", inRotation: true });
    expect(quote?.inRotation).toBe(true);

    const off = await patch(quote!.id, { inRotation: false });
    expect(off.quote?.inRotation).toBe(false);
    const row = db.prepare("SELECT in_rotation FROM quotes WHERE id = ?").get(quote!.id) as { in_rotation: number };
    expect(row.in_rotation).toBe(0);
  });

  it("accepts partial dates and rejects malformed ones", async () => {
    for (const quoteDate of ["1997", "1997-05", "1997-05-14"]) {
      expect((await post({ text: `Dated ${quoteDate}`, quoteDate })).status).toBe(201);
    }
    for (const quoteDate of ["97", "1997-13", "1997-02-30", "May 1997"]) {
      expect((await post({ text: "Bad date", quoteDate })).status).toBe(400);
    }
  });

  it("rejects an unknown visibility and a malformed language code", async () => {
    expect((await post({ text: "A passage", visibility: "public" })).status).toBe(400);
    expect((await post({ text: "A passage", language: "english" })).status).toBe(400);
  });
});

describe("the shared family library", () => {
  // Quotes were private to their owner before the daily card existed. Raising one
  // to 'family' is what puts it in front of the house — an admin-imported pack is
  // useless otherwise, since nobody but the importer would ever see it.
  async function list(user: string) {
    const res = await app.inject({
      method: "GET",
      url: "/api/library/quotes",
      headers: { "x-test-user": user }
    });
    return res.json().quotes as (QuoteView & { text: string; mine: boolean; ownerName: string | null; tags: string[] })[];
  }

  beforeEach(() => {
    makeUser("relative");
  });

  it("shows a family quote to everyone, and a private one to nobody else", async () => {
    await post({ text: "For the whole house", visibility: "family" });
    await post({ text: "Just for me", visibility: "private" });

    const seenByOther = await list("relative");
    expect(seenByOther.map((q) => q.text)).toEqual(["For the whole house"]);

    // The owner still sees both.
    expect((await list("member")).map((q) => q.text).sort()).toEqual(["For the whole house", "Just for me"]);
  });

  it("marks whose quote it is, and names the owner only for other people's", async () => {
    await post({ text: "Grandma kept this", visibility: "family" });

    const [mine] = await list("member");
    expect(mine).toMatchObject({ mine: true, ownerName: null });

    const [theirs] = await list("relative");
    expect(theirs.mine).toBe(false);
    expect(theirs.ownerName).toBeTruthy();
  });

  it("keeps someone else's quote read-only", async () => {
    const { quote } = await post({ text: "Not yours to touch", visibility: "family" });

    // No content-type on the DELETE: a JSON content-type with no body 400s in
    // fastify.inject before the route guard ever runs.
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/library/quotes/${quote!.id}`,
      headers: { "x-test-user": "relative", "content-type": "application/json" },
      payload: JSON.stringify({ text: "Rewritten" })
    });
    expect(patched.statusCode).toBe(404);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/library/quotes/${quote!.id}`,
      headers: { "x-test-user": "relative" }
    });
    expect(deleted.statusCode).toBe(404);
    const row = db.prepare("SELECT text FROM quotes WHERE id = ?").get(quote!.id) as { text: string };
    expect(row.text).toBe("Not yours to touch");
  });

  it("never leaks another reader's highlights into a document request", async () => {
    // Shared or not, ?documentId is the reader redrawing ITS OWN highlights.
    await post({ text: "My highlight", itemId: "item1", documentId: "doc1", cfi: "/6/4", visibility: "family" });

    const res = await app.inject({
      method: "GET",
      url: "/api/library/quotes?documentId=doc1",
      headers: { "x-test-user": "relative" }
    });
    expect(res.json().quotes).toEqual([]);
  });
});

describe("quote tags", () => {
  it("round-trips the categories a quote wears", async () => {
    const { quote } = await post({ text: "Something funny", tags: ["Funny", "Kids"] });
    expect(quote!.tags.sort()).toEqual(["Funny", "Kids"]);

    const updated = await patch(quote!.id, { tags: ["Kids"] });
    expect(updated.quote!.tags).toEqual(["Kids"]);

    // Replaced wholesale, not merged — the dropped tag is really gone.
    const rows = db.prepare(
      "SELECT COUNT(*) AS n FROM taggables WHERE entity_type = 'quote' AND entity_id = ?"
    ).get(quote!.id) as { n: number };
    expect(rows.n).toBe(1);
  });

  it("leaves tags alone when an edit does not mention them", async () => {
    const { quote } = await post({ text: "Tagged", tags: ["Funny"] });
    const updated = await patch(quote!.id, { note: "Just a note" });
    expect(updated.quote!.tags).toEqual(["Funny"]);
  });
});

describe("who said it", () => {
  // The speaker is a family-tree person, deliberately NOT source_author (who
  // wrote the book). A name snapshot rides along so deleting a relative leaves
  // their sayings attributed rather than anonymous — the FK is ON DELETE SET NULL.
  beforeEach(() => {
    db.prepare("INSERT INTO family_tree_persons (id, name, gender) VALUES ('sofia', 'Sofia', 'female')").run();
  });

  it("links a quote to a family member and reports their name", async () => {
    const { quote } = await post({ text: "Why do we sleep?", familyTreePersonId: "sofia" });
    expect(quote).toMatchObject({ personId: "sofia", personName: "Sofia" });
    expect(
      db.prepare("SELECT person_name FROM quotes WHERE id = ?").get(quote!.id)
    ).toEqual({ person_name: "Sofia" });
  });

  it("follows a rename, because the live person wins over the snapshot", async () => {
    const { quote } = await post({ text: "Something", familyTreePersonId: "sofia" });
    db.prepare("UPDATE family_tree_persons SET name = 'Sofia Ivanova' WHERE id = 'sofia'").run();

    const after = await patch(quote!.id, { note: "touch" });
    expect(after.quote!.personName).toBe("Sofia Ivanova");
  });

  it("keeps the quote and its attribution when the person is deleted", async () => {
    const { quote } = await post({ text: "Cake o'clock", familyTreePersonId: "sofia" });
    db.prepare("DELETE FROM family_tree_persons WHERE id = 'sofia'").run();

    const after = await patch(quote!.id, { note: "still here" });
    expect(after.quote).toMatchObject({ personId: null, personName: "Sofia" });
  });

  it("refuses a speaker who does not exist", async () => {
    expect((await post({ text: "Ghost", familyTreePersonId: "nobody" })).status).toBe(404);
    const { quote } = await post({ text: "Real", familyTreePersonId: "sofia" });
    expect((await patch(quote!.id, { familyTreePersonId: "nobody" })).status).toBe(404);
  });

  it("clears the snapshot when the link is removed, so nothing stale is claimed", async () => {
    const { quote } = await post({ text: "Unlink me", familyTreePersonId: "sofia" });
    const after = await patch(quote!.id, { familyTreePersonId: null });
    expect(after.quote).toMatchObject({ personId: null, personName: null });
  });

  it("lists one person's sayings for their profile, honouring visibility", async () => {
    await post({ text: "Shared saying", familyTreePersonId: "sofia", visibility: "family" });
    await post({ text: "Private saying", familyTreePersonId: "sofia", visibility: "private" });
    await post({ text: "Not hers", visibility: "family" });

    const asOwner = await app.inject({
      method: "GET",
      url: "/api/library/quotes?personId=sofia",
      headers: { "x-test-user": "member" }
    });
    expect((asOwner.json().quotes as { text: string }[]).map((q) => q.text).sort())
      .toEqual(["Private saying", "Shared saying"]);

    // Someone else sees the shared one only — and never the unrelated quote.
    makeUser("relative");
    const asOther = await app.inject({
      method: "GET",
      url: "/api/library/quotes?personId=sofia",
      headers: { "x-test-user": "relative" }
    });
    expect((asOther.json().quotes as { text: string }[]).map((q) => q.text)).toEqual(["Shared saying"]);
  });
});
