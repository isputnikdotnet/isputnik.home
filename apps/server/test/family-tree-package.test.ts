// Moving a family tree between servers as a package (docs/family-tree-exchange-plan.md):
// export, the Migrate rules (nothing set is changed, blanks fill, nothing is
// deleted), origins so a second import adds nothing, per-person decisions,
// Replace, and the upload → preview → apply routes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { db } from "../src/db.js";
import { thumbnailAbsolutePath, thumbnailPathSettingKey, thumbnailStorageKey } from "../src/modules/library/shared/thumbnail.js";
import { setHouseLibrary } from "../src/modules/library/gallery/house-library.js";
import { getEntityTags } from "../src/modules/library/shared/tagging.js";
import { FAMILY_PERSON_ENTITY_TYPE } from "../src/modules/familytree/access.js";
import { createFamilyPerson, getFamilyPerson, getFamilyTree, listFamilyPersons, updateFamilyPerson } from "../src/modules/familytree/persons.js";
import { addChild, createUnion } from "../src/modules/familytree/relations.js";
import { createFamilyEvent, listFamilyEvents } from "../src/modules/familytree/events.js";
import { createFamilyCitation, createFamilySource, listFamilySources, listPersonCitations } from "../src/modules/familytree/sources.js";
import { attachFamilyEventPhotos, attachFamilyPhotos, attachedFamilyPhotoIds } from "../src/modules/familytree/photos.js";
import { setUploadedPortraitFile } from "../src/modules/familytree/portraits.js";
import { getFamilyTreeSettings, setFamilyTreeSettings } from "../src/modules/familytree/settings.js";
import { buildPackage, getServerId, writePackage } from "../src/modules/familytree/package/export.js";
import { readPackage, sweepPendingImports } from "../src/modules/familytree/package/pending.js";
import { planImport, type ImportDecisions } from "../src/modules/familytree/package/import-plan.js";
import { applyImportPlan } from "../src/modules/familytree/package/import-apply.js";
import { familyTreeRoutesPlugin } from "../src/modules/familytree/routes.js";
import { bootApp } from "./helpers/boot.js";
import { resetDb, makeUser, makeLibrary, grant } from "./helpers/seed.js";
import { multipart as body } from "./helpers/multipart.js";

let base = "";
let photos = "";
let house = "";
let zipCount = 0;

async function writeJpeg(target: string, r: number, b: number): Promise<void> {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  await sharp({ create: { width: 64, height: 48, channels: 3, background: { r, g: 0, b } } }).jpeg().toFile(target);
}

function addPhotoItem(id: string, relative: string): void {
  db.prepare("INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES (?, 'gal', 'gallery', ?, 'ready')").run(id, relative);
  db.prepare("INSERT INTO item_metadata (item_id, source, title) VALUES (?, 'scan', ?)").run(id, path.basename(relative));
  db.prepare("INSERT INTO gallery_details (item_id, kind, relative_path, size, width, height) VALUES (?, 'photo', ?, 1, 64, 48)").run(id, relative);
}

async function givePortrait(personId: string): Promise<string> {
  const key = thumbnailStorageKey("familytree", personId, `${personId}-portrait-test.jpg`);
  await writeJpeg(thumbnailAbsolutePath(key), 0, 255);
  await setUploadedPortraitFile(personId, key, "admin");
  return key;
}

async function exportToZip(): Promise<string> {
  const build = await buildPackage();
  const zipPath = path.join(base, `package-${zipCount++}.zip`);
  await writePackage(build, fs.createWriteStream(zipPath));
  return zipPath;
}

async function importZip(zipPath: string, decisions: ImportDecisions = { mode: "migrate", persons: {} }) {
  const { manifest, tree } = await readPackage(zipPath);
  const plan = planImport(tree, manifest.sourceServer, decisions);
  const result = await applyImportPlan(plan, zipPath, path.join(base, `staging-${zipCount++}`), "admin");
  return { plan, result };
}

function wipeTree(): void {
  db.prepare(`DELETE FROM taggables WHERE entity_type = '${FAMILY_PERSON_ENTITY_TYPE}'`).run();
  db.prepare("DELETE FROM family_tree_persons").run();
  db.prepare("DELETE FROM family_tree_sources").run();
  db.prepare("DELETE FROM family_tree_origins").run();
  db.prepare("DELETE FROM app_settings WHERE key = 'family_tree_settings'").run();
}

const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const byName = (name: string) => listFamilyPersons().find((p) => p.name === name)!;

/** A small family: enough of every kind of record to notice what a package drops. */
async function seedFamily() {
  const anna = createFamilyPerson({
    name: "Anna Posse", maidenName: "Ivanova", gender: "female", birthDate: "1928-03-01", birthplace: "Minsk",
    birthPin: { lat: 53.9, lng: 27.56 }, bio: "**Anna** kept the letters.", deceased: true,
    otherNames: [{ language: "ru", name: "Анна Поссе" }]
  }, "admin", ["Posse branch"]);
  // Create ignores `deceased`; it is set on edit.
  updateFamilyPerson(anna.id, { deceased: true });
  const boris = createFamilyPerson({ name: "Boris Posse", gender: "male", birthDate: "1925" }, "admin");
  const clara = createFamilyPerson({ name: "Clara Posse", gender: "female", birthDate: "1951-07-04" }, "admin");
  const union = createUnion(anna.id, boris.id, { status: "married", marriedDate: "1950-05-09", marriedPlace: "Vitebsk", marriedPin: { lat: 55.19, lng: 30.2 } });
  if (!("union" in union)) throw new Error("union");
  expect(addChild(union.union.id, clara.id, "adopted")).toEqual({ ok: true });
  const event = createFamilyEvent(anna.id, { type: "residence", label: "Moved to the city", date: "1960", place: "Gomel", placePin: { lat: 52.43, lng: 31.0 } })!;
  expect(attachFamilyPhotos(anna.id, ["p1"], "admin")).toEqual({ attached: 1 });
  expect(attachFamilyEventPhotos(event.id, ["p1"], "admin")).toEqual({ attached: 1 });
  const portraitKey = await givePortrait(boris.id);
  const source = createFamilySource({ title: "Parish register", author: "St. Simon's" });
  const citation = createFamilyCitation({ sourceId: source.id, personId: anna.id, fact: "birth", detail: "page 12" });
  if (!("citation" in citation)) throw new Error("citation");
  setFamilyTreeSettings({ defaultPersonId: anna.id }, "admin");
  return { anna, boris, clara, union: union.union, event, portraitKey, source };
}

beforeEach(async () => {
  resetDb();
  sweepPendingImports();
  makeUser("admin", "admin");
  makeUser("cousin", "member");
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-ft-package-")));
  photos = path.join(base, "Photos");
  house = path.join(base, "House");
  fs.mkdirSync(photos, { recursive: true });
  fs.mkdirSync(house, { recursive: true });
  fs.mkdirSync(path.join(base, "_thumbs"), { recursive: true });
  db.prepare("DELETE FROM storage_roots").run();
  db.prepare("INSERT INTO storage_roots (id, name, path, created_by) VALUES ('root1', 'Root', ?, 'admin')").run(base);
  db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)").run(thumbnailPathSettingKey, path.join(base, "_thumbs"));
  makeLibrary("gal", { createdBy: "admin", type: "gallery" });
  db.prepare("UPDATE libraries SET source_path = ? WHERE id = 'gal'").run(photos);
  grant("user", "admin", "gal", "manager");
  makeLibrary("house", { createdBy: "admin", type: "gallery" });
  db.prepare("UPDATE libraries SET source_path = ? WHERE id = 'house'").run(house);
  expect(setHouseLibrary("house", "admin").ok).toBe(true);
  await writeJpeg(path.join(photos, "party.jpg"), 255, 0);
  addPhotoItem("p1", "party.jpg");
});

afterEach(() => {
  sweepPendingImports();
  fs.rmSync(base, { recursive: true, force: true });
});

describe("family-tree package: export", () => {
  it("carries everything GEDCOM drops", async () => {
    const { anna, boris } = await seedFamily();
    const build = await buildPackage();
    expect(build.warnings).toEqual([]);
    expect(build.manifest).toMatchObject({ format: "isputnik-family-tree", formatVersion: 1, sourceServer: getServerId() });
    expect(build.manifest.counts).toMatchObject({ persons: 3, unions: 1, events: 1, sources: 1, citations: 1, photos: 1, portraits: 1 });

    const pkgAnna = build.tree.persons.find((p) => p.id === anna.id)!;
    expect(pkgAnna).toMatchObject({
      name: "Anna Posse", maidenName: "Ivanova", birthDate: "1928-03-01", birthplace: "Minsk", deceased: true,
      birthPin: { lat: 53.9, lng: 27.56 }, tags: ["Posse branch"], otherNames: [{ language: "ru", name: "Анна Поссе" }],
      photos: ["p1"], portrait: null
    });
    const pkgBoris = build.tree.persons.find((p) => p.id === boris.id)!;
    expect(pkgBoris.portrait).toMatchObject({ file: `media/portraits/${boris.id}.jpg`, sourcePhotoId: null });
    expect(build.tree.unions![0]).toMatchObject({ marriedPin: { lat: 55.19, lng: 30.2 }, children: [{ relation: "adopted" }] });
    expect(build.tree.events![0]).toMatchObject({ placePin: { lat: 52.43, lng: 31.0 }, photos: ["p1"] });
    expect(build.tree.photos![0]).toMatchObject({ id: "p1", file: "media/photos/p1.jpg", fileName: "party.jpg" });
    expect(build.tree.photos![0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(build.tree.settings).toEqual({ defaultPersonId: anna.id });
    expect(build.media.map((m) => m.entry).sort()).toEqual([`media/photos/p1.jpg`, `media/portraits/${boris.id}.jpg`]);
  });

  it("leaves out a photo whose file is gone, and says so", async () => {
    await seedFamily();
    fs.rmSync(path.join(photos, "party.jpg"));
    const build = await buildPackage();
    expect(build.warnings).toHaveLength(1);
    expect(build.tree.photos).toEqual([]);
    expect(build.tree.persons.find((p) => p.name === "Anna Posse")!.photos).toEqual([]);
  });
});

describe("family-tree package: import", () => {
  it("round-trips into an empty tree, photos and portraits included", async () => {
    const seeded = await seedFamily();
    const zip = await exportToZip();
    wipeTree();
    expect(count("family_tree_persons")).toBe(0);

    const { result } = await importZip(zip);
    expect(result.summary).toMatchObject({
      personsCreated: 3, personsMatched: 0, unionsCreated: 1, childrenLinked: 1, eventsCreated: 1,
      sourcesCreated: 1, citationsCreated: 1, portraitsSet: 1, photosImported: 1, photosReused: 0, personsRemoved: 0
    });
    expect(result.warnings).toEqual([]);

    const anna = byName("Anna Posse");
    expect(anna).toMatchObject({
      maidenName: "Ivanova", birthDate: "1928-03-01", birthplace: "Minsk", birthPin: { lat: 53.9, lng: 27.56 }, deceased: true,
      bio: "**Anna** kept the letters.", otherNames: [{ language: "ru", name: "Анна Поссе" }]
    });
    expect(anna.id).not.toBe(seeded.anna.id);
    expect(getEntityTags(FAMILY_PERSON_ENTITY_TYPE, anna.id)).toEqual(["Posse branch"]);
    const tree = getFamilyTree();
    expect(tree.unions).toHaveLength(1);
    expect(tree.unions[0]).toMatchObject({ status: "married", marriedDate: "1950-05-09", marriedPlace: "Vitebsk" });
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0]).toMatchObject({ unionId: tree.unions[0].id, childId: byName("Clara Posse").id, relation: "adopted" });
    const events = listFamilyEvents(anna.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "residence", label: "Moved to the city", place: "Gomel", placePin: { lat: 52.43, lng: 31.0 } });
    expect(listFamilySources().map((s) => s.title)).toEqual(["Parish register"]);
    expect(listPersonCitations(anna.id)).toHaveLength(1);
    expect(getFamilyTreeSettings().defaultPersonId).toBe(anna.id);

    // The photo went into App files → Family tree → Imported, and is on both walls.
    const imported = attachedFamilyPhotoIds(anna.id);
    expect(imported).toHaveLength(1);
    expect(imported[0]).not.toBe("p1");
    const item = db.prepare("SELECT library_id, folder_path FROM library_items WHERE id = ?").get(imported[0]) as { library_id: string; folder_path: string };
    expect(item.library_id).toBe("house");
    expect(item.folder_path.startsWith("Family tree/Imported/")).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM family_tree_event_photos WHERE event_id = ? AND item_id = ?").get(events[0].id, imported[0])).toEqual({ n: 1 });

    const boris = byName("Boris Posse");
    const row = db.prepare("SELECT portrait_storage_key FROM family_tree_persons WHERE id = ?").get(boris.id) as { portrait_storage_key: string | null };
    expect(row.portrait_storage_key).toBeTruthy();
    expect(fs.existsSync(thumbnailAbsolutePath(row.portrait_storage_key!))).toBe(true);

    // Every record remembers where it came from.
    expect(count("family_tree_origins")).toBe(3 + 1 + 1 + 1 + 1);
  });

  it("imports the same package twice without adding anything", async () => {
    await seedFamily();
    const zip = await exportToZip();
    wipeTree();
    await importZip(zip);
    const before = { persons: count("family_tree_persons"), unions: count("family_tree_unions"), events: count("family_tree_events"),
      citations: count("family_tree_citations"), photos: count("family_tree_photos"), items: count("library_items") };
    const { plan, result } = await importZip(zip);
    expect(plan.preview.persons.every((p) => p.match?.reason === "origin")).toBe(true);
    expect(result.summary).toMatchObject({ personsCreated: 0, personsMatched: 3, unionsCreated: 0, childrenLinked: 0, eventsCreated: 0,
      sourcesCreated: 0, citationsCreated: 0, portraitsSet: 0, photosImported: 0, differences: 0 });
    expect({ persons: count("family_tree_persons"), unions: count("family_tree_unions"), events: count("family_tree_events"),
      citations: count("family_tree_citations"), photos: count("family_tree_photos"), items: count("library_items") }).toEqual(before);
  });

  it("a tree's own package changes nothing: single-parent families link, same-name people resolve, photos are found by their bytes", async () => {
    const { anna } = await seedFamily();
    // A single-parent family, and two people of one name where only one has a date.
    const lone = createFamilyPerson({ name: "Ivan Mikhalchenko", birthDate: "1947" }, "admin");
    expect("union" in createUnion(lone.id, null, {})).toBe(true);
    createFamilyPerson({ name: "Ivan Mikhalchenko" }, "admin");
    // A bio with trailing whitespace is the same bio.
    db.prepare("UPDATE family_tree_persons SET bio = bio || '\n' WHERE id = ?").run(anna.id);
    const zip = await exportToZip();

    const { plan, result } = await importZip(zip);
    expect(plan.preview.persons.map((p) => [p.name, p.match?.reason])).toEqual(expect.arrayContaining([
      ["Ivan Mikhalchenko", "nameAndBirth"], ["Ivan Mikhalchenko", "name"]
    ]));
    expect(result.summary).toMatchObject({
      personsCreated: 0, personsMatched: 5, unionsCreated: 0, childrenLinked: 0, eventsCreated: 0, sourcesCreated: 0,
      citationsCreated: 0, portraitsSet: 0, photosImported: 0, photosReused: 0, differences: 0
    });
    expect(count("family_tree_unions")).toBe(2);
    expect(count("library_items")).toBe(1);
  });

  it("migrate fills blanks, keeps what is set, and deletes nothing", async () => {
    // The package: Anna with a different birthplace and a bio; Vladimir (1924)
    // with a bio; Olga with no birth date; a new Dmitri.
    const anna = createFamilyPerson({ name: "Anna Posse", birthDate: "1928-03-01", birthplace: "Мінск", bio: "From the package." }, "admin");
    createFamilyPerson({ name: "Vladimir Posse", birthDate: "1924", bio: "The younger." }, "admin");
    createFamilyPerson({ name: "Olga Posse", deathDate: "1990" }, "admin");
    createFamilyPerson({ name: "Dmitri Posse", birthDate: "1955" }, "admin");
    createFamilyPerson({ name: "Ivan Posse" }, "admin");
    setFamilyTreeSettings({ defaultPersonId: anna.id }, "admin");
    const zip = await exportToZip();
    wipeTree();

    // The tree here: Anna already has a birthplace; both Vladimirs; Olga has a
    // birth date; two Ivans (never matched); Zoya, who is not in the package.
    const hereAnna = createFamilyPerson({ name: "Anna Posse", birthDate: "1928-03-01", birthplace: "Minsk" }, "admin");
    const old = createFamilyPerson({ name: "Vladimir Posse", birthDate: "1864" }, "admin");
    const young = createFamilyPerson({ name: "Vladimir Posse", birthDate: "1924" }, "admin");
    const olga = createFamilyPerson({ name: "Olga Posse", birthDate: "1910" }, "admin");
    createFamilyPerson({ name: "Ivan Posse" }, "admin");
    createFamilyPerson({ name: "Ivan Posse" }, "admin");
    const zoya = createFamilyPerson({ name: "Zoya Posse" }, "admin");
    setFamilyTreeSettings({ defaultPersonId: zoya.id }, "admin");

    const { plan, result } = await importZip(zip);
    const preview = Object.fromEntries(plan.preview.persons.map((p) => [p.name, p]));
    expect(preview["Anna Posse"].match).toMatchObject({ localId: hereAnna.id, reason: "nameAndBirth" });
    expect(preview["Anna Posse"].differences).toEqual([{ field: "birthplace", here: "Minsk", package: "Мінск", resolution: "keepHere" }]);
    expect(preview["Anna Posse"].fills).toEqual(["bio"]);
    expect(preview["Vladimir Posse"].match).toMatchObject({ localId: young.id, reason: "nameAndBirth" });
    expect(preview["Olga Posse"].match).toMatchObject({ localId: olga.id, reason: "name" });
    expect(preview["Dmitri Posse"].match).toBeNull();
    expect(preview["Ivan Posse"].match).toBeNull();
    expect(result.summary).toMatchObject({ personsCreated: 2, personsMatched: 3, personsFilled: 3, personsOverwritten: 0, differences: 1, personsRemoved: 0 });

    expect(getFamilyPerson(hereAnna.id)).toMatchObject({ birthplace: "Minsk", bio: "From the package." });
    expect(getFamilyPerson(young.id)!.bio).toBe("The younger.");
    expect(getFamilyPerson(old.id)!.bio).toBeNull();
    expect(getFamilyPerson(olga.id)).toMatchObject({ birthDate: "1910", deathDate: "1990" });
    expect(listFamilyPersons().filter((p) => p.name === "Ivan Posse")).toHaveLength(3);
    expect(getFamilyPerson(zoya.id)).not.toBeNull();
    expect(count("family_tree_persons")).toBe(9);
    // The start person is set here already, so the package's is a note, not a change.
    expect(getFamilyTreeSettings().defaultPersonId).toBe(zoya.id);
    expect(result.warnings.some((w) => w.includes("opens on Zoya Posse"))).toBe(true);
  });

  it("honours the admin's decision for each person", async () => {
    const anna = createFamilyPerson({ name: "Anna Posse", birthDate: "1928" }, "admin");
    createFamilyPerson({ name: "Vladimir Posse", birthDate: "1924", bio: "Package bio." }, "admin");
    createFamilyPerson({ name: "Dmitri Posse", bio: "Dmitri's bio." }, "admin");
    const olga = createFamilyPerson({ name: "Olga Posse", birthDate: "1910" }, "admin");
    createFamilyEvent(olga.id, { type: "occupation", label: "Teacher" });
    createFamilyPerson({ name: "Pavel Posse" }, "admin");
    const u = createUnion(anna.id, olga.id, { status: "partners" });
    expect("union" in u).toBe(true);
    const zip = await exportToZip();
    wipeTree();

    const hereAnna = createFamilyPerson({ name: "Anna Posse", birthDate: "1928" }, "admin");
    const hereVladimir = createFamilyPerson({ name: "Vladimir Posse", birthDate: "1924", bio: "Local bio." }, "admin");
    const dima = createFamilyPerson({ name: "Dima", birthDate: "1950" }, "admin");
    const hereOlga = createFamilyPerson({ name: "Olga Posse", birthDate: "1910" }, "admin");

    const { manifest, tree } = await readPackage(zip);
    const pkgId = (name: string) => tree.persons.find((p) => p.name === name)!.id;
    const decisions: ImportDecisions = {
      mode: "migrate",
      persons: {
        [pkgId("Anna Posse")]: { action: "add" },
        [pkgId("Vladimir Posse")]: { action: "usePackage", matchId: hereVladimir.id },
        [pkgId("Dmitri Posse")]: { action: "merge", matchId: dima.id },
        [pkgId("Olga Posse")]: { action: "keepMine" },
        [pkgId("Pavel Posse")]: { action: "skip" }
      }
    };
    const plan = planImport(tree, manifest.sourceServer, decisions);
    const preview = Object.fromEntries(plan.preview.persons.map((p) => [p.name, p]));
    expect(preview["Anna Posse"]).toMatchObject({ suggested: { localId: hereAnna.id }, match: null, decision: { action: "add" } });
    expect(preview["Vladimir Posse"].differences).toEqual([{ field: "bio", here: "Local bio.", package: "Package bio.", resolution: "usePackage" }]);
    expect(preview["Dmitri Posse"].match).toMatchObject({ localId: dima.id, reason: "manual" });
    expect(preview["Olga Posse"]).toMatchObject({ match: { localId: hereOlga.id }, decision: { action: "keepMine", matchId: hereOlga.id } });
    expect(plan.preview.summary).toMatchObject({ personsCreated: 1, personsMatched: 3, personsSkipped: 1, personsOverwritten: 1, personsFilled: 1, eventsCreated: 0 });

    await applyImportPlan(plan, zip, path.join(base, "staging-decisions"), "admin");
    expect(listFamilyPersons().filter((p) => p.name === "Anna Posse")).toHaveLength(2);
    expect(getFamilyPerson(hereVladimir.id)!.bio).toBe("Package bio.");
    expect(getFamilyPerson(dima.id)).toMatchObject({ name: "Dima", bio: "Dmitri's bio." });
    expect(listFamilyEvents(hereOlga.id)).toEqual([]);
    expect(listFamilyPersons().some((p) => p.name === "Pavel Posse")).toBe(false);
    // The new Anna and the matched Olga are partners, as in the package.
    const newAnna = listFamilyPersons().find((p) => p.name === "Anna Posse" && p.id !== hereAnna.id)!;
    expect(getFamilyTree().unions.some((un) => [un.person1Id, un.person2Id].sort().join() === [newAnna.id, hereOlga.id].sort().join())).toBe(true);
  });

  it("keeps a child's parents here and reports the difference", async () => {
    const c = createFamilyPerson({ name: "Carl", birthDate: "1900" }, "admin");
    const d = createFamilyPerson({ name: "Dora", birthDate: "1902" }, "admin");
    const clara = createFamilyPerson({ name: "Clara", birthDate: "1930" }, "admin");
    const u = createUnion(c.id, d.id, {});
    if (!("union" in u)) throw new Error("union");
    addChild(u.union.id, clara.id, "biological");
    const zip = await exportToZip();
    wipeTree();

    const a = createFamilyPerson({ name: "Anna", birthDate: "1901" }, "admin");
    const b = createFamilyPerson({ name: "Bert", birthDate: "1899" }, "admin");
    const hereClara = createFamilyPerson({ name: "Clara", birthDate: "1930" }, "admin");
    const here = createUnion(a.id, b.id, {});
    if (!("union" in here)) throw new Error("union");
    addChild(here.union.id, hereClara.id, "biological");

    const { plan, result } = await importZip(zip);
    expect(plan.preview.persons.find((p) => p.name === "Clara")!.differences).toEqual([{ field: "parents", here: "yes", package: "yes", resolution: "keepHere" }]);
    expect(result.summary).toMatchObject({ personsCreated: 2, unionsCreated: 1, childrenLinked: 0 });
    expect(db.prepare("SELECT union_id FROM family_tree_children WHERE child_id = ?").all(hereClara.id)).toEqual([{ union_id: here.union.id }]);
  });

  it("fills the empty partner slot of a single-parent family", async () => {
    const m = createFamilyPerson({ name: "Maria", birthDate: "1900" }, "admin");
    const p = createFamilyPerson({ name: "Pyotr", birthDate: "1898" }, "admin");
    const u = createUnion(m.id, p.id, { status: "married", marriedDate: "1920" });
    if (!("union" in u)) throw new Error("union");
    const zip = await exportToZip();
    wipeTree();

    const hereMaria = createFamilyPerson({ name: "Maria", birthDate: "1900" }, "admin");
    const single = createUnion(hereMaria.id, null, {});
    if (!("union" in single)) throw new Error("union");

    const { result } = await importZip(zip);
    expect(result.summary).toMatchObject({ personsCreated: 1, unionsCreated: 0 });
    const unions = getFamilyTree().unions;
    expect(unions).toHaveLength(1);
    expect(unions[0]).toMatchObject({ id: single.union.id, person1Id: hereMaria.id, person2Id: byName("Pyotr").id, status: "married", marriedDate: "1920" });
  });

  it("replace empties the tree first", async () => {
    await seedFamily();
    const zip = await exportToZip();
    wipeTree();
    const zed = createFamilyPerson({ name: "Zed" }, "admin");
    const zedPortrait = await givePortrait(zed.id);
    createFamilySource({ title: "Old notes" });

    const { plan, result } = await importZip(zip, { mode: "replace", persons: {} });
    expect(plan.preview.persons.every((p) => p.match === null && p.decision.action === "add")).toBe(true);
    expect(result.summary).toMatchObject({ personsRemoved: 1, personsCreated: 3, unionsCreated: 1 });
    expect(listFamilyPersons().map((p) => p.name).sort()).toEqual(["Anna Posse", "Boris Posse", "Clara Posse"]);
    expect(fs.existsSync(thumbnailAbsolutePath(zedPortrait))).toBe(false);
    expect(listFamilySources().map((s) => s.title)).toEqual(["Parish register"]);
  });

  it("planning writes nothing", async () => {
    await seedFamily();
    const zip = await exportToZip();
    wipeTree();
    createFamilyPerson({ name: "Anna Posse", birthDate: "1928-03-01" }, "admin");
    const before = db.prepare("SELECT COUNT(*) AS n FROM family_tree_persons").get();
    const { manifest, tree } = await readPackage(zip);
    const plan = planImport(tree, manifest.sourceServer, { mode: "migrate", persons: {} });
    expect(plan.preview.summary.personsCreated).toBe(2);
    expect(db.prepare("SELECT COUNT(*) AS n FROM family_tree_persons").get()).toEqual(before);
    expect(count("family_tree_origins")).toBe(0);
    expect(count("library_items")).toBe(1);
  });

  it("refuses what it cannot read", async () => {
    const notZip = path.join(base, "notes.zip");
    fs.writeFileSync(notZip, "just text");
    await expect(readPackage(notZip)).rejects.toThrow(/not a zip/);

    await seedFamily();
    const build = await buildPackage();
    build.manifest.formatVersion = 99;
    const newer = path.join(base, "newer.zip");
    await writePackage(build, fs.createWriteStream(newer));
    await expect(readPackage(newer)).rejects.toThrow(/newer version/);
  });
});

describe("family-tree package: routes", () => {
  let app: FastifyInstance;
  let signIn: (userId: string) => Promise<string>;

  beforeEach(async () => {
    ({ app, signIn } = await bootApp({
      plugins: [[multipart, { limits: { files: 1, fields: 10, fieldSize: 100 * 1024 } }], familyTreeRoutesPlugin]
    }));
  });
  afterEach(async () => { await app.close(); });

  it("upload → preview → decisions → apply, admins only", async () => {
    await seedFamily();
    const zip = await exportToZip();
    wipeTree();
    const hereAnna = createFamilyPerson({ name: "Anna Posse", birthDate: "1928-03-01" }, "admin");
    const upload = body([{ name: "file", filename: "family-tree.zip", contentType: "application/zip", data: fs.readFileSync(zip) }]);

    const denied = await app.inject({ method: "POST", url: "/api/family-tree/import/package", headers: { ...upload.headers, cookie: await signIn("cousin") }, payload: upload.payload });
    expect(denied.statusCode).toBe(403);

    const cookie = await signIn("admin");
    const uploaded = await app.inject({ method: "POST", url: "/api/family-tree/import/package", headers: { ...upload.headers, cookie }, payload: upload.payload });
    expect(uploaded.statusCode).toBe(200);
    const { token, preview } = uploaded.json() as { token: string; preview: { persons: { id: string; name: string; match: unknown }[]; summary: { personsCreated: number } } };
    expect(preview.summary.personsCreated).toBe(2);
    const anna = preview.persons.find((p) => p.name === "Anna Posse")!;
    expect(anna.match).toMatchObject({ localId: hereAnna.id });
    expect(count("family_tree_persons")).toBe(1);

    const replanned = await app.inject({
      method: "POST", url: `/api/family-tree/import/package/${token}/preview`, headers: { cookie },
      payload: { mode: "migrate", persons: { [anna.id]: { action: "add" } } }
    });
    expect(replanned.statusCode).toBe(200);
    expect((replanned.json() as { preview: { summary: { personsCreated: number } } }).preview.summary.personsCreated).toBe(3);

    const applied = await app.inject({
      method: "POST", url: `/api/family-tree/import/package/${token}/apply`, headers: { cookie },
      payload: { mode: "migrate", persons: {} }
    });
    expect(applied.statusCode).toBe(200);
    const outcome = applied.json() as { summary: { personsCreated: number; photosImported: number }; warnings: string[] };
    expect(outcome.warnings).toEqual([]);
    expect(outcome.summary).toMatchObject({ personsCreated: 2, photosImported: 1 });
    expect(count("family_tree_persons")).toBe(3);

    // The upload is gone once applied.
    const again = await app.inject({ method: "POST", url: `/api/family-tree/import/package/${token}/apply`, headers: { cookie }, payload: { mode: "migrate", persons: {} } });
    expect(again.statusCode).toBe(404);
    const log = db.prepare("SELECT event FROM activity_logs WHERE event = 'familytree.imported'").all();
    expect(log).toHaveLength(1);
  });

  it("rejects a file that is not a package", async () => {
    const upload = body([{ name: "file", filename: "notes.zip", contentType: "application/zip", data: "hello" }]);
    const res = await app.inject({ method: "POST", url: "/api/family-tree/import/package", headers: { ...upload.headers, cookie: await signIn("admin") }, payload: upload.payload });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/not a zip/);
  });

  it("streams the package to an admin", async () => {
    await seedFamily();
    const res = await app.inject({ method: "GET", url: "/api/family-tree/export/package", headers: { cookie: await signIn("admin") } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/zip");
    expect(res.headers["content-disposition"]).toMatch(/family-tree-\d{4}-\d{2}-\d{2}\.zip/);
    const saved = path.join(base, "downloaded.zip");
    fs.writeFileSync(saved, res.rawPayload);
    const { manifest } = await readPackage(saved);
    expect(manifest.counts).toMatchObject({ persons: 3 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM activity_logs WHERE event = 'familytree.exported'").get()).toEqual({ n: 1 });
  });
});
