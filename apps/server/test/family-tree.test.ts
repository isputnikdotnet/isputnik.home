import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import {
  partialDateSchema,
  createFamilyPerson,
  getFamilyPerson,
  getFamilyPersonProfile,
  listFamilyPersons,
  updateFamilyPerson,
  deleteFamilyPerson,
  getFamilyTree,
  isAncestorOf
} from "../src/modules/familytree/persons.js";
import {
  createUnion,
  updateUnion,
  setUnionPartner,
  deleteUnion,
  addChild,
  removeChild,
  getUnion
} from "../src/modules/familytree/relations.js";
import {
  createFamilyEvent,
  updateFamilyEvent,
  deleteFamilyEvent,
  listFamilyEvents
} from "../src/modules/familytree/events.js";
import {
  createFamilySource,
  updateFamilySource,
  deleteFamilySource,
  listFamilySources,
  createFamilyCitation,
  updateFamilyCitation,
  deleteFamilyCitation,
  listPersonCitations
} from "../src/modules/familytree/sources.js";
import { resetDb, makeUser } from "./helpers/seed.js";

beforeEach(() => {
  resetDb();
  makeUser("admin", "admin");
});

const person = (name: string, fields = {}) => createFamilyPerson({ name, ...fields }, "admin");

// Convenience: a two-parent union with children attached, asserting each step.
function family(parent1: string, parent2: string | null, childIds: string[] = []) {
  const result = createUnion(parent1, parent2, {});
  if ("error" in result) throw new Error(`createUnion failed: ${result.error}`);
  for (const childId of childIds) {
    const added = addChild(result.union.id, childId, "biological");
    if ("error" in added) throw new Error(`addChild failed: ${added.error}`);
  }
  return result.union;
}

describe("partial dates", () => {
  it("accepts year, year-month, and full dates", () => {
    for (const value of ["1943", "1943-05", "1943-05-09", "2024-02-29"]) {
      expect(partialDateSchema.safeParse(value).success, value).toBe(true);
    }
  });

  it("rejects malformed and impossible dates", () => {
    for (const value of ["43", "1943-13", "1943-00", "1943-05-40", "1943-02-30", "2023-02-29", "05-1943", "1943/05"]) {
      expect(partialDateSchema.safeParse(value).success, value).toBe(false);
    }
  });
});

describe("family events", () => {
  it("creates, updates, deletes, and lists events chronologically", () => {
    const p = person("Anna");
    expect(createFamilyEvent("missing", { type: "residence" })).toBeNull();

    const school = createFamilyEvent(p.id, { type: "education", label: "School #5", date: "1971", endDate: "1975" })!;
    createFamilyEvent(p.id, { type: "custom", label: "Award" }); // undated → sorts last
    createFamilyEvent(p.id, { type: "occupation", label: "Engineer", date: "1980", place: "Minsk" });

    expect(listFamilyEvents(p.id).map((e) => e.label)).toEqual(["School #5", "Engineer", "Award"]);

    const updated = updateFamilyEvent(school.id, { label: "School #7", endDate: null });
    expect(updated).toMatchObject({ label: "School #7", date: "1971", endDate: null });
    expect(updateFamilyEvent("missing", { label: "X" })).toBeNull();

    expect(deleteFamilyEvent(school.id)).toBe(true);
    expect(listFamilyEvents(p.id)).toHaveLength(2);

    // Deleting the person cascades their events.
    deleteFamilyPerson(p.id);
    expect(listFamilyEvents(p.id)).toHaveLength(0);
  });
});

describe("family sources & citations", () => {
  it("creates sources and cites them on persons, events, and unions", () => {
    const p = person("Anna");
    const source = createFamilySource({ title: "Church book", url: "https://example.org/book" });
    expect(listFamilySources()).toMatchObject([{ title: "Church book", citationCount: 0 }]);

    const result = createFamilyCitation({ sourceId: source.id, personId: p.id, fact: "birth", detail: "p. 14" });
    if ("error" in result) throw new Error(result.error);
    expect(result.citation).toMatchObject({ sourceTitle: "Church book", fact: "birth", detail: "p. 14" });

    // Exactly one target, and it must exist.
    expect(createFamilyCitation({ sourceId: source.id })).toEqual({ error: "bad_target" });
    expect(createFamilyCitation({ sourceId: source.id, personId: p.id, eventId: "e1" })).toEqual({ error: "bad_target" });
    expect(createFamilyCitation({ sourceId: "missing", personId: p.id })).toEqual({ error: "source_not_found" });
    expect(createFamilyCitation({ sourceId: source.id, personId: "missing" })).toEqual({ error: "target_not_found" });

    const updated = updateFamilyCitation(result.citation.id, { detail: null, note: "Faded ink." });
    expect(updated).toMatchObject({ detail: null, note: "Faded ink." });

    expect(updateFamilySource(source.id, { author: "Fr. Pavel" })).toMatchObject({ author: "Fr. Pavel", citationCount: 1 });

    // A partner sees union citations on their profile too.
    const p2 = person("Boris");
    const union = family(p.id, p2.id);
    const unionCite = createFamilyCitation({ sourceId: source.id, unionId: union.id, fact: "marriage" });
    if ("error" in unionCite) throw new Error(unionCite.error);
    expect(listPersonCitations(p2.id)).toHaveLength(1);
    expect(listPersonCitations(p.id)).toHaveLength(2);

    expect(deleteFamilyCitation(result.citation.id)).toBe(true);
    // Deleting the source cascades its remaining citations.
    expect(deleteFamilySource(source.id)).toBe(true);
    expect(listPersonCitations(p.id)).toHaveLength(0);
  });
});

describe("family tree persons", () => {
  it("creates, lists, and searches persons", () => {
    person("Anna Petrova", { maidenName: "Ivanova", gender: "female", birthDate: "1950-03", birthplace: "Minsk" });
    person("Boris Petrov", { gender: "male", birthDate: "1948" });

    const all = listFamilyPersons();
    expect(all.map((p) => p.name)).toEqual(["Anna Petrova", "Boris Petrov"]);
    expect(all[0]).toMatchObject({ maidenName: "Ivanova", birthDate: "1950-03", birthplace: "Minsk", portraitUrl: null });

    // Search matches name and maiden name, case-insensitively.
    expect(listFamilyPersons("boris").map((p) => p.name)).toEqual(["Boris Petrov"]);
    expect(listFamilyPersons("ivanova").map((p) => p.name)).toEqual(["Anna Petrova"]);
    expect(listFamilyPersons("nobody")).toHaveLength(0);
  });

  it("patches only the provided fields and clears with null", () => {
    const p = person("Anna", { birthplace: "Minsk", bio: "A bio." });
    const updated = updateFamilyPerson(p.id, { birthplace: null, birthDate: "1950" });
    expect(updated).toMatchObject({ name: "Anna", birthplace: null, birthDate: "1950", bio: "A bio." });
    expect(updateFamilyPerson("missing", { name: "X" })).toBeNull();
  });

  it("links and unlinks a gallery person", () => {
    db.prepare("INSERT INTO gallery_people (id, name) VALUES ('gp1', 'Anna cluster')").run();
    const p = person("Anna");
    expect(updateFamilyPerson(p.id, { galleryPersonId: "gp1" })?.galleryPersonId).toBe("gp1");
    expect(getFamilyPersonProfile(p.id)?.galleryPerson).toEqual({ id: "gp1", name: "Anna cluster" });
    expect(updateFamilyPerson(p.id, { galleryPersonId: null })?.galleryPersonId).toBeNull();
  });
});

describe("unions and children", () => {
  it("creates a two-partner union and a single-parent union", () => {
    const a = person("Anna");
    const b = person("Boris");
    const both = createUnion(a.id, b.id, { status: "married", marriedDate: "1975-06-14" });
    expect(both).toMatchObject({ union: { person1Id: a.id, person2Id: b.id, status: "married" } });

    const single = createUnion(a.id, null, {});
    expect(single).toMatchObject({ union: { person1Id: a.id, person2Id: null } });
  });

  it("rejects a union of a person with themselves or with a missing person", () => {
    const a = person("Anna");
    expect(createUnion(a.id, a.id, {})).toEqual({ error: "same_person" });
    expect(createUnion(a.id, "missing", {})).toEqual({ error: "person_not_found" });
    expect(createUnion("missing", null, {})).toEqual({ error: "person_not_found" });
  });

  it("attaches children to a union and enforces one parent-union per child", () => {
    const a = person("Anna");
    const b = person("Boris");
    const c = person("Carol");
    const union = family(a.id, b.id, [c.id]);

    const profile = getFamilyPersonProfile(c.id)!;
    expect(profile.parents.map((p) => p.name).sort()).toEqual(["Anna", "Boris"]);

    // A second parent-union for the same child is rejected in v1.
    const d = person("Dmitri");
    const other = family(d.id, null);
    expect(addChild(other.id, c.id, "biological")).toEqual({ error: "child_has_parents" });

    // Remove + re-add reassigns.
    expect(removeChild(union.id, c.id)).toBe(true);
    expect(addChild(other.id, c.id, "adopted")).toEqual({ ok: true });
    expect(getFamilyPersonProfile(c.id)!.parents.map((p) => p.name)).toEqual(["Dmitri"]);
    expect(getFamilyPersonProfile(c.id)!.parentRelation).toBe("adopted");
  });

  it("rejects a child who is a partner of the union, and cycles", () => {
    const a = person("Anna");
    const b = person("Boris");
    const c = person("Carol");
    const g = person("Grandchild");
    const union = family(a.id, b.id, [c.id]);
    family(c.id, null, [g.id]);

    expect(addChild(union.id, a.id, "biological")).toEqual({ error: "child_is_partner" });

    // Anna is Grandchild's great-parent; making Anna a child of Grandchild's
    // union would close a cycle.
    const gUnion = family(g.id, null);
    expect(isAncestorOf(a.id, g.id)).toBe(true);
    expect(addChild(gUnion.id, a.id, "biological")).toEqual({ error: "would_create_cycle" });
  });

  it("fills the empty partner slot of a single-parent union, with guards", () => {
    const a = person("Anna");
    const b = person("Boris");
    const c = person("Carol");
    const union = family(a.id, null, [c.id]);

    expect(setUnionPartner(union.id, a.id)).toEqual({ error: "same_person" });
    expect(setUnionPartner(union.id, "missing")).toEqual({ error: "person_not_found" });
    expect(setUnionPartner(union.id, c.id)).toEqual({ error: "child_is_partner" });
    // Carol's descendant can't become her parent.
    const g = person("Grandchild");
    family(c.id, null, [g.id]);
    expect(setUnionPartner(union.id, g.id)).toEqual({ error: "would_create_cycle" });

    expect(setUnionPartner(union.id, b.id)).toMatchObject({ union: { person2Id: b.id } });
    expect(getFamilyPersonProfile(c.id)!.parents.map((p) => p.name).sort()).toEqual(["Anna", "Boris"]);
    // Both slots taken now.
    const d = person("Dmitri");
    expect(setUnionPartner(union.id, d.id)).toEqual({ error: "union_has_partner" });
  });

  it("updates and deletes a union without touching persons", () => {
    const a = person("Anna");
    const b = person("Boris");
    const c = person("Carol");
    const union = family(a.id, b.id, [c.id]);

    expect(updateUnion(union.id, { status: "divorced", divorcedDate: "1990" }))
      .toMatchObject({ status: "divorced", divorcedDate: "1990" });

    expect(deleteUnion(union.id)).toBe(true);
    expect(getUnion(union.id)).toBeNull();
    // Child links cascade; all three persons survive.
    expect(getFamilyTree().children).toHaveLength(0);
    expect(listFamilyPersons()).toHaveLength(3);
  });
});

describe("person deletion", () => {
  it("keeps the union as single-parent when the other partner survives", () => {
    const a = person("Anna");
    const b = person("Boris");
    const c = person("Carol");
    const union = family(a.id, b.id, [c.id]);

    // Anna is person1 — deleting her must promote Boris into the NOT NULL slot.
    expect(deleteFamilyPerson(a.id).deleted).toBe(true);
    const kept = getUnion(union.id)!;
    expect(kept).toMatchObject({ person1Id: b.id, person2Id: null });
    // Boris keeps his child link.
    expect(getFamilyPersonProfile(c.id)!.parents.map((p) => p.name)).toEqual(["Boris"]);
  });

  it("deletes a sole-parent union with the person, cascading child links but keeping children", () => {
    const a = person("Anna");
    const c = person("Carol");
    const union = family(a.id, null, [c.id]);

    expect(deleteFamilyPerson(a.id).deleted).toBe(true);
    expect(getUnion(union.id)).toBeNull();
    expect(getFamilyTree().children).toHaveLength(0);
    expect(getFamilyPerson(c.id)).not.toBeNull();
  });

  it("deleting a child removes their child link but not the union", () => {
    const a = person("Anna");
    const b = person("Boris");
    const c = person("Carol");
    const union = family(a.id, b.id, [c.id]);

    expect(deleteFamilyPerson(c.id).deleted).toBe(true);
    expect(getUnion(union.id)).not.toBeNull();
    expect(getFamilyTree().children).toHaveLength(0);
  });
});

describe("whole tree payload", () => {
  it("returns all persons, unions, and child links in one shape", () => {
    const a = person("Anna");
    const b = person("Boris");
    const c = person("Carol");
    const union = family(a.id, b.id, [c.id]);

    const tree = getFamilyTree();
    expect(tree.persons).toHaveLength(3);
    expect(tree.unions).toHaveLength(1);
    expect(tree.children).toEqual([{ unionId: union.id, childId: c.id, relation: "biological" }]);
  });
});
