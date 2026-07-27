import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import {
  parseGedcom,
  gedcomDateToIso,
  gedcomDateRangeToIso,
  isoToGedcomDate,
  importGedcom,
  exportGedcom
} from "../src/modules/familytree/gedcom.js";
import { createFamilyPerson, getFamilyTree, getFamilyPersonProfile, listFamilyPersons } from "../src/modules/familytree/persons.js";
import { addChild, createUnion } from "../src/modules/familytree/relations.js";
import { createFamilyEvent, listFamilyEvents } from "../src/modules/familytree/events.js";
import {
  createFamilySource, createFamilyCitation, listFamilySources, listPersonCitations
} from "../src/modules/familytree/sources.js";
import { resetDb, makeUser } from "./helpers/seed.js";

beforeEach(() => {
  resetDb();
  makeUser("admin", "admin");
});

// Mirrors the structure of an Ancestry.com 5.5.1 export: header noise, SOUR
// citations everywhere, RESI events, a person with two NAME records, full
// month names, and FAM records at the end.
const ANCESTRY_SAMPLE = [
  "0 HEAD",
  "1 SOUR Ancestry.com Family Trees",
  "2 VERS 2025.08",
  "1 GEDC",
  "2 VERS 5.5.1",
  "2 FORM LINEAGE-LINKED",
  "1 CHAR UTF-8",
  "0 @SUBM1@ SUBM",
  "1 NAME Ancestry.com Member Trees Submitter",
  "0 @I1@ INDI",
  "1 NAME Sergey /Mikhalchenko/",
  "2 GIVN Sergey",
  "2 SURN Mikhalchenko",
  "2 SOUR @S1@",
  "1 SEX M",
  "1 FAMC @F1@",
  "1 BIRT",
  "2 DATE 1971",
  "2 SOUR @S1@",
  "1 RESI",
  "2 DATE 2001-2007",
  "2 PLAC St Louis Park, Minnesota, USA",
  "0 @I2@ INDI",
  "1 NAME Ivan /Mikhalchenko/",
  "1 SEX M",
  "1 FAMS @F1@",
  "1 BIRT",
  "2 DATE 3 Jun 1947",
  "2 PLAC Gomel, Belarus",
  "1 DEAT",
  "2 PLAC Gomel, Belarus",
  "0 @I3@ INDI",
  // Two NAME records without TYPE — first wins, second ignored.
  "1 NAME Anna /Posse/",
  "1 NAME Vladimir /Posse/",
  "1 SEX F",
  "1 FAMS @F1@",
  "1 BIRT",
  "2 DATE January 1901",
  "2 PLAC Hampstead, London",
  "1 DEAT",
  "2 DATE 2017",
  "0 @F1@ FAM",
  "1 HUSB @I2@",
  "1 WIFE @I3@",
  "1 CHIL @I1@",
  "0 @S1@ SOUR",
  "1 TITL U.S., Index to Public Records, 1994-2019",
  "0 TRLR",
  ""
].join("\r\n");

describe("gedcom date conversion", () => {
  it("parses GEDCOM date shapes into partial ISO", () => {
    expect(gedcomDateToIso("1971")).toBe("1971");
    expect(gedcomDateToIso("3 Jun 1947")).toBe("1947-06-03");
    expect(gedcomDateToIso("January 1901")).toBe("1901-01");
    expect(gedcomDateToIso("ABT 1924")).toBe("1924");
    expect(gedcomDateToIso("BET 1900 AND 1910")).toBe("1900");
    expect(gedcomDateToIso("10 MAY 1864")).toBe("1864-05-10");
    expect(gedcomDateToIso("451")).toBe("0451");
    // Unparseable shapes degrade to null instead of throwing.
    expect(gedcomDateToIso("2001-2007")).toBeNull();
    expect(gedcomDateToIso("31 FEB 1900")).toBeNull();
    expect(gedcomDateToIso("SOMEDAY")).toBeNull();
  });

  it("parses event date ranges", () => {
    expect(gedcomDateRangeToIso("FROM 2001 TO 2007")).toEqual({ start: "2001", end: "2007" });
    expect(gedcomDateRangeToIso("FROM 3 JUN 1947 TO JAN 1950")).toEqual({ start: "1947-06-03", end: "1950-01" });
    expect(gedcomDateRangeToIso("2001-2007")).toEqual({ start: "2001", end: "2007" });
    expect(gedcomDateRangeToIso("1971")).toEqual({ start: "1971", end: null });
    expect(gedcomDateRangeToIso("SOMEDAY")).toBeNull();
  });

  it("round-trips partial ISO through GEDCOM format", () => {
    for (const iso of ["1971", "1901-01", "1947-06-03"]) {
      expect(gedcomDateToIso(isoToGedcomDate(iso))).toBe(iso);
    }
  });
});

describe("gedcom parser", () => {
  it("folds CONT/CONC into the parent value", () => {
    const records = parseGedcom([
      "0 @I1@ INDI",
      "1 NOTE First line",
      "2 CONC  continued",
      "2 CONT Second line",
      "0 TRLR"
    ].join("\n"));
    const note = records[0].children.find((c) => c.tag === "NOTE");
    expect(note?.value).toBe("First line continued\nSecond line");
  });
});

describe("gedcom import", () => {
  it("imports an Ancestry-style file: persons, unions, children, events", () => {
    const outcome = importGedcom(ANCESTRY_SAMPLE, "add", "admin");
    if ("error" in outcome) throw new Error(outcome.error);
    expect(outcome.result).toMatchObject({
      personsCreated: 3, unionsCreated: 1, childrenLinked: 1, eventsCreated: 1,
      sourcesCreated: 1, citationsCreated: 2, personsRemoved: 0
    });
    // The Ancestry source record and its NAME/BIRT citations import.
    expect(listFamilySources()).toMatchObject([
      { title: "U.S., Index to Public Records, 1994-2019", citationCount: 2 }
    ]);

    const tree = getFamilyTree();
    const byName = new Map(tree.persons.map((p) => [p.name, p]));
    expect(byName.get("Sergey Mikhalchenko")).toMatchObject({ gender: "male", birthDate: "1971" });
    // The RESI record becomes a residence event; "2001-2007" parses as a range.
    expect(listFamilyEvents(byName.get("Sergey Mikhalchenko")!.id)).toMatchObject([
      { type: "residence", date: "2001", endDate: "2007", place: "St Louis Park, Minnesota, USA" }
    ]);
    // A DEAT with PLAC but no DATE still captures the place.
    expect(byName.get("Ivan Mikhalchenko")).toMatchObject({
      gender: "male", birthDate: "1947-06-03", birthplace: "Gomel, Belarus",
      deathDate: null, deathPlace: "Gomel, Belarus"
    });
    // First NAME wins; full month name parses; death year captured.
    expect(byName.get("Anna Posse")).toMatchObject({ gender: "female", birthDate: "1901-01", deathDate: "2017" });
    expect(byName.has("Vladimir Posse")).toBe(false);

    const union = tree.unions[0];
    expect(union.status).toBe("unknown");
    expect([union.person1Id, union.person2Id].sort()).toEqual(
      [byName.get("Ivan Mikhalchenko")!.id, byName.get("Anna Posse")!.id].sort()
    );
    expect(tree.children).toEqual([
      { unionId: union.id, childId: byName.get("Sergey Mikhalchenko")!.id, relation: "biological" }
    ]);
  });

  it("rejects files with no INDI records", () => {
    expect(importGedcom("0 HEAD\n0 TRLR", "add", "admin")).toEqual({ error: "no_persons" });
    expect(importGedcom("just some text", "add", "admin")).toEqual({ error: "no_persons" });
  });

  it("keeps one parent family per child and warns about the rest", () => {
    const text = [
      "0 @I1@ INDI",
      "1 NAME Child /X/",
      "0 @I2@ INDI",
      "1 NAME Mom /X/",
      "1 SEX F",
      "0 @I3@ INDI",
      "1 NAME Dad2 /X/",
      "1 SEX M",
      "0 @F1@ FAM",
      "1 WIFE @I2@",
      "1 CHIL @I1@",
      "0 @F2@ FAM",
      "1 HUSB @I3@",
      "1 CHIL @I1@",
      "0 TRLR"
    ].join("\n");
    const outcome = importGedcom(text, "add", "admin");
    if ("error" in outcome) throw new Error(outcome.error);
    expect(outcome.result.childrenLinked).toBe(1);
    expect(outcome.result.unionsCreated).toBe(2);
    expect(outcome.result.warnings.some((w) => w.includes("more than one family"))).toBe(true);
  });

  it("warns on unknown xrefs and unparseable dates instead of failing", () => {
    const text = [
      "0 @I1@ INDI",
      "1 NAME Solo /Person/",
      "1 BIRT",
      "2 DATE 2001-2007",
      "0 @F1@ FAM",
      "1 HUSB @I1@",
      "1 CHIL @MISSING@",
      "0 TRLR"
    ].join("\n");
    const outcome = importGedcom(text, "add", "admin");
    if ("error" in outcome) throw new Error(outcome.error);
    expect(outcome.result.personsCreated).toBe(1);
    expect(outcome.result.childrenLinked).toBe(0);
    expect(outcome.result.warnings.some((w) => w.includes('birth date "2001-2007"'))).toBe(true);
    expect(outcome.result.warnings.some((w) => w.includes("@MISSING@"))).toBe(true);
    expect(listFamilyPersons()[0].birthDate).toBeNull();
  });

  it("replace mode clears the existing tree and reports removals", () => {
    const existing = createFamilyPerson({ name: "Old Person" }, "admin");
    db.prepare("UPDATE family_tree_persons SET portrait_storage_key = 'old-key' WHERE id = ?").run(existing.id);

    const outcome = importGedcom(ANCESTRY_SAMPLE, "replace", "admin");
    if ("error" in outcome) throw new Error(outcome.error);
    expect(outcome.result.personsRemoved).toBe(1);
    expect(outcome.removedPortraitKeys).toEqual(["old-key"]);
    expect(listFamilyPersons().some((p) => p.name === "Old Person")).toBe(false);
    expect(listFamilyPersons()).toHaveLength(3);
  });

  it("add mode keeps the existing tree alongside the import", () => {
    createFamilyPerson({ name: "Old Person" }, "admin");
    const outcome = importGedcom(ANCESTRY_SAMPLE, "add", "admin");
    if ("error" in outcome) throw new Error(outcome.error);
    expect(outcome.result.personsRemoved).toBe(0);
    expect(listFamilyPersons()).toHaveLength(4);
  });
});

describe("gedcom export", () => {
  it("round-trips the tree through export → import", () => {
    const mom = createFamilyPerson({
      name: "Anna Petrova", maidenName: "Ivanova", gender: "female",
      birthDate: "1950-03", birthplace: "Minsk", bio: "Line one.\nLine two."
    }, "admin");
    const dad = createFamilyPerson({ name: "Boris Petrov", gender: "male", birthDate: "1948", deathDate: "2020-01-05" }, "admin");
    const kid = createFamilyPerson({ name: "Vera Petrova", gender: "female", birthDate: "1975-06-01" }, "admin");
    const union = createUnion(dad.id, mom.id, { status: "married", marriedDate: "1974-08-30" });
    if ("error" in union) throw new Error(union.error);
    const added = addChild(union.union.id, kid.id, "adopted");
    if ("error" in added) throw new Error(added.error);

    const gedcom = exportGedcom();
    expect(gedcom).toContain("1 NAME Anna /Petrova/");
    expect(gedcom).toContain("1 NAME Anna /Ivanova/");
    expect(gedcom).toContain("2 TYPE maiden");
    expect(gedcom).toContain("2 DATE 30 AUG 1974");
    expect(gedcom).toContain("2 PEDI adopted");
    expect(gedcom.trim().endsWith("0 TRLR")).toBe(true);

    // Re-import into a clean tree and verify nothing was lost.
    const outcome = importGedcom(gedcom, "replace", "admin");
    if ("error" in outcome) throw new Error(outcome.error);
    expect(outcome.result).toMatchObject({ personsCreated: 3, unionsCreated: 1, childrenLinked: 1, personsRemoved: 3 });
    expect(outcome.result.warnings).toEqual([]);

    const tree = getFamilyTree();
    const byName = new Map(tree.persons.map((p) => [p.name, p]));
    expect(byName.get("Anna Petrova")).toMatchObject({
      maidenName: "Ivanova", gender: "female", birthDate: "1950-03", birthplace: "Minsk", bio: "Line one.\nLine two."
    });
    expect(byName.get("Boris Petrov")).toMatchObject({ birthDate: "1948", deathDate: "2020-01-05" });
    expect(tree.unions[0]).toMatchObject({ status: "married", marriedDate: "1974-08-30" });
    expect(tree.children[0].relation).toBe("adopted");
    // Gendered slots: HUSB should be the male partner regardless of person1/2 order.
    const husbLine = exportGedcom().split(/\r\n/).find((l) => l.startsWith("1 HUSB"));
    expect(husbLine).toBeDefined();
  });

  it("round-trips partner status and single-parent unions via _STATUS", () => {
    const mom = createFamilyPerson({ name: "Solo Mom", gender: "female" }, "admin");
    const kid = createFamilyPerson({ name: "Only Kid" }, "admin");
    const union = createUnion(mom.id, null, { status: "partners" });
    if ("error" in union) throw new Error(union.error);
    const added = addChild(union.union.id, kid.id, "step");
    if ("error" in added) throw new Error(added.error);

    const gedcom = exportGedcom();
    expect(gedcom).toContain("1 _STATUS partners");
    expect(gedcom).toContain("2 _REL step");
    expect(gedcom).toContain("1 WIFE"); // female single parent lands in the WIFE slot
    expect(gedcom).not.toContain("1 HUSB");

    const outcome = importGedcom(gedcom, "replace", "admin");
    if ("error" in outcome) throw new Error(outcome.error);
    const tree = getFamilyTree();
    expect(tree.unions[0].status).toBe("partners");
    expect(tree.unions[0].person2Id).toBeNull();
    expect(tree.children[0].relation).toBe("step");
  });

  it("round-trips life events, death place, and marriage place", () => {
    const person = createFamilyPerson({
      name: "Eva Line", gender: "female", deathDate: "2001", deathPlace: "Minsk, Belarus"
    }, "admin");
    const partner = createFamilyPerson({ name: "Adam Line", gender: "male" }, "admin");
    const union = createUnion(person.id, partner.id, {
      status: "married", marriedDate: "1950-05-09", marriedPlace: "Gomel"
    });
    if ("error" in union) throw new Error(union.error);
    createFamilyEvent(person.id, {
      type: "education", label: "Belarusian State University", date: "1938", endDate: "1943", place: "Minsk"
    });
    createFamilyEvent(person.id, { type: "occupation", label: "Teacher", date: "1944", note: "Village school." });
    createFamilyEvent(person.id, { type: "residence", date: "1960", place: "Leningrad" });
    createFamilyEvent(person.id, { type: "custom", label: "Award", note: "Medal for labour." });

    const gedcom = exportGedcom();
    expect(gedcom).toContain("1 EDUC Belarusian State University");
    expect(gedcom).toContain("2 DATE FROM 1938 TO 1943");
    expect(gedcom).toContain("1 OCCU Teacher");
    expect(gedcom).toContain("1 RESI");
    expect(gedcom).toContain("2 TYPE Award");
    expect(gedcom).toContain("2 PLAC Gomel");

    const outcome = importGedcom(gedcom, "replace", "admin");
    if ("error" in outcome) throw new Error(outcome.error);
    expect(outcome.result).toMatchObject({ personsCreated: 2, eventsCreated: 4 });
    expect(outcome.result.warnings).toEqual([]);

    const reimported = listFamilyPersons().find((p) => p.name === "Eva Line")!;
    expect(reimported).toMatchObject({ deathDate: "2001", deathPlace: "Minsk, Belarus" });
    expect(listFamilyEvents(reimported.id)).toMatchObject([
      { type: "education", label: "Belarusian State University", date: "1938", endDate: "1943", place: "Minsk" },
      { type: "occupation", label: "Teacher", date: "1944", note: "Village school." },
      { type: "residence", date: "1960", place: "Leningrad", label: null },
      { type: "custom", label: "Award", note: "Medal for labour.", date: null }
    ]);
    const profile = getFamilyPersonProfile(reimported.id)!;
    expect(profile.unions[0]).toMatchObject({ marriedDate: "1950-05-09", marriedPlace: "Gomel" });
    expect(profile.events).toHaveLength(4);
  });

  it("round-trips sources and citations across facts, events, and unions", () => {
    const person = createFamilyPerson({ name: "Eva Cited", gender: "female", birthDate: "1901-01" }, "admin");
    const partner = createFamilyPerson({ name: "Adam Cited", gender: "male" }, "admin");
    const union = createUnion(person.id, partner.id, { status: "married", marriedDate: "1925" });
    if ("error" in union) throw new Error(union.error);
    const event = createFamilyEvent(person.id, { type: "residence", date: "1930", place: "Minsk" })!;

    const geneanet = createFamilySource({
      title: "Geneanet Community Trees Index", author: "Ancestry.com",
      publisher: "Ancestry.com Operations, Inc., Lehi, UT, USA, 2022",
      url: "https://www.geneanet.org", note: "Repository: Ancestry.com"
    });
    const records = createFamilySource({ title: "Public Records Index" });
    const cite = (fields: Parameters<typeof createFamilyCitation>[0]) => {
      const result = createFamilyCitation(fields);
      if ("error" in result) throw new Error(result.error);
    };
    cite({ sourceId: geneanet.id, personId: person.id, fact: "birth", detail: "Record 12", url: "https://gw.geneanet.org/vergezha1?p=eva" });
    cite({ sourceId: records.id, personId: person.id, fact: null, note: "General mention." });
    cite({ sourceId: records.id, eventId: event.id });
    cite({ sourceId: geneanet.id, unionId: union.union.id, fact: "marriage" });

    const gedcom = exportGedcom();
    expect(gedcom).toContain("0 @S1@ SOUR");
    expect(gedcom).toContain("1 TITL Geneanet Community Trees Index");
    // Citation subtags sit one level under the level-2 SOUR pointer.
    expect(gedcom).toContain("3 PAGE Record 12");
    expect(gedcom).toContain("4 WWW https://gw.geneanet.org/vergezha1?p=eva");

    const outcome = importGedcom(gedcom, "replace", "admin");
    if ("error" in outcome) throw new Error(outcome.error);
    expect(outcome.result).toMatchObject({ sourcesCreated: 2, citationsCreated: 4 });
    expect(outcome.result.warnings).toEqual([]);

    const reimported = listFamilyPersons().find((p) => p.name === "Eva Cited")!;
    const citations = listPersonCitations(reimported.id);
    expect(citations).toHaveLength(4);
    const birthCite = citations.find((c) => c.fact === "birth")!;
    expect(birthCite).toMatchObject({
      sourceTitle: "Geneanet Community Trees Index",
      detail: "Record 12",
      url: "https://gw.geneanet.org/vergezha1?p=eva"
    });
    expect(citations.find((c) => c.fact === "marriage")?.unionId).toBeTruthy();
    expect(citations.find((c) => c.eventId != null)?.sourceTitle).toBe("Public Records Index");
    // Source fields survive the trip.
    expect(listFamilySources().find((s) => s.title.startsWith("Geneanet"))).toMatchObject({
      author: "Ancestry.com", url: "https://www.geneanet.org", citationCount: 2
    });
  });

  it("dedups sources by title when importing on top of an existing tree", () => {
    createFamilySource({ title: "Public Records Index" });
    const text = [
      "0 @I1@ INDI",
      "1 NAME Solo /Person/",
      "1 SOUR @S1@",
      "0 @S1@ SOUR",
      "1 TITL public records index",
      "0 TRLR"
    ].join("\n");
    const outcome = importGedcom(text, "add", "admin");
    if ("error" in outcome) throw new Error(outcome.error);
    expect(outcome.result.sourcesCreated).toBe(0);
    expect(outcome.result.citationsCreated).toBe(1);
    expect(listFamilySources()).toHaveLength(1);
  });

  it("splits long notes across CONT/CONC lines that re-import intact", () => {
    const bio = `${"A".repeat(450)}\nSecond paragraph.`;
    createFamilyPerson({ name: "Long Bio", bio }, "admin");
    const gedcom = exportGedcom();
    expect(gedcom).toContain("2 CONC");
    expect(gedcom).toContain("2 CONT");
    const outcome = importGedcom(gedcom, "replace", "admin");
    if ("error" in outcome) throw new Error(outcome.error);
    expect(listFamilyPersons()[0].bio).toBe(bio);
  });
});
