// Family tree access (docs/people-sharing-plan.md, D14–D17): the tree can be
// blocked for a person or group, living relatives' details are private to those
// who neither edit their branch nor were allowed to see them, and a whole-tree
// export is for admins and branch editors — privatised for the latter.
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { createFamilyPerson, applyFamilyPersonTags } from "../src/modules/familytree/persons.js";
import { createFamilyEvent } from "../src/modules/familytree/events.js";
import { createUnion } from "../src/modules/familytree/relations.js";
import { createFamilyCitation, createFamilySource } from "../src/modules/familytree/sources.js";
import { isLiving, livingCutoff } from "../src/modules/familytree/tree-access.js";
import { familyTreeRoutesPlugin } from "../src/modules/familytree/routes.js";
import { up as migrate83 } from "../src/db/migrations/083-family-tree-living.js";
import { ingestGalleryAsset } from "../src/modules/library/gallery/scanner.js";
import { bootApp } from "./helpers/boot.js";
import { addToGroup, grant, makeGroup, makeLibrary, makeUser, resetDb } from "./helpers/seed.js";

let app: FastifyInstance;
let signIn: (userId: string) => Promise<string>;
let ids: { granny: string; child: string; ancestor: string; undated: string };

beforeEach(async () => {
  resetDb();
  makeUser("admin", "admin");
  makeUser("cousin", "member");
  makeUser("editor", "member");
  makeGroup("petrov", "admin");
  // Granny died; the child is alive; the ancestor was born long ago; nobody knows about the undated one.
  const granny = createFamilyPerson({ name: "Granny", birthDate: "1920-01-01", deathDate: "1999-05-01", birthplace: "Minsk", bio: "Lived long." }, "admin");
  const child = createFamilyPerson({ name: "Child", birthDate: "2015-03-04", birthplace: "Oslo", bio: "Goes to school." }, "admin");
  const ancestor = createFamilyPerson({ name: "Ancestor", birthDate: "1850" }, "admin");
  const undated = createFamilyPerson({ name: "Undated" }, "admin");
  ids = { granny: granny.id, child: child.id, ancestor: ancestor.id, undated: undated.id };
  createFamilyEvent(child.id, { type: "residence", date: "2020", place: "Oslo" });
  const union = createUnion(granny.id, child.id, {});
  if ("error" in union) throw new Error(union.error);
  db.prepare("UPDATE family_tree_unions SET married_date = '2019', married_place = 'Oslo' WHERE id = ?").run(union.union.id);
  // The editor edits the Petrov branch, which the child is in.
  applyFamilyPersonTags([child.id], ["Petrov"], []);
  const tag = db.prepare("SELECT id FROM tags WHERE display_name = 'Petrov'").get() as { id: string };
  grant("user", "editor", tag.id, "contributor", "family_tree_tag");
  ({ app, signIn } = await bootApp({ plugins: [familyTreeRoutesPlugin] }));
});

afterEach(async () => { await app.close(); });

const get = async (user: string, url: string) => app.inject({ method: "GET", url, headers: { cookie: await signIn(user) } });
const personIn = (tree: { persons: { id: string }[] }, id: string) => tree.persons.find((p) => p.id === id) as Record<string, unknown>;

describe("who is living", () => {
  it("no death date, not marked deceased, and not born more than 100 years ago — no dates counts as living", () => {
    const now = new Date("2026-09-24T00:00:00Z");
    expect(livingCutoff(now)).toBe("1926-09-24");
    expect(isLiving({ birthDate: "1926-10-01", deathDate: null, deceased: false }, now)).toBe(true);
    // A bare year is any day of that year: born "1926" may still be 99.
    expect(isLiving({ birthDate: "1926", deathDate: null, deceased: false }, now)).toBe(true);
    expect(isLiving({ birthDate: "1926-09", deathDate: null, deceased: false }, now)).toBe(true);
    expect(isLiving({ birthDate: "1925", deathDate: null, deceased: false }, now)).toBe(false);
    expect(isLiving({ birthDate: "1926-09-23", deathDate: null, deceased: false }, now)).toBe(false);
    expect(isLiving({ birthDate: null, deathDate: null, deceased: false }, now)).toBe(true);
    expect(isLiving({ birthDate: null, deathDate: null, deceased: true }, now)).toBe(false);
    expect(isLiving({ birthDate: "2000", deathDate: "2010", deceased: false }, now)).toBe(false);
  });

  it("a child born 85 or more years ago says the parent is not living, whatever the parent's own dates", () => {
    const now = new Date("2026-09-24T00:00:00Z");
    const undated = { birthDate: null, deathDate: null, deceased: false };
    expect(isLiving(undated, now, "1941-09-23")).toBe(false);
    expect(isLiving(undated, now, "1941")).toBe(true); // any day of 1941 — may be under 85
    expect(isLiving(undated, now, "1940")).toBe(false);
    expect(isLiving(undated, now, "1980")).toBe(true);
    expect(isLiving({ birthDate: "1930", deathDate: null, deceased: false }, now, "1940")).toBe(false);
  });

  it("the tree reads the children's dates: an undated ancestor with an old child shows their details", async () => {
    // The undated person becomes the parent of the ancestor (born 1850).
    const union = createUnion(ids.undated, null, {});
    if ("error" in union) throw new Error(union.error);
    db.prepare("INSERT INTO family_tree_children (union_id, child_id) VALUES (?, ?)").run(union.union.id, ids.ancestor);
    db.prepare("UPDATE family_tree_persons SET bio = 'A shoemaker.' WHERE id = ?").run(ids.undated);
    const tree = (await get("cousin", "/api/family-tree/tree")).json();
    expect(personIn(tree, ids.undated)).toMatchObject({ living: false, restricted: false, bio: "A shoemaker." });
  });
});

describe("living relatives' details", () => {
  it("are kept from a member who may not see them: name and place in the tree stay", async () => {
    const tree = (await get("cousin", "/api/family-tree/tree")).json();
    expect(personIn(tree, ids.child)).toMatchObject({ name: "Child", birthDate: null, birthplace: null, bio: null, restricted: true });
    expect(personIn(tree, ids.granny)).toMatchObject({ birthDate: "1920-01-01", birthplace: "Minsk", restricted: false });
    expect(personIn(tree, ids.ancestor)).toMatchObject({ birthDate: "1850", restricted: false });
    expect(personIn(tree, ids.undated)).toMatchObject({ restricted: true });
    // The marriage keeps who married whom, not when or where.
    expect(tree.unions[0]).toMatchObject({ person1Id: ids.granny, person2Id: ids.child, marriedDate: null, marriedPlace: null });
    const profile = (await get("cousin", `/api/family-tree/persons/${ids.child}`)).json().person;
    expect(profile).toMatchObject({ restricted: true, events: [], citations: [], bio: null });
  });

  it("show to the branch's editor, to admins, and to anyone allowed — directly or by group", async () => {
    expect(personIn((await get("editor", "/api/family-tree/tree")).json(), ids.child)).toMatchObject({ birthDate: "2015-03-04", restricted: false });
    expect(personIn((await get("admin", "/api/family-tree/tree")).json(), ids.child)).toMatchObject({ bio: "Goes to school." });
    addToGroup("petrov", "cousin");
    const admin = await signIn("admin");
    await app.inject({ method: "PUT", url: "/api/family-tree/viewers/group/petrov", headers: { cookie: admin }, payload: { showLivingDetails: true } });
    const profile = (await get("cousin", `/api/family-tree/persons/${ids.child}`)).json().person;
    expect(profile).toMatchObject({ restricted: false, birthplace: "Oslo" });
    expect(profile.events).toHaveLength(1);
  });

  it("says who is living, to an admin too, for People's \"Shown as living to others\"", async () => {
    const persons = (await get("admin", "/api/family-tree/persons")).json().persons as { id: string; living: boolean; restricted: boolean }[];
    const living = (id: string) => persons.find((p) => p.id === id);
    expect(living(ids.child)).toMatchObject({ living: true, restricted: false });
    expect(living(ids.undated)).toMatchObject({ living: true });
    expect(living(ids.granny)).toMatchObject({ living: false });
    expect(living(ids.ancestor)).toMatchObject({ living: false });
  });

  it("the deceased mark makes an undated ancestor readable, one by one or in bulk", async () => {
    const admin = await signIn("admin");
    const res = await app.inject({ method: "POST", url: "/api/family-tree/persons/deceased", headers: { cookie: admin }, payload: { personIds: [ids.undated], deceased: true } });
    expect(res.json()).toMatchObject({ changed: 1 });
    expect(personIn((await get("cousin", "/api/family-tree/tree")).json(), ids.undated)).toMatchObject({ deceased: true, restricted: false });
    const refused = await app.inject({ method: "POST", url: "/api/family-tree/persons/deceased", headers: { cookie: await signIn("cousin") }, payload: { personIds: [ids.child], deceased: true } });
    expect(refused.statusCode).toBe(403);
  });

  it("leave the family map", async () => {
    db.prepare("UPDATE family_tree_persons SET birth_lat = 59.9, birth_lng = 10.7 WHERE id = ?").run(ids.child);
    db.prepare("UPDATE family_tree_persons SET birth_lat = 53.9, birth_lng = 27.5 WHERE id = ?").run(ids.granny);
    const entries = (await get("cousin", "/api/family-tree/map")).json().entries as { personIds: string[] }[];
    expect(entries.some((e) => e.personIds.includes(ids.child))).toBe(false);
    expect(entries.some((e) => e.personIds.includes(ids.granny))).toBe(true);
  });
});

describe("seeing the tree", () => {
  it("is open by default, and blocked for a person or a whole group", async () => {
    expect((await get("cousin", "/api/family-tree/tree")).statusCode).toBe(200);
    const admin = await signIn("admin");
    await app.inject({ method: "PUT", url: "/api/family-tree/viewers/user/cousin", headers: { cookie: admin }, payload: { canSee: false } });
    for (const url of ["/api/family-tree/tree", "/api/family-tree/persons", `/api/family-tree/persons/${ids.granny}`, "/api/family-tree/map"]) {
      expect((await get("cousin", url)).statusCode, url).toBe(403);
    }
    await app.inject({ method: "PUT", url: "/api/family-tree/viewers/user/cousin", headers: { cookie: admin }, payload: { canSee: true } });
    expect((await get("cousin", "/api/family-tree/tree")).statusCode).toBe(200);
    addToGroup("petrov", "editor");
    await app.inject({ method: "PUT", url: "/api/family-tree/viewers/group/petrov", headers: { cookie: admin }, payload: { canSee: false } });
    expect((await get("editor", "/api/family-tree/tree")).statusCode).toBe(403);
    // Admins always see it.
    expect((await get("admin", "/api/family-tree/tree")).statusCode).toBe(200);
  });
});

describe("the whole-tree export", () => {
  it("admins get everything, a branch editor a privatised file, anyone else nothing", async () => {
    expect((await get("cousin", "/api/family-tree/export")).statusCode).toBe(403);
    const full = (await get("admin", "/api/family-tree/export")).body;
    expect(full).toContain("Goes to school.");
    // The editor edits the child, so the child is not private to them — the undated one is.
    const editor = (await get("editor", "/api/family-tree/export")).body;
    expect(editor).toContain("Goes to school.");
    expect(editor).toContain("Undated");
    db.prepare("UPDATE family_tree_persons SET bio = 'Secret notes' WHERE id = ?").run(ids.undated);
    expect((await get("editor", "/api/family-tree/export")).body).not.toContain("Secret notes");
  });

  it("keeps a private person's marriage as a relationship only: no dates, no divorce, no citations", async () => {
    // The ancestor (long dead, so not private) married the undated one (private to the editor).
    const union = createUnion(ids.ancestor, ids.undated, { status: "divorced", marriedDate: "1870-05-01", divorcedDate: "1880" });
    if ("error" in union) throw new Error(union.error);
    const source = createFamilySource({ title: "Parish register" });
    const cited = createFamilyCitation({ sourceId: source.id, unionId: union.union.id, fact: "marriage", detail: "page 12, 1 May 1870" });
    if ("error" in cited) throw new Error(cited.error);

    const full = (await get("admin", "/api/family-tree/export")).body;
    expect(full).toContain("page 12, 1 May 1870");
    expect(full).toContain("1 DIV");
    const editor = (await get("editor", "/api/family-tree/export")).body;
    // The couple is still a couple in the file...
    expect(editor).toMatch(/1 (HUSB|WIFE) @I\d+@\r?\n1 (HUSB|WIFE) @I\d+@/);
    // ...and nothing else about the marriage is.
    expect(editor).not.toContain("page 12, 1 May 1870");
    expect(editor).not.toContain("1 DIV");
    expect(editor).not.toContain("1870");
  });
});

describe("a redacted marriage", () => {
  it("keeps its citations off the other spouse's Sources tab too", async () => {
    const union = createUnion(ids.ancestor, ids.undated, { status: "married", marriedDate: "1870" });
    if ("error" in union) throw new Error(union.error);
    const source = createFamilySource({ title: "Parish register" });
    const cited = createFamilyCitation({ sourceId: source.id, unionId: union.union.id, fact: "marriage", detail: "page 12" });
    if ("error" in cited) throw new Error(cited.error);
    const forCousin = (await get("cousin", `/api/family-tree/persons/${ids.ancestor}`)).json().person;
    expect(forCousin.unions[0].partner.restricted).toBe(true);
    expect(forCousin.citations).toEqual([]);
    const forAdmin = (await get("admin", `/api/family-tree/persons/${ids.ancestor}`)).json().person;
    expect(forAdmin.citations.map((c: { detail: string }) => c.detail)).toEqual(["page 12"]);
  });
});

describe("a branch editor's reach", () => {
  const patch = async (user: string, url: string, payload: unknown) =>
    app.inject({ method: "PATCH", url, headers: { cookie: await signIn(user) }, payload });
  const post = async (user: string, url: string, payload: unknown) =>
    app.inject({ method: "POST", url, headers: { cookie: await signIn(user) }, payload });

  it("stops at families with nobody of theirs in them", async () => {
    // A single parent outside the branch: the editor may not make the branch child its other parent...
    const strangers = createUnion(ids.ancestor, null, {});
    if ("error" in strangers) throw new Error(strangers.error);
    expect((await patch("editor", `/api/family-tree/unions/${strangers.union.id}`, { person2Id: ids.child })).statusCode).toBe(403);
    // ...nor hang the branch child under them.
    expect((await post("editor", `/api/family-tree/unions/${strangers.union.id}/children`, { childId: ids.child })).statusCode).toBe(403);
    expect((await patch("admin", `/api/family-tree/unions/${strangers.union.id}`, { person2Id: ids.child })).statusCode).toBe(200);
  });

  it("still adds a sibling under the parents of a branch child, and the other parent", async () => {
    const parents = createUnion(ids.granny, null, {});
    if ("error" in parents) throw new Error(parents.error);
    db.prepare("DELETE FROM family_tree_unions WHERE person1_id = ? AND person2_id = ?").run(ids.granny, ids.child);
    db.prepare("INSERT INTO family_tree_children (union_id, child_id) VALUES (?, ?)").run(parents.union.id, ids.child);
    // Granny is not in the branch; the child is, and that is enough for their family.
    expect((await post("editor", `/api/family-tree/unions/${parents.union.id}/children`, { childId: ids.undated })).statusCode).toBe(201);
    expect((await patch("editor", `/api/family-tree/unions/${parents.union.id}`, { person2Id: ids.ancestor })).statusCode).toBe(200);
  });

  it("attaches only photos they can open themselves", async () => {
    makeLibrary("PRIV", { createdBy: "admin", type: "gallery" });
    grant("user", "admin", "PRIV", "manager");
    const item = await ingestGalleryAsset("PRIV", {
      absolutePath: "/src/PRIV/a.jpg", relativePath: "a.jpg", fileName: "a.jpg", extension: ".jpg",
      kind: "photo", size: 1000, modifiedAtMs: Date.parse("2024-01-01T00:00:00Z")
    }, false);
    createFamilyEvent(ids.child, { type: "residence", date: "2021", place: "Oslo" });
    const event = db.prepare("SELECT id FROM family_tree_events WHERE person_id = ? AND date = '2021'").get(ids.child) as { id: string };
    // The editor edits the child, but cannot see PRIV.
    expect((await post("editor", `/api/family-tree/persons/${ids.child}/photos`, { itemIds: [item] })).statusCode).toBe(403);
    expect((await post("editor", `/api/family-tree/events/${event.id}/photos`, { itemIds: [item] })).statusCode).toBe(403);
    expect((await post("admin", `/api/family-tree/persons/${ids.child}/photos`, { itemIds: [item] })).statusCode).toBe(200);
  });
});

describe("migration 83", () => {
  it("adds the deceased mark and keeps living details on for everyone who already exists", () => {
    const scratch = new Database(":memory:");
    scratch.exec(`
      CREATE TABLE family_tree_persons (id TEXT PRIMARY KEY);
      CREATE TABLE users (id TEXT PRIMARY KEY, deleted_at TEXT);
      CREATE TABLE user_groups (id TEXT PRIMARY KEY);
      CREATE TABLE access_settings (subject_type TEXT, subject_id TEXT, show_location INTEGER NOT NULL DEFAULT 0,
        show_living_details INTEGER NOT NULL DEFAULT 0, updated_at TEXT, PRIMARY KEY (subject_type, subject_id));
      INSERT INTO users VALUES ('u1', NULL), ('gone', '2026-01-01');
      INSERT INTO user_groups VALUES ('g1');
      INSERT INTO access_settings (subject_type, subject_id, show_location) VALUES ('user', 'u1', 1);
    `);
    migrate83(scratch);
    migrate83(scratch);
    const columns = (scratch.prepare("PRAGMA table_info(family_tree_persons)").all() as { name: string }[]).map((c) => c.name);
    expect(columns).toContain("deceased");
    expect(scratch.prepare("SELECT subject_type, subject_id, show_location, show_living_details FROM access_settings ORDER BY subject_id").all()).toEqual([
      { subject_type: "group", subject_id: "g1", show_location: 0, show_living_details: 1 },
      { subject_type: "user", subject_id: "u1", show_location: 1, show_living_details: 1 }
    ]);
    scratch.close();
  });
});
