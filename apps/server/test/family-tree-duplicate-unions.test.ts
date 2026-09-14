import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { createFamilyPerson, getFamilyPersonProfile } from "../src/modules/familytree/persons.js";
import { addChild, createUnion, setUnionPartner } from "../src/modules/familytree/relations.js";
import { createFamilyCitation, createFamilySource } from "../src/modules/familytree/sources.js";
import { up as mergeDuplicateUnions } from "../src/db/migrations/080-merge-duplicate-family-unions.js";
import { resetDb, makeUser } from "./helpers/seed.js";

// One couple, one union. Peter was added as Dora's husband, then as Anna's
// father, then Dora as Anna's mother — and Peter's profile showed Dora twice,
// because filling the second parent made a new copy of a couple that existed.

beforeEach(() => {
  resetDb();
  makeUser("admin", "admin");
});

const person = (name: string) => createFamilyPerson({ name }, "admin");

function union(person1: string, person2: string | null, fields = {}) {
  const result = createUnion(person1, person2, fields);
  if ("error" in result) throw new Error(result.error);
  return result.union;
}

describe("a couple is recorded once", () => {
  it("joins the existing couple when the second parent is already the first parent's partner", () => {
    const peter = person("Peter");
    const dora = person("Dora");
    const anna = person("Anna");
    const marriage = union(dora.id, peter.id, { status: "married", marriedDate: "1925" });

    // Anna's profile → Add parent → Peter: a single-parent family for Anna…
    const single = union(peter.id, null);
    expect(addChild(single.id, anna.id, "biological")).toEqual({ ok: true });
    // …then Add the other parent → Dora.
    const result = setUnionPartner(single.id, dora.id);
    if ("error" in result) throw new Error(result.error);

    expect(result.union.id).toBe(marriage.id);
    expect(result.union).toMatchObject({ status: "married", marriedDate: "1925" });
    const profile = getFamilyPersonProfile(peter.id)!;
    expect(profile.unions).toHaveLength(1);
    expect(profile.unions[0].children.map((child) => child.name)).toEqual(["Anna"]);
    expect(getFamilyPersonProfile(anna.id)!.parents.map((parent) => parent.name).sort()).toEqual(["Dora", "Peter"]);
  });

  it("refuses to record the same couple twice", () => {
    const peter = person("Peter");
    const dora = person("Dora");
    union(peter.id, dora.id);
    expect(createUnion(dora.id, peter.id, { status: "married" })).toEqual({ error: "already_partners" });
    // A single-parent family is not a couple and stays allowed.
    expect(createUnion(peter.id, null, {})).toHaveProperty("union");
  });
});

describe("migration 80: folding copies already made", () => {
  function insertUnion(id: string, person1: string, person2: string, fields: Record<string, string | null>, createdAt: string) {
    db.prepare(`
      INSERT INTO family_tree_unions (id, person1_id, person2_id, status, married_date, married_place, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, person1, person2, fields.status ?? "unknown", fields.married_date ?? null, fields.married_place ?? null, fields.note ?? null, createdAt);
  }

  it("folds copies that agree into the oldest, keeping children, citations and facts", () => {
    const peter = person("Peter");
    const dora = person("Dora");
    const anna = person("Anna");
    const raya = person("Raya");
    insertUnion("u-old", dora.id, peter.id, { status: "married" }, "2026-09-14T20:59:18.000Z");
    insertUnion("u-new", peter.id, dora.id, { married_place: "Babruysk" }, "2026-09-14T21:05:35.000Z");
    db.prepare("INSERT INTO family_tree_children (union_id, child_id) VALUES ('u-new', ?), ('u-old', ?)").run(anna.id, raya.id);
    const source = createFamilySource({ title: "Marriage record" });
    const cited = createFamilyCitation({ sourceId: source.id, unionId: "u-new", fact: "marriage" });
    if ("error" in cited) throw new Error(cited.error);

    mergeDuplicateUnions(db);

    const unions = db.prepare("SELECT id, status, married_place FROM family_tree_unions").all();
    expect(unions).toEqual([{ id: "u-old", status: "married", married_place: "Babruysk" }]);
    expect(db.prepare("SELECT union_id, child_id FROM family_tree_children ORDER BY child_id").all())
      .toEqual([anna.id, raya.id].sort().map((child_id) => ({ union_id: "u-old", child_id })));
    expect(db.prepare("SELECT union_id FROM family_tree_citations").get()).toEqual({ union_id: "u-old" });
  });

  it("leaves a couple alone when their unions disagree, as a remarriage would", () => {
    const peter = person("Peter");
    const dora = person("Dora");
    insertUnion("u-first", peter.id, dora.id, { status: "divorced", married_date: "1920" }, "2026-01-01T00:00:00.000Z");
    insertUnion("u-second", peter.id, dora.id, { status: "married", married_date: "1930" }, "2026-01-02T00:00:00.000Z");

    mergeDuplicateUnions(db);

    expect(db.prepare("SELECT COUNT(*) AS n FROM family_tree_unions").get()).toEqual({ n: 2 });
  });
});
