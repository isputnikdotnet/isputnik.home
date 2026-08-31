// Quotes as collection members. The subject resolver answers one question for
// every cross-content feature — "what is this thing, and may this user see it?"
// — so these pin the answer for quotes: a plain row (words, no cover, nothing to
// play), and the same shared-or-mine visibility every other quote surface uses.
//
// `available: false` is the important half: a collection keeps the row and
// renders it as unavailable rather than failing the page, so a quote that was
// deleted — or was never the viewer's to see — must come back missing, not leak.
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { hydrateEntities, COLLECTABLE_ENTITY_TYPES } from "../src/modules/social/subjects.js";
import { resetDb, makeUser } from "./helpers/seed.js";

const viewer = { id: "member", role: "member" };

function seedQuote(id: string, fields: Partial<{
  owner: string;
  text: string;
  visibility: string;
  sourceTitle: string | null;
  sourceAuthor: string | null;
  personId: string | null;
  personName: string | null;
}> = {}) {
  db.prepare(`
    INSERT INTO quotes (id, user_id, text, visibility, source_title, source_author, family_tree_person_id, person_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    fields.owner ?? "member",
    fields.text ?? `Quote ${id}`,
    fields.visibility ?? "private",
    fields.sourceTitle ?? null,
    fields.sourceAuthor ?? null,
    fields.personId ?? null,
    fields.personName ?? null
  );
}

const hydrate = (ids: string[], user = viewer) =>
  hydrateEntities(ids.map((entityId) => ({ entityType: "quote", entityId })), user);

beforeEach(() => {
  resetDb();
  makeUser("member");
  makeUser("relative");
});

describe("quotes are collectable", () => {
  it("is registered as a collectable subject type", () => {
    expect(COLLECTABLE_ENTITY_TYPES).toContain("quote");
  });

  it("renders as words: no cover, no duration, nothing to play", () => {
    seedQuote("q1", { text: "A short saying", sourceAuthor: "Mark Twain" });
    const view = hydrate(["q1"]).get("quote:q1")!;
    expect(view).toMatchObject({
      available: true,
      title: "A short saying",
      subtitle: "Mark Twain",
      coverUrl: null,
      durationSeconds: null,
      fileCount: 0,
      playable: false,
      href: "/quotes?quote=q1"
    });
  });

  it("flattens and shortens a long quote into one line", () => {
    const long = `${"word ".repeat(60)}end`;
    seedQuote("q1", { text: `Line one\n\n   Line two ${long}` });
    const view = hydrate(["q1"]).get("quote:q1")!;
    expect(view.title).not.toContain("\n");
    expect(view.title.length).toBeLessThanOrEqual(120);
    expect(view.title.endsWith("…")).toBe(true);
  });

  it("prefers the speaker over the book's author for attribution", () => {
    db.prepare("INSERT INTO family_tree_persons (id, name, gender) VALUES ('sofia', 'Sofia', 'female')").run();
    seedQuote("q1", { sourceAuthor: "Some Author", personId: "sofia", personName: "Sofia" });
    expect(hydrate(["q1"]).get("quote:q1")!.subtitle).toBe("Sofia");

    // A renamed relative shows the new name, not the snapshot.
    db.prepare("UPDATE family_tree_persons SET name = 'Sofia Ivanova' WHERE id = 'sofia'").run();
    expect(hydrate(["q1"]).get("quote:q1")!.subtitle).toBe("Sofia Ivanova");
  });

  it("falls back to the source title when nobody is credited", () => {
    seedQuote("q1", { sourceTitle: "Anna Karenina" });
    expect(hydrate(["q1"]).get("quote:q1")!.subtitle).toBe("Anna Karenina");
  });
});

describe("what a collector may see", () => {
  it("hydrates a family quote for anyone", () => {
    seedQuote("shared", { owner: "relative", visibility: "family" });
    expect(hydrate(["shared"]).get("quote:shared")?.available).toBe(true);
  });

  it("refuses to hydrate someone else's private quote", () => {
    seedQuote("theirs", { owner: "relative", visibility: "private" });
    // Not merely hidden — absent, so the collection row renders as unavailable.
    expect(hydrate(["theirs"]).get("quote:theirs")).toBeUndefined();
  });

  it("hydrates the viewer's own private quote", () => {
    seedQuote("mine", { owner: "member", visibility: "private" });
    expect(hydrate(["mine"]).get("quote:mine")?.available).toBe(true);
  });

  it("returns nothing for a quote that has been deleted", () => {
    seedQuote("gone");
    db.prepare("DELETE FROM quotes WHERE id = 'gone'").run();
    expect(hydrate(["gone"]).get("quote:gone")).toBeUndefined();
  });
});
