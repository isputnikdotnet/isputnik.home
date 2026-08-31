// Bulk family tagging: assigning one tag to a whole branch at once. Tags are
// the family tree's permission boundary (access.ts), so these routes stay
// admin-only, and the graph expansion behind "Add relatives" has to follow
// unions and children rather than surnames.
import { beforeEach, describe, expect, it } from "vitest";
import fastify, { type FastifyInstance } from "fastify";
import { db } from "../src/db.js";
import { familyTreeRoutesPlugin } from "../src/modules/familytree/routes.js";
import { applyFamilyPersonTags, createFamilyPerson, expandToRelatives } from "../src/modules/familytree/persons.js";
import { createUnion, addChild } from "../src/modules/familytree/relations.js";
import { resetDb, makeUser } from "./helpers/seed.js";

// Two disconnected households. The Smirnovs: Ivan married Anna (who kept her
// own surname), one child. The Petrovs stand apart entirely.
function seedHouseholds() {
  const ivan = createFamilyPerson({ name: "Ivan Smirnov" }, "admin", ["Smirnov"]);
  const anna = createFamilyPerson({ name: "Anna Volkova" }, "admin");
  const kid = createFamilyPerson({ name: "Olga Smirnova" }, "admin");
  const stranger = createFamilyPerson({ name: "Pavel Petrov" }, "admin", ["Petrov"]);
  const created = createUnion(ivan.id, anna.id, {});
  if ("error" in created) throw new Error(created.error);
  const link = addChild(created.union.id, kid.id, "biological");
  if ("error" in link) throw new Error(link.error);
  return { ivan, anna, kid, stranger };
}

const tagsOf = (personId: string): string[] =>
  (db.prepare(`
    SELECT tags.display_name AS name FROM taggables
    JOIN tags ON tags.id = taggables.tag_id
    WHERE taggables.entity_type = 'family_tree_person' AND taggables.entity_id = ?
    ORDER BY name
  `).all(personId) as { name: string }[]).map((row) => row.name);

beforeEach(() => {
  resetDb();
  makeUser("admin", "admin");
  makeUser("member");
});

describe("expandToRelatives", () => {
  it("walks unions and children, and stops at the edge of the household", () => {
    const { ivan, anna, kid, stranger } = seedHouseholds();
    // Seeding on the child reaches both parents; the married-in spouse comes
    // along despite sharing no surname, and the unrelated person does not.
    expect(expandToRelatives([kid.id]).sort()).toEqual([anna.id, ivan.id, kid.id].sort());
    expect(expandToRelatives([stranger.id])).toEqual([stranger.id]);
    expect(expandToRelatives([kid.id, stranger.id]).sort())
      .toEqual([anna.id, ivan.id, kid.id, stranger.id].sort());
  });

  it("includes seeds once and drops ids that are not people", () => {
    const { ivan, anna, kid } = seedHouseholds();
    expect(expandToRelatives([ivan.id, ivan.id, kid.id]).sort()).toEqual([anna.id, ivan.id, kid.id].sort());
    expect(expandToRelatives(["ghost"])).toEqual([]);
  });
});

describe("applyFamilyPersonTags", () => {
  it("adds without replacing the existing tag set and removes only what is named", () => {
    const { ivan, anna } = seedHouseholds();
    applyFamilyPersonTags([ivan.id, anna.id], ["Merchant line"], []);
    // Ivan keeps Smirnov — a bulk add must never overwrite a person's branches.
    expect(tagsOf(ivan.id)).toEqual(["Merchant line", "Smirnov"]);
    expect(tagsOf(anna.id)).toEqual(["Merchant line"]);

    applyFamilyPersonTags([ivan.id, anna.id], [], ["Merchant line"]);
    expect(tagsOf(ivan.id)).toEqual(["Smirnov"]);
    expect(tagsOf(anna.id)).toEqual([]);
  });

  it("is idempotent and ignores tags that were never used", () => {
    const { ivan } = seedHouseholds();
    applyFamilyPersonTags([ivan.id], ["Smirnov"], ["Nonexistent"]);
    expect(tagsOf(ivan.id)).toEqual(["Smirnov"]);
  });
});

describe("bulk tag routes", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = fastify();
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

  const asUser = (userId: string) => ({ headers: { "x-test-user": userId } });

  it("tags a whole household and returns the decorated persons", async () => {
    const { ivan, anna, kid, stranger } = seedHouseholds();

    const relatives = await app.inject({
      method: "POST", url: "/api/family-tree/persons/relatives", ...asUser("member"),
      payload: { personIds: [kid.id] }
    });
    expect(relatives.statusCode).toBe(200);
    const ids = relatives.json().personIds as string[];
    expect(ids.sort()).toEqual([anna.id, ivan.id, kid.id].sort());

    const tagged = await app.inject({
      method: "POST", url: "/api/family-tree/persons/tags", ...asUser("admin"),
      payload: { personIds: ids, add: ["Smirnov household"] }
    });
    expect(tagged.statusCode).toBe(200);
    expect(tagged.json().persons).toHaveLength(3);
    expect(tagsOf(ivan.id)).toEqual(["Smirnov", "Smirnov household"]);
    expect(tagsOf(stranger.id)).toEqual(["Petrov"]);
    // The response carries what the grid needs to re-render without a reload.
    expect(tagged.json().persons.find((p: { id: string }) => p.id === ivan.id))
      .toMatchObject({ tags: ["Smirnov", "Smirnov household"], canEdit: true });
  });

  it("keeps tag assignment admin-only and rejects empty changes", async () => {
    const { ivan } = seedHouseholds();

    const member = await app.inject({
      method: "POST", url: "/api/family-tree/persons/tags", ...asUser("member"),
      payload: { personIds: [ivan.id], add: ["Anything"] }
    });
    expect(member.statusCode).toBe(403);

    const nothingToDo = await app.inject({
      method: "POST", url: "/api/family-tree/persons/tags", ...asUser("admin"),
      payload: { personIds: [ivan.id] }
    });
    expect(nothingToDo.statusCode).toBe(400);

    const noPeople = await app.inject({
      method: "POST", url: "/api/family-tree/persons/tags", ...asUser("admin"),
      payload: { personIds: [], add: ["Anything"] }
    });
    expect(noPeople.statusCode).toBe(400);
  });

  it("drops ids that no longer exist rather than failing the whole batch", async () => {
    const { ivan } = seedHouseholds();

    const partly = await app.inject({
      method: "POST", url: "/api/family-tree/persons/tags", ...asUser("admin"),
      payload: { personIds: [ivan.id, "ghost"], add: ["Merchant line"] }
    });
    expect(partly.statusCode).toBe(200);
    expect(partly.json().persons).toHaveLength(1);
    expect(tagsOf(ivan.id)).toEqual(["Merchant line", "Smirnov"]);

    const allGone = await app.inject({
      method: "POST", url: "/api/family-tree/persons/tags", ...asUser("admin"),
      payload: { personIds: ["ghost"], add: ["Merchant line"] }
    });
    expect(allGone.statusCode).toBe(404);
  });
});
