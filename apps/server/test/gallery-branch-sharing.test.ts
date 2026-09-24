// Sharing a branch of the family tree as photos (docs/people-sharing-plan.md, Q2):
// every tree member tagged with the branch who is linked to a gallery person —
// including relatives added to the branch later — through one grant, for a user
// or a group, with a person-level deny still winning.
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { applyFamilyPersonTags, createFamilyPerson } from "../src/modules/familytree/persons.js";
import { galleryRoutesPlugin } from "../src/modules/library/gallery/routes.js";
import { galleryPeopleAccessRoutesPlugin } from "../src/modules/library/gallery/people-access-routes.js";
import { bootApp } from "./helpers/boot.js";
import { addToGroup, grant, makeGroup, makeLibrary, makeUser, resetDb } from "./helpers/seed.js";

let app: FastifyInstance;
let signIn: (userId: string) => Promise<string>;
let branchId: string;

function photo(id: string, personId: string) {
  db.prepare("INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES (?, 'fam', 'gallery', ?, 'ready')").run(id, `Private/${id}.jpg`);
  db.prepare("INSERT INTO gallery_details (item_id, kind, relative_path, size) VALUES (?, 'photo', ?, 1)").run(id, `Private/${id}.jpg`);
  db.prepare("INSERT INTO gallery_faces (id, item_id, person_id, assignment, source) VALUES (?, ?, ?, 'confirmed', 'manual')").run(`f-${id}`, id, personId);
}

function member(name: string, galleryPersonId: string | null, branch: string | null) {
  const person = createFamilyPerson({ name }, "admin");
  if (galleryPersonId) db.prepare("UPDATE family_tree_persons SET gallery_person_id = ? WHERE id = ?").run(galleryPersonId, person.id);
  if (branch) applyFamilyPersonTags([person.id], [branch], []);
  return person.id;
}

beforeEach(async () => {
  resetDb();
  makeUser("admin", "admin");
  makeUser("cousin", "member");
  makeGroup("relatives", "admin");
  makeLibrary("fam", { createdBy: "admin", type: "gallery", ownerId: "admin", ownerType: "user" });
  grant("user", "admin", "fam", "manager");
  db.prepare("INSERT INTO gallery_people (id, name) VALUES ('ivan', 'Ivan'), ('olga', 'Olga'), ('boris', 'Boris'), ('stranger', 'Stranger')").run();
  for (const [id, person] of [["p-ivan", "ivan"], ["p-olga", "olga"], ["p-boris", "boris"], ["p-stranger", "stranger"]]) photo(id, person);
  member("Ivan Posse", "ivan", "Posse");
  member("Olga Posse", "olga", "Posse");
  member("Unlinked Posse", null, "Posse");
  member("Stranger", "stranger", "Other");
  branchId = (db.prepare("SELECT id FROM tags WHERE display_name = 'Posse'").get() as { id: string }).id;
  ({ app, signIn } = await bootApp({ plugins: [galleryRoutesPlugin, galleryPeopleAccessRoutesPlugin] }));
});

afterEach(async () => { await app.close(); });

const admin = async (method: "PUT" | "DELETE" | "GET", url: string) => app.inject({ method, url, headers: { cookie: await signIn("admin") } });
const timelineOf = async (userId: string) => ((await app.inject({
  method: "POST", url: "/api/library/gallery/timeline", headers: { cookie: await signIn(userId) }, payload: { q: "", kinds: [], limit: 20, offset: 0 }
})).json().assets as { id: string }[]).map((a) => a.id).sort();

describe("sharing a branch of the family tree", () => {
  it("shares every linked member, and relatives tagged into it later", async () => {
    expect((await admin("PUT", `/api/library/gallery/branches/${branchId}/sharing/user/cousin`)).statusCode).toBe(200);
    expect(await timelineOf("cousin")).toEqual(["p-ivan", "p-olga"]);

    member("Boris Posse", "boris", "Posse");
    expect(await timelineOf("cousin")).toEqual(["p-boris", "p-ivan", "p-olga"]);

    const access = (await admin("GET", "/api/library/gallery/access/user/cousin")).json();
    expect(access.branches).toMatchObject([{ id: branchId, name: "Posse", direct: true, people: 3, photos: 3 }]);
    expect(access.allBranches.map((b: { name: string }) => b.name).sort()).toEqual(["Other", "Posse"]);
    expect(access.photoCount).toBe(3);

    const sharing = (await admin("GET", "/api/library/gallery/people/ivan/sharing")).json();
    expect(sharing.viaBranches).toMatchObject([{ branchName: "Posse", subjectType: "user", subjectId: "cousin" }]);

    await admin("DELETE", `/api/library/gallery/branches/${branchId}/sharing/user/cousin`);
    expect(await timelineOf("cousin")).toEqual([]);
  });

  it("works through a group, and a person denied to them stays out", async () => {
    addToGroup("relatives", "cousin");
    await admin("PUT", `/api/library/gallery/branches/${branchId}/sharing/group/relatives`);
    grant("user", "cousin", "olga", "deny", "gallery_person");
    expect(await timelineOf("cousin")).toEqual(["p-ivan"]);
    const access = (await admin("GET", "/api/library/gallery/access/user/cousin")).json();
    expect(access.branches).toMatchObject([{ direct: false, viaGroups: [{ id: "relatives" }] }]);
  });

  it("takes only a branch of the tree, and only from an admin", async () => {
    const bookTag = db.prepare("INSERT INTO tags (id, key, display_name) VALUES ('t-book', 'scifi', 'Sci-fi') RETURNING id").get() as { id: string };
    expect((await admin("PUT", `/api/library/gallery/branches/${bookTag.id}/sharing/user/cousin`)).statusCode).toBe(404);
    const refused = await app.inject({ method: "PUT", url: `/api/library/gallery/branches/${branchId}/sharing/user/cousin`, headers: { cookie: await signIn("cousin") } });
    expect(refused.statusCode).toBe(403);
  });
});
