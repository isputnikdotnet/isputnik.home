// Tag-scoped family-tree edit rights: tags on persons double as permission
// scopes (assignments with object_type 'family_tree_tag'). Covers the access
// helpers directly and the route guards via fastify.inject with stubbed auth
// decorators (the real ones live in core; only request.user matters here).
import { beforeEach, describe, expect, it } from "vitest";
import fastify, { type FastifyInstance } from "fastify";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { familyTreeRoutesPlugin } from "../src/modules/familytree/routes.js";
import { createFamilyPerson, deleteFamilyPerson, getFamilyPerson } from "../src/modules/familytree/persons.js";
import { createFamilySource } from "../src/modules/familytree/sources.js";
import {
  canEditPerson, canEditTree, decoratePersons, getEditableTags, listFamilyTags
} from "../src/modules/familytree/access.js";
import { resetDb, makeUser, makeGroup, addToGroup, grant } from "./helpers/seed.js";

const admin = { id: "admin", role: "admin" };
const editor = { id: "editor", role: "member" };
const outsider = { id: "outsider", role: "member" };

const tagId = (name: string): string =>
  (db.prepare("SELECT id FROM tags WHERE display_name = ?").get(name) as { id: string }).id;

// Persons named per branch: Smirnov (editable by `editor`), Petrov (not).
function seedBranches() {
  const smirnov = createFamilyPerson({ name: "Ivan Smirnov" }, "admin", ["Smirnov"]);
  const petrov = createFamilyPerson({ name: "Pavel Petrov" }, "admin", ["Petrov"]);
  const untagged = createFamilyPerson({ name: "Nobody Nowhere" }, "admin");
  grant("user", "editor", tagId("Smirnov"), "contributor", "family_tree_tag");
  return { smirnov, petrov, untagged };
}

beforeEach(() => {
  resetDb();
  makeUser("admin", "admin");
  makeUser("editor");
  makeUser("outsider");
});

describe("family-tree access helpers", () => {
  it("resolves editable tags from user and group grants, honoring deny", () => {
    seedBranches();
    expect(getEditableTags(admin)).toBe("all");
    expect((getEditableTags(editor) as { name: string }[]).map((t) => t.name)).toEqual(["Smirnov"]);
    expect(getEditableTags(outsider)).toEqual([]);

    // A group grant extends the scope; a personal deny on the same tag blocks it.
    makeGroup("family", "admin");
    addToGroup("family", "outsider");
    grant("group", "family", tagId("Petrov"), "contributor", "family_tree_tag");
    expect((getEditableTags(outsider) as { name: string }[]).map((t) => t.name)).toEqual(["Petrov"]);
    grant("user", "outsider", tagId("Petrov"), "deny", "family_tree_tag");
    expect(getEditableTags(outsider)).toEqual([]);
  });

  it("gates person edits by tag and reports tree-level capability", () => {
    const { smirnov, petrov, untagged } = seedBranches();
    expect(canEditPerson(editor, smirnov.id)).toBe(true);
    expect(canEditPerson(editor, petrov.id)).toBe(false);
    expect(canEditPerson(editor, untagged.id)).toBe(false);
    expect(canEditPerson(admin, untagged.id)).toBe(true);
    expect(canEditTree(editor)).toBe(true);
    expect(canEditTree(outsider)).toBe(false);
  });

  it("decorates persons with tags and canEdit in bulk", () => {
    const { smirnov, petrov, untagged } = seedBranches();
    const decorated = decoratePersons(editor, [smirnov, petrov, untagged]);
    expect(decorated.map((p) => ({ tags: p.tags, canEdit: p.canEdit }))).toEqual([
      { tags: ["Smirnov"], canEdit: true },
      { tags: ["Petrov"], canEdit: false },
      { tags: [], canEdit: false }
    ]);
    expect(decoratePersons(admin, [untagged])[0].canEdit).toBe(true);
  });

  it("lists family tags with usage and editor counts", () => {
    seedBranches();
    expect(listFamilyTags()).toMatchObject([
      { name: "Petrov", count: 1, editorCount: 0 },
      { name: "Smirnov", count: 1, editorCount: 1 }
    ]);
  });

  it("cleans up tag links when a person is deleted", () => {
    const { smirnov } = seedBranches();
    deleteFamilyPerson(smirnov.id);
    expect(db.prepare(
      "SELECT COUNT(*) AS n FROM taggables WHERE entity_type = 'family_tree_person' AND entity_id = ?"
    ).get(smirnov.id)).toEqual({ n: 0 });
  });
});

describe("family-tree route guards", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = fastify();
    // Stubbed auth: X-Test-User picks the account; the real decorators are
    // session-based core code that is out of scope here.
    app.decorate("authenticate", async (request, reply) => {
      const id = request.headers["x-test-user"] as string | undefined;
      const row = id
        ? db.prepare("SELECT id, role FROM users WHERE id = ?").get(id) as { id: string; role: string } | undefined
        : undefined;
      if (!row) {
        reply.code(401).send({ error: "Unauthenticated" });
        return;
      }
      request.user = row as never;
    });
    app.decorate("requireAdmin", async (request, reply) => {
      await app.authenticate(request, reply);
      if (reply.sent) return;
      if (request.user?.role !== "admin") reply.code(403).send({ error: "Admin only" });
    });
    await app.register(familyTreeRoutesPlugin);
  });

  // No content-type here: fastify.inject infers JSON from object payloads, and
  // a JSON content-type on a body-less DELETE would 400 before the guard runs.
  const asUser = (userId: string) => ({ headers: { "x-test-user": userId } });

  it("lets a branch editor edit tagged persons only, and never their tags", async () => {
    const { smirnov, petrov } = seedBranches();

    const ok = await app.inject({
      method: "PATCH", url: `/api/family-tree/persons/${smirnov.id}`, ...asUser("editor"),
      payload: { bio: "Updated by the branch editor" }
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().person).toMatchObject({ bio: "Updated by the branch editor", tags: ["Smirnov"], canEdit: true });

    const wrongBranch = await app.inject({
      method: "PATCH", url: `/api/family-tree/persons/${petrov.id}`, ...asUser("editor"),
      payload: { bio: "Nope" }
    });
    expect(wrongBranch.statusCode).toBe(403);

    const tagChange = await app.inject({
      method: "PATCH", url: `/api/family-tree/persons/${smirnov.id}`, ...asUser("editor"),
      payload: { tags: ["Smirnov", "Petrov"] }
    });
    expect(tagChange.statusCode).toBe(403);

    // Admins may retag freely.
    const adminTag = await app.inject({
      method: "PATCH", url: `/api/family-tree/persons/${smirnov.id}`, ...asUser("admin"),
      payload: { tags: ["Smirnov", "Merchant line"] }
    });
    expect(adminTag.statusCode).toBe(200);
    expect(adminTag.json().person.tags).toEqual(["Merchant line", "Smirnov"]);
  });

  it("auto-tags persons created by a branch editor and validates chosen tags", async () => {
    seedBranches();

    const created = await app.inject({
      method: "POST", url: "/api/family-tree/persons", ...asUser("editor"),
      payload: { name: "Olga Smirnova" }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().person).toMatchObject({ tags: ["Smirnov"], canEdit: true });

    const badTag = await app.inject({
      method: "POST", url: "/api/family-tree/persons", ...asUser("editor"),
      payload: { name: "Sneaky", tags: ["Petrov"] }
    });
    expect(badTag.statusCode).toBe(403);

    const noRights = await app.inject({
      method: "POST", url: "/api/family-tree/persons", ...asUser("outsider"),
      payload: { name: "Anyone" }
    });
    expect(noRights.statusCode).toBe(403);
  });

  it("allows relationship changes only when an involved person is editable", async () => {
    const { smirnov, petrov, untagged } = seedBranches();

    // Marrying a person from another branch into an editable one is the point.
    const marryIn = await app.inject({
      method: "POST", url: "/api/family-tree/unions", ...asUser("editor"),
      payload: { person1Id: smirnov.id, person2Id: petrov.id }
    });
    expect(marryIn.statusCode).toBe(201);

    const foreign = await app.inject({
      method: "POST", url: "/api/family-tree/unions", ...asUser("editor"),
      payload: { person1Id: petrov.id, person2Id: untagged.id }
    });
    expect(foreign.statusCode).toBe(403);

    // Children: the editable person may be the child being linked.
    const child = createFamilyPerson({ name: "Kid Smirnov" }, "admin", ["Smirnov"]);
    const unionId = marryIn.json().union.id as string;
    const addChild = await app.inject({
      method: "POST", url: `/api/family-tree/unions/${unionId}/children`, ...asUser("editor"),
      payload: { childId: child.id }
    });
    expect(addChild.statusCode).toBe(201);

    // Removing relationships stays admin-only.
    const removeChild = await app.inject({
      method: "DELETE", url: `/api/family-tree/unions/${unionId}/children/${child.id}`, ...asUser("editor")
    });
    expect(removeChild.statusCode).toBe(403);
    const removeUnion = await app.inject({
      method: "DELETE", url: `/api/family-tree/unions/${unionId}`, ...asUser("editor")
    });
    expect(removeUnion.statusCode).toBe(403);
  });

  it("scopes events and citations to editable persons; sources stay admin-only", async () => {
    const { smirnov, petrov } = seedBranches();

    const event = await app.inject({
      method: "POST", url: `/api/family-tree/persons/${smirnov.id}/events`, ...asUser("editor"),
      payload: { type: "occupation", label: "Blacksmith" }
    });
    expect(event.statusCode).toBe(201);

    const foreignEvent = await app.inject({
      method: "POST", url: `/api/family-tree/persons/${petrov.id}/events`, ...asUser("editor"),
      payload: { type: "occupation", label: "Nope" }
    });
    expect(foreignEvent.statusCode).toBe(403);

    const source = createFamilySource({ title: "Parish register" });
    const cite = await app.inject({
      method: "POST", url: "/api/family-tree/citations", ...asUser("editor"),
      payload: { sourceId: source.id, personId: smirnov.id, fact: "birth" }
    });
    expect(cite.statusCode).toBe(201);

    const newSource = await app.inject({
      method: "POST", url: "/api/family-tree/sources", ...asUser("editor"),
      payload: { title: "My own source" }
    });
    expect(newSource.statusCode).toBe(403);
  });

  it("keeps destructive and administrative routes admin-only", async () => {
    const { smirnov } = seedBranches();

    const del = await app.inject({
      method: "DELETE", url: `/api/family-tree/persons/${smirnov.id}`, ...asUser("editor")
    });
    expect(del.statusCode).toBe(403);
    expect(getFamilyPerson(smirnov.id)).not.toBeNull();

    const gedcom = await app.inject({
      method: "POST", url: "/api/family-tree/import", ...asUser("editor"),
      payload: { gedcom: "0 @I1@ INDI" }
    });
    expect(gedcom.statusCode).toBe(403);

    const editors = await app.inject({
      method: "GET", url: `/api/family-tree/tags/${tagId("Smirnov")}/editors`, ...asUser("editor")
    });
    expect(editors.statusCode).toBe(403);
  });

  it("manages tag grants through the admin editors API", async () => {
    seedBranches();
    const smirnovTag = tagId("Smirnov");

    const granted = await app.inject({
      method: "POST", url: `/api/family-tree/tags/${smirnovTag}/editors`, ...asUser("admin"),
      payload: { subjectType: "user", subjectId: "outsider", role: "contributor" }
    });
    expect(granted.statusCode).toBe(201);
    expect(canEditTree(outsider)).toBe(true);

    const list = await app.inject({
      method: "GET", url: `/api/family-tree/tags/${smirnovTag}/editors`, ...asUser("admin")
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().editors).toHaveLength(2); // editor (seed) + outsider

    const revoked = await app.inject({
      method: "DELETE", url: `/api/family-tree/tags/${smirnovTag}/editors/user/outsider`, ...asUser("admin")
    });
    expect(revoked.statusCode).toBe(200);
    expect(canEditTree(outsider)).toBe(false);
  });

  it("exposes tags, canEdit, and access on the browse payloads", async () => {
    seedBranches();
    // An Everyone grant makes every signed-in user an editor of that branch.
    grant("group", EVERYONE_GROUP_ID, tagId("Petrov"), "contributor", "family_tree_tag");

    const tree = await app.inject({ method: "GET", url: "/api/family-tree/tree", ...asUser("outsider") });
    expect(tree.statusCode).toBe(200);
    const payload = tree.json();
    expect(payload.access).toEqual({ isAdmin: false, canAdd: true });
    const byName = Object.fromEntries(payload.persons.map((p: { name: string; canEdit: boolean }) => [p.name, p.canEdit]));
    expect(byName).toEqual({ "Ivan Smirnov": false, "Pavel Petrov": true, "Nobody Nowhere": false });

    const tags = await app.inject({ method: "GET", url: "/api/family-tree/tags", ...asUser("outsider") });
    expect(tags.json().tags.map((t: { name: string }) => t.name)).toEqual(["Petrov", "Smirnov"]);
  });
});
