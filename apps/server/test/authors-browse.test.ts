// listAuthors / listAuthorLibraries — what the unified Authors browse filters on.
// The access filter is the load-bearing part: authors are global rows, so the only
// thing keeping a private library's authors off someone's screen is the library
// scoping in these two queries.
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { listAuthors, listAuthorLibraries } from "../src/modules/library/audiobook/people.js";
import { resetDb, makeUser, makeLibrary, grant } from "./helpers/seed.js";

const reader = { id: "reader", role: "member" };

function makeItem(id: string, opts: { library: string; type: string }): string {
  db.prepare(
    "INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES (?, ?, ?, ?, 'ready')"
  ).run(id, opts.library, opts.type, `/${id}`);
  return id;
}

function credit(itemId: string, name: string, sortName: string | null = null): void {
  let person = db.prepare("SELECT id FROM people WHERE name = ?").get(name) as { id: string } | undefined;
  if (!person) {
    db.prepare("INSERT INTO people (id, name, sort_name) VALUES (?, ?, ?)").run(`p-${name}`, name, sortName);
    person = { id: `p-${name}` };
  }
  db.prepare(
    "INSERT INTO item_people (item_id, person_id, role, sort_order) VALUES (?, ?, 'author', 0)"
  ).run(itemId, person.id);
}

beforeEach(() => {
  resetDb();
  makeUser("reader");
  makeUser("owner");

  makeLibrary("AUDIO", { createdBy: "owner", type: "audiobook" });
  makeLibrary("EBOOKS", { createdBy: "owner", type: "ebook" });
  grant("group", EVERYONE_GROUP_ID, "AUDIO", "member");
  grant("group", EVERYONE_GROUP_ID, "EBOOKS", "member");

  makeLibrary("PRIVATE", { createdBy: "owner", type: "ebook" });
  grant("user", "owner", "PRIVATE", "manager");
});

describe("listAuthors", () => {
  it("counts a person's titles per media type and reports every library they're in", () => {
    credit(makeItem("a1", { library: "AUDIO", type: "audiobook" }), "Isaac Asimov");
    credit(makeItem("a2", { library: "AUDIO", type: "audiobook" }), "Isaac Asimov");
    credit(makeItem("e1", { library: "EBOOKS", type: "ebook" }), "Isaac Asimov");

    const [author] = listAuthors(reader.id, reader.role);
    expect(author).toMatchObject({ name: "Isaac Asimov", audiobookCount: 2, ebookCount: 1 });
    expect([...author.libraryIds].sort()).toEqual(["AUDIO", "EBOOKS"]);
  });

  it("carries the curated sort name through, so the browse can file by surname", () => {
    credit(makeItem("e1", { library: "EBOOKS", type: "ebook" }), "J. R. R. Tolkien", "Tolkien, J. R. R.");
    expect(listAuthors(reader.id, reader.role)[0].sortName).toBe("Tolkien, J. R. R.");
  });

  it("leaves out libraries the caller can't reach — from the counts and the ids", () => {
    credit(makeItem("e1", { library: "EBOOKS", type: "ebook" }), "Isaac Asimov");
    credit(makeItem("p1", { library: "PRIVATE", type: "ebook" }), "Isaac Asimov");
    credit(makeItem("p2", { library: "PRIVATE", type: "ebook" }), "Hidden Author");

    const authors = listAuthors(reader.id, reader.role);
    expect(authors.map((a) => a.name)).toEqual(["Isaac Asimov"]);
    expect(authors[0].ebookCount).toBe(1);
    expect(authors[0].libraryIds).toEqual(["EBOOKS"]);

    // The owner sees both, and Asimov's second library.
    const asOwner = listAuthors("owner", "member");
    expect(asOwner.map((a) => a.name).sort()).toEqual(["Hidden Author", "Isaac Asimov"]);
    expect([...asOwner.find((a) => a.name === "Isaac Asimov")!.libraryIds].sort()).toEqual(["EBOOKS", "PRIVATE"]);
  });

  it("ignores soft-deleted items and narrator credits", () => {
    const gone = makeItem("a1", { library: "AUDIO", type: "audiobook" });
    credit(gone, "Isaac Asimov");
    db.prepare("UPDATE library_items SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(gone);

    const narrated = makeItem("a2", { library: "AUDIO", type: "audiobook" });
    db.prepare("INSERT INTO people (id, name) VALUES ('p-nar', 'Stephen Fry')").run();
    db.prepare(
      "INSERT INTO item_people (item_id, person_id, role, sort_order) VALUES (?, 'p-nar', 'narrator', 0)"
    ).run(narrated);

    expect(listAuthors(reader.id, reader.role)).toEqual([]);
  });
});

describe("listAuthorLibraries", () => {
  it("offers only reachable libraries that actually hold an authored item", () => {
    credit(makeItem("a1", { library: "AUDIO", type: "audiobook" }), "Isaac Asimov");
    credit(makeItem("p1", { library: "PRIVATE", type: "ebook" }), "Hidden Author");
    // EBOOKS is reachable but has nothing with an author on it.
    makeItem("e1", { library: "EBOOKS", type: "ebook" });

    expect(listAuthorLibraries(reader.id, reader.role)).toEqual([
      { id: "AUDIO", name: "AUDIO", type: "audiobook" }
    ]);
  });

  it("lists a library once however many authors it holds", () => {
    const item = makeItem("a1", { library: "AUDIO", type: "audiobook" });
    credit(item, "Isaac Asimov");
    credit(item, "Robert Silverberg");
    credit(makeItem("a2", { library: "AUDIO", type: "audiobook" }), "Isaac Asimov");

    expect(listAuthorLibraries(reader.id, reader.role)).toHaveLength(1);
  });
});
