import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID, can } from "../src/core/permissions.js";
import { canUserAccessLibrary } from "../src/modules/library/shared/library-access.js";
import { listPhotoInboxes } from "../src/modules/library/gallery/inbox.js";
import { setSystemLibraryRole } from "../src/modules/library/gallery/system-libraries.js";
import { inboxReviewersView } from "../src/modules/library/gallery/inbox-reviewers.js";
import { appStorageRoutesPlugin } from "../src/modules/library/app-storage-routes.js";
import { libraryMembersPlugin } from "../src/modules/library/shared/members.js";
import { up as migrateInboxReviewers } from "../src/db/migrations/076-inbox-reviewers.js";
import { addToGroup, grant, grantReviewer, makeLibrary, makeUser, resetDb } from "./helpers/seed.js";
import { bootApp } from "./helpers/boot.js";

// Photo Inbox reviewers (docs/system-data-plan.md, phase 4, decision 21): the Inbox
// has no library access rules. Admins always review; anyone else reviews because
// an admin named them, at "details" (write on the photos) or "keep" (also keep,
// discard and drop links).

const ADMIN = { id: "admin", role: "admin" };
const MEMBER = { id: "mia", role: "member" };
const OTHER = { id: "olga", role: "member" };

const role = (subjectType: string, subjectId: string, objectType: string, objectId: string) =>
  (db.prepare("SELECT role FROM assignments WHERE subject_type = ? AND subject_id = ? AND object_type = ? AND object_id = ?")
    .get(subjectType, subjectId, objectType, objectId) as { role: string } | undefined)?.role ?? null;

function makeGroup(id: string): void {
  db.prepare("INSERT INTO user_groups (id, name, created_by) VALUES (?, ?, 'admin')").run(id, id);
}

function photo(id: string): void {
  db.prepare("INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES (?, 'INBOX', 'gallery', ?, 'ready')").run(id, `box/${id}.jpg`);
  db.prepare("INSERT INTO gallery_details (item_id, kind, relative_path) VALUES (?, 'photo', ?)").run(id, `box/${id}.jpg`);
}

beforeEach(() => {
  resetDb();
  makeUser("admin", "admin");
  makeUser("mia", "member");
  makeUser("olga", "member");
  makeLibrary("INBOX", { createdBy: "admin", type: "gallery", policyJson: JSON.stringify({ mode: "managed" }), role: "inbox" });
  makeLibrary("GAL", { createdBy: "admin", type: "gallery" });
  grant("group", EVERYONE_GROUP_ID, "GAL", "member");
});

describe("who reviews", () => {
  it("is admins, even with no grant at all, and nobody else until named", () => {
    photo("p1");
    expect(canUserAccessLibrary({ id: "INBOX" }, ADMIN.id, ADMIN.role)).toBe(true);
    expect(can(ADMIN, { objectType: "library", objectId: "INBOX" }, "delete")).toBe(true);
    expect(canUserAccessLibrary({ id: "INBOX" }, MEMBER.id, MEMBER.role)).toBe(false);
    expect(listPhotoInboxes(MEMBER)).toEqual([]);
  });

  it("ignores grants left on the library itself", () => {
    grant("group", EVERYONE_GROUP_ID, "INBOX", "manager");
    expect(canUserAccessLibrary({ id: "INBOX" }, MEMBER.id, MEMBER.role)).toBe(false);
  });

  it("gives details the write right and keep the delete right, through a group too", () => {
    photo("p1");
    grantReviewer("user", "mia", "details");
    makeGroup("sorters");
    addToGroup("sorters", "olga");
    grantReviewer("group", "sorters", "keep");

    expect(listPhotoInboxes(MEMBER)[0]).toMatchObject({ canEdit: true, canReview: false });
    expect(listPhotoInboxes(OTHER)[0]).toMatchObject({ canEdit: true, canReview: true });
  });

  it("leaves every other library to its own rules", () => {
    grantReviewer("group", EVERYONE_GROUP_ID, "keep");
    expect(can(MEMBER, { objectType: "library", objectId: "GAL" }, "delete")).toBe(false);
    expect(canUserAccessLibrary({ id: "GAL" }, MEMBER.id, MEMBER.role)).toBe(true);
  });
});

describe("upgrading (migration 76)", () => {
  it("turns the Inbox's grants into reviewers and removes them from the library", () => {
    makeGroup("family");
    grant("group", EVERYONE_GROUP_ID, "INBOX", "viewer");
    grant("user", "mia", "INBOX", "member");
    grant("group", "family", "INBOX", "manager");
    grant("user", "olga", "INBOX", "deny");
    grant("user", "admin", "INBOX", "manager");
    db.prepare("UPDATE libraries SET owner_id = 'mia', owner_type = 'user' WHERE id = 'INBOX'").run();

    migrateInboxReviewers(db);

    expect(role("group", EVERYONE_GROUP_ID, "photo_inbox", "reviewers")).toBe("contributor");
    expect(role("user", "mia", "photo_inbox", "reviewers")).toBe("contributor");
    expect(role("group", "family", "photo_inbox", "reviewers")).toBe("manager");
    expect(role("user", "olga", "photo_inbox", "reviewers")).toBeNull();
    expect(role("user", "admin", "photo_inbox", "reviewers")).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM assignments WHERE object_type = 'library' AND object_id = 'INBOX'").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT owner_id FROM libraries WHERE id = 'INBOX'").get()).toEqual({ owner_id: null });
    // Other libraries keep theirs.
    expect(role("group", EVERYONE_GROUP_ID, "library", "GAL")).toBe("member");
  });

  it("changes nothing without an Inbox", () => {
    db.prepare("DELETE FROM libraries WHERE id = 'INBOX'").run();
    migrateInboxReviewers(db);
    expect(db.prepare("SELECT COUNT(*) AS n FROM assignments WHERE object_type = 'photo_inbox'").get()).toEqual({ n: 0 });
  });
});

describe("a library becoming the Inbox", () => {
  it("carries its grants across, never lowering a reviewer already named", () => {
    db.prepare("UPDATE libraries SET role = NULL WHERE id = 'INBOX'").run();
    grant("user", "mia", "GAL", "viewer");
    grantReviewer("user", "olga", "keep");
    grant("user", "olga", "GAL", "contributor");

    setSystemLibraryRole("inbox", "GAL");

    expect(role("user", "mia", "photo_inbox", "reviewers")).toBe("contributor");
    expect(role("user", "olga", "photo_inbox", "reviewers")).toBe("manager");
    expect(role("group", EVERYONE_GROUP_ID, "photo_inbox", "reviewers")).toBe("contributor");
    expect(db.prepare("SELECT COUNT(*) AS n FROM assignments WHERE object_type = 'library' AND object_id = 'GAL'").get()).toEqual({ n: 0 });
  });
});

describe("routes", () => {
  let app: FastifyInstance;
  let signIn: (userId: string) => Promise<string>;
  beforeEach(async () => {
    ({ app, signIn } = await bootApp({ plugins: [appStorageRoutesPlugin, libraryMembersPlugin] }));
  });

  it("lists, names, changes and removes reviewers, for admins only", async () => {
    const cookie = await signIn("admin");
    const url = "/api/storage/app-storage/parts/inbox/reviewers";

    const empty = await app.inject({ method: "GET", url, headers: { cookie } });
    expect(empty.json()).toMatchObject({ reviewers: [], everyone: null });
    // Admins are not offered: they always review.
    expect(empty.json().candidates.users.map((u: { id: string }) => u.id).sort()).toEqual(["mia", "olga"]);

    const named = await app.inject({ method: "POST", url, headers: { cookie }, payload: { subjectType: "user", subjectId: "mia", level: "details" } });
    expect(named.statusCode).toBe(200);
    expect(named.json().reviewers).toMatchObject([{ subjectType: "user", subjectId: "mia", level: "details" }]);

    await app.inject({ method: "POST", url, headers: { cookie }, payload: { subjectType: "user", subjectId: "mia", level: "keep" } });
    expect(inboxReviewersView().reviewers[0].level).toBe("keep");

    const everyone = await app.inject({ method: "PUT", url: `${url}/everyone`, headers: { cookie }, payload: { level: "details" } });
    expect(everyone.json().everyone).toBe("details");
    await app.inject({ method: "PUT", url: `${url}/everyone`, headers: { cookie }, payload: { level: null } });
    expect(inboxReviewersView().everyone).toBeNull();

    expect((await app.inject({ method: "POST", url, headers: { cookie }, payload: { subjectType: "user", subjectId: "admin", level: "keep" } })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url, headers: { cookie }, payload: { subjectType: "user", subjectId: "nobody", level: "keep" } })).statusCode).toBe(404);

    expect((await app.inject({ method: "DELETE", url: `${url}/user/mia`, headers: { cookie } })).json().reviewers).toEqual([]);
    expect((await app.inject({ method: "DELETE", url: `${url}/user/mia`, headers: { cookie } })).statusCode).toBe(404);

    const member = await signIn("mia");
    expect((await app.inject({ method: "GET", url, headers: { cookie: member } })).statusCode).toBe(403);
  });

  it("refuses the library members editor on the Inbox", async () => {
    const cookie = await signIn("admin");
    expect((await app.inject({ method: "GET", url: "/api/library/libraries/INBOX/members", headers: { cookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/library/libraries/INBOX/members", headers: { cookie }, payload: { subjectType: "user", subjectId: "mia", role: "viewer" } })).statusCode).toBe(403);
  });
});
