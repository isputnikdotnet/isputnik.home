// "New photos of Ivan" on For you (docs/people-sharing-plan.md): derived from
// face confirmation times, counted from when the grant reached the viewer, and
// gone once they open or put it aside — until the next photo is confirmed.
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { clearPersonRow, countUnseenForYou, loadForYouRows, markForYouSeen, type PersonRow } from "../src/modules/social/for-you.js";
import { setPersonGrant, setShareExcluded } from "../src/modules/library/gallery/people-access.js";
import { makeLibrary, makeUser, resetDb } from "./helpers/seed.js";

const cousin = { id: "cousin", role: "member" };
// Before the grant, the grant, and after it — all in the past, so "seen now" is later.
const BEFORE = "2025-06-01T00:00:00.000Z";
const PAST = "2026-01-01T00:00:00.000Z";
const AFTER = "2026-03-01T00:00:00.000Z";

function photo(id: string, personId: string, confirmedAt: string, assignment = "confirmed") {
  db.prepare("INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES (?, 'fam', 'gallery', ?, 'ready')").run(id, `${id}.jpg`);
  db.prepare("INSERT INTO gallery_details (item_id, kind, relative_path, size) VALUES (?, 'photo', ?, 1)").run(id, `${id}.jpg`);
  db.prepare("INSERT INTO gallery_faces (id, item_id, person_id, assignment, source, updated_at) VALUES (?, ?, ?, ?, 'scan', ?)")
    .run(`f-${id}`, id, personId, assignment, confirmedAt);
}

const personRows = () => loadForYouRows(cousin).filter((row): row is PersonRow => row.kind === "person");

beforeEach(() => {
  resetDb();
  makeUser("admin", "admin");
  makeUser("cousin", "member");
  makeLibrary("fam", { createdBy: "admin", type: "gallery", ownerId: "admin", ownerType: "user" });
  db.prepare("INSERT INTO gallery_people (id, name) VALUES ('ivan', 'Ivan')").run();
  photo("old", "ivan", BEFORE);
  setPersonGrant({ subjectType: "user", subjectId: "cousin" }, "ivan", true, "admin");
  db.prepare("UPDATE assignments SET created_at = ?").run(PAST);
});

describe("new photos of a shared person", () => {
  it("counts only photos confirmed after the grant, and not auto matches or excluded ones", () => {
    expect(personRows()).toEqual([]);
    photo("new1", "ivan", AFTER);
    photo("new2", "ivan", AFTER);
    photo("auto", "ivan", AFTER, "auto");
    photo("hidden", "ivan", AFTER);
    setShareExcluded("hidden", true, "admin");
    expect(personRows()).toMatchObject([{ personId: "ivan", name: "Ivan", count: 2, seen: false }]);
    expect(countUnseenForYou(cousin)).toBe(1);
  });

  it("opening For you clears the dot, clearing the row hides it until the next photo", () => {
    photo("new1", "ivan", AFTER);
    markForYouSeen(cousin);
    // Seen, but still waiting: the dot goes, the row stays.
    expect(personRows()).toMatchObject([{ count: 1 }]);
    expect(countUnseenForYou(cousin)).toBe(0);

    expect(clearPersonRow(cousin, "ivan")).toBe(true);
    expect(personRows()).toEqual([]);
    expect(clearPersonRow(cousin, "ivan")).toBe(false);

    photo("new2", "ivan", new Date(Date.now() + 60_000).toISOString());
    expect(personRows()).toMatchObject([{ count: 1, seen: false }]);
  });

  it("comes through a group from when the viewer joined it, and not for a withdrawn grant", () => {
    setPersonGrant({ subjectType: "user", subjectId: "cousin" }, "ivan", false, "admin");
    photo("new1", "ivan", AFTER);
    expect(personRows()).toEqual([]);

    db.prepare("INSERT INTO user_groups (id, name, created_by) VALUES ('rel', 'Relatives', 'admin')").run();
    db.prepare("INSERT INTO group_members (group_id, user_id, joined_at) VALUES ('rel', 'cousin', ?)").run(PAST);
    setPersonGrant({ subjectType: "group", subjectId: "rel" }, "ivan", true, "admin");
    // Joined and granted long ago: new1 counts, the photo from before still does not.
    db.prepare("UPDATE assignments SET created_at = ? WHERE subject_id = 'rel'").run(PAST);
    expect(personRows()).toMatchObject([{ count: 1 }]);
  });
});
