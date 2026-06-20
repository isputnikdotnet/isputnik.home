import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { listPersonItems } from "../src/modules/library/audiobook/people.js";
import { resetDb, makeUser, makeLibrary, grant } from "./helpers/seed.js";

function addItem(id: string, libraryId: string, type: string, folder: string, title: string): void {
  db.prepare("INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES (?, ?, ?, ?, 'ready')")
    .run(id, libraryId, type, folder);
  db.prepare("INSERT INTO item_metadata (item_id, source, title) VALUES (?, 'scan', ?)").run(id, title);
}
function addPerson(id: string, name: string): void {
  db.prepare("INSERT INTO people (id, name, sort_name) VALUES (?, ?, ?)").run(id, name, name);
}
function credit(itemId: string, personId: string, role: string): void {
  db.prepare("INSERT INTO item_people (item_id, person_id, role, sort_order) VALUES (?, ?, ?, 0)").run(itemId, personId, role);
}

// One global author credited on an audiobook AND an ebook the user can see, plus
// a third audiobook in a library the user has no grant to. A narrator shares the
// audiobook. People are global, so all credits hang off two `people` rows.
beforeEach(() => {
  resetDb();
  makeUser("u1"); // member — avoids any admin all-access shortcut
  makeLibrary("AB", { createdBy: "u1", type: "audiobook" });
  makeLibrary("EB", { createdBy: "u1", type: "ebook" });
  makeLibrary("AB2", { createdBy: "u1", type: "audiobook" }); // intentionally NOT granted to u1
  grant("user", "u1", "AB", "member");
  grant("user", "u1", "EB", "member");

  addPerson("p-auth", "Shared Author");
  addPerson("p-narr", "Some Narrator");

  addItem("ab", "AB", "audiobook", "Shared Author/Audiobook", "The Audiobook");
  addItem("eb", "EB", "ebook", "Shared Author/Ebook", "The Ebook");
  addItem("hidden", "AB2", "audiobook", "Shared Author/Hidden", "Hidden Title");

  credit("ab", "p-auth", "author");
  credit("eb", "p-auth", "author");
  credit("hidden", "p-auth", "author"); // same author, but in the inaccessible library
  credit("ab", "p-narr", "narrator");
});

describe("listPersonItems (unified cross-type person page)", () => {
  it("spans media types and excludes libraries the user can't access", () => {
    const items = listPersonItems("Shared Author", "u1", "member");
    expect(items.map((i) => i.id).sort()).toEqual(["ab", "eb"]); // not "hidden"
    expect(items.every((i) => i.role === "author")).toBe(true);
    expect(items.map((i) => i.type).sort()).toEqual(["audiobook", "ebook"]);
  });

  it("matches by name case-insensitively and backfills each item's authors", () => {
    const items = listPersonItems("shared author", "u1", "member");
    expect(items).toHaveLength(2);
    const ebook = items.find((i) => i.type === "ebook")!;
    expect(ebook.title).toBe("The Ebook");
    expect(ebook.authors).toEqual(["Shared Author"]);
  });

  it("surfaces non-author roles (narrator) as their own credits", () => {
    const items = listPersonItems("Some Narrator", "u1", "member");
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("ab");
    expect(items[0].role).toBe("narrator");
    expect(items[0].authors).toEqual(["Shared Author"]); // the audiobook's author, backfilled
  });

  it("returns nothing when the user can access no libraries", () => {
    makeUser("u2"); // no grants at all
    expect(listPersonItems("Shared Author", "u2", "member")).toEqual([]);
  });
});
