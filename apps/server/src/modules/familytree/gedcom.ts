// GEDCOM 5.5.1 import/export. The union/children schema was designed
// GEDCOM-shaped (union == FAM), so both directions are near-1:1:
//
//   INDI → family_tree_persons   (NAME, SEX, BIRT/DEAT DATE+PLAC, NOTE → bio)
//   FAM  → family_tree_unions    (HUSB/WIFE, MARR/DIV events)
//   CHIL → family_tree_children  (PEDI adopted/foster → relation)
//
// Import is tolerant: anything it can't map (unparseable dates, unknown xrefs,
// a second parent-family for a child, cycles) is skipped with a human-readable
// warning rather than failing the whole file. Export emits plain 5.5.1 that
// Ancestry/Gramps/etc. accept, plus two custom tags (`_STATUS` on FAM,
// `_REL` on FAMC) so union statuses and step-child links survive a round trip.
import { nanoid } from "nanoid";
import { db } from "../../db.js";
import { isAncestorOf } from "./persons.js";
import { UNION_STATUSES, CHILD_RELATIONS } from "./relations.js";

export interface GedcomNode {
  tag: string;
  /** Record id of a level-0 record (`@I1@`). Pointer values stay in `value`. */
  xref: string | null;
  value: string;
  children: GedcomNode[];
}

// Level stack parser. CONT/CONC never become nodes — they fold back into the
// value of the line they continue, so consumers see complete multi-line text.
export function parseGedcom(text: string): GedcomNode[] {
  const records: GedcomNode[] = [];
  const stack: GedcomNode[] = [];
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip UTF-8 BOM
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trimStart();
    if (!line) continue;
    const match = /^(\d+)\s+(?:(@[^@]+@)\s+)?([A-Za-z0-9_]+)(?: (.*))?$/.exec(line);
    if (!match) continue;
    const level = Number(match[1]);
    const node: GedcomNode = { tag: match[3].toUpperCase(), xref: match[2] ?? null, value: match[4] ?? "", children: [] };
    if (node.tag === "CONT" || node.tag === "CONC") {
      const target = stack[level - 1];
      if (target) target.value += (node.tag === "CONT" ? "\n" : "") + node.value;
      continue;
    }
    if (level === 0) records.push(node);
    else stack[level - 1]?.children.push(node);
    stack.length = level;
    stack[level] = node;
  }
  return records;
}

const child = (node: GedcomNode, tag: string) => node.children.find((c) => c.tag === tag);
const childValue = (node: GedcomNode, tag: string) => child(node, tag)?.value.trim() ?? "";

// ── Dates: GEDCOM ("3 JUN 1947", "January 1901", "1971") ↔ partial ISO ──

const MONTH_ABBR = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

// Full month names all start with their GEDCOM abbreviation, so a 3-letter
// prefix lookup covers "JAN" and "JANUARY" alike.
function monthNumber(word: string): number | null {
  const index = MONTH_ABBR.indexOf(word.slice(0, 3));
  return index === -1 ? null : index + 1;
}

function validDay(year: number, month: number, day: number): boolean {
  return day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

const pad4 = (year: string) => year.padStart(4, "0");
const pad2 = (n: number) => String(n).padStart(2, "0");

// Approximation qualifiers (ABT/EST/BEF/…) are stripped — a partial date keeps
// the value, the "about" nuance is lost. Ranges keep their first date.
export function gedcomDateToIso(raw: string): string | null {
  let text = raw.trim().toUpperCase();
  if (!text) return null;
  const between = /^BET\.?\s+(.+?)\s+AND\s+.+$/.exec(text);
  if (between) text = between[1];
  text = text
    .replace(/^(ABT|ABOUT|EST|CAL|BEF|BEFORE|AFT|AFTER|FROM|INT)\.?\s+/, "")
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  let match = /^(\d{1,2}) ([A-Z]+) (\d{1,4})$/.exec(text);
  if (match) {
    const month = monthNumber(match[2]);
    const day = Number(match[1]);
    if (month == null || !validDay(Number(match[3]), month, day)) return null;
    return `${pad4(match[3])}-${pad2(month)}-${pad2(day)}`;
  }
  match = /^([A-Z]+) (\d{1,4})$/.exec(text);
  if (match) {
    const month = monthNumber(match[1]);
    return month == null ? null : `${pad4(match[2])}-${pad2(month)}`;
  }
  match = /^(\d{3,4})$/.exec(text);
  return match ? pad4(match[1]) : null;
}

// Event dates may be ranges: standard "FROM 2001 TO 2007" or Ancestry's bare
// "2001-2007". A single date yields { start, end: null }.
export function gedcomDateRangeToIso(raw: string): { start: string | null; end: string | null } | null {
  const text = raw.trim().toUpperCase();
  if (!text) return null;
  const fromTo = /^FROM\s+(.+?)\s+TO\s+(.+)$/.exec(text);
  if (fromTo) {
    const start = gedcomDateToIso(fromTo[1]);
    const end = gedcomDateToIso(fromTo[2]);
    return start || end ? { start, end } : null;
  }
  const bare = /^(\d{3,4})\s*-\s*(\d{3,4})$/.exec(text);
  if (bare) return { start: pad4(bare[1]), end: pad4(bare[2]) };
  const single = gedcomDateToIso(text);
  return single ? { start: single, end: null } : null;
}

export function isoToGedcomDate(iso: string): string {
  const [year, month, day] = iso.split("-");
  if (day) return `${Number(day)} ${MONTH_ABBR[Number(month) - 1]} ${Number(year)}`;
  if (month) return `${MONTH_ABBR[Number(month) - 1]} ${Number(year)}`;
  return String(Number(year));
}

// ── Names: "Sergey /Mikhalchenko/" ↔ display name ──

function parseNameNode(node: GedcomNode): { given: string; surname: string; full: string } {
  const match = /^([^/]*)(?:\/([^/]*)\/)?(.*)$/.exec(node.value.trim())!;
  let given = match[1].trim();
  let surname = (match[2] ?? "").trim();
  const suffix = match[3].trim();
  if (!given) given = childValue(node, "GIVN");
  if (!surname) surname = childValue(node, "SURN");
  const full = [given, surname, suffix].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  return { given, surname, full };
}

function splitName(name: string): { given: string; surname: string } {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return { given: name.trim(), surname: "" };
  return { given: parts.slice(0, -1).join(" "), surname: parts[parts.length - 1] };
}

// ── Import ──

export type GedcomImportMode = "add" | "replace";

export interface GedcomImportResult {
  personsCreated: number;
  unionsCreated: number;
  childrenLinked: number;
  eventsCreated: number;
  sourcesCreated: number;
  citationsCreated: number;
  personsRemoved: number;
  warnings: string[];
}

export type GedcomImportOutcome =
  | { result: GedcomImportResult; removedPortraitKeys: string[] }
  | { error: "no_persons" };

const PEDI_RELATION: Record<string, string> = { adopted: "adopted", foster: "foster", birth: "biological" };

// INDI-level event tags → family_tree_events. BIRT/DEAT stay person columns.
// `label` is a default when the line carries no value and no TYPE subtag.
const EVENT_TAG_MAP: Record<string, { type: string; label?: string }> = {
  RESI: { type: "residence" },
  EDUC: { type: "education" },
  GRAD: { type: "graduation" },
  OCCU: { type: "occupation" },
  _MILT: { type: "military" },
  IMMI: { type: "immigration" },
  EMIG: { type: "emigration" },
  BURI: { type: "burial" },
  CREM: { type: "burial", label: "Cremation" },
  NATU: { type: "naturalization" },
  RETI: { type: "retirement" },
  CHR: { type: "baptism", label: "Christening" },
  BAPM: { type: "baptism" },
  CONF: { type: "custom", label: "Confirmation" },
  CENS: { type: "custom", label: "Census" },
  EVEN: { type: "custom", label: "Event" }
};

// Round-trip for typed events exported as `EVEN` + TYPE: an incoming EVEN whose
// label matches one of these becomes the typed event again instead of custom.
const EVEN_TYPE_BY_LABEL: Record<string, string> = { travel: "travel", award: "award" };

// family_tree_events → GEDCOM tag; value-bearing tags carry the label on the
// event line itself, the rest put it in a TYPE subtag.
const EVENT_TYPE_TAG: Record<string, { tag: string; labelAsValue: boolean; defaultLabel?: string }> = {
  residence: { tag: "RESI", labelAsValue: false },
  education: { tag: "EDUC", labelAsValue: true },
  graduation: { tag: "GRAD", labelAsValue: false },
  occupation: { tag: "OCCU", labelAsValue: true },
  retirement: { tag: "RETI", labelAsValue: false },
  military: { tag: "_MILT", labelAsValue: true },
  immigration: { tag: "IMMI", labelAsValue: false },
  emigration: { tag: "EMIG", labelAsValue: false },
  naturalization: { tag: "NATU", labelAsValue: false },
  // No standard GEDCOM tag — exported as EVEN with a TYPE that survives the
  // round trip (see EVEN_TYPE_BY_LABEL on import).
  travel: { tag: "EVEN", labelAsValue: false, defaultLabel: "Travel" },
  award: { tag: "EVEN", labelAsValue: false, defaultLabel: "Award" },
  baptism: { tag: "BAPM", labelAsValue: false },
  burial: { tag: "BURI", labelAsValue: false },
  custom: { tag: "EVEN", labelAsValue: false }
};

export function importGedcom(text: string, mode: GedcomImportMode, createdBy: string): GedcomImportOutcome {
  const records = parseGedcom(text);
  const indis = records.filter((r) => r.tag === "INDI" && r.xref);
  if (indis.length === 0) return { error: "no_persons" };
  const fams = records.filter((r) => r.tag === "FAM" && r.xref);
  // Shared top-level NOTE records, so `1 NOTE @N1@` pointers resolve to text.
  const noteRecords = new Map(records.filter((r) => r.tag === "NOTE" && r.xref).map((r) => [r.xref!, r.value]));

  const warnings: string[] = [];
  const result: GedcomImportResult = {
    personsCreated: 0, unionsCreated: 0, childrenLinked: 0, eventsCreated: 0,
    sourcesCreated: 0, citationsCreated: 0, personsRemoved: 0, warnings
  };
  const removedPortraitKeys: string[] = [];

  const insertPerson = db.prepare(`
    INSERT INTO family_tree_persons (id, name, maiden_name, gender, birth_date, death_date, birthplace, death_place, bio, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertUnion = db.prepare(`
    INSERT INTO family_tree_unions (id, person1_id, person2_id, status, married_date, married_place, divorced_date, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertChild = db.prepare(
    "INSERT INTO family_tree_children (union_id, child_id, relation) VALUES (?, ?, ?)"
  );
  const insertEvent = db.prepare(`
    INSERT INTO family_tree_events (id, person_id, type, label, date, end_date, place, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSource = db.prepare(`
    INSERT INTO family_tree_sources (id, title, author, publisher, url, note)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertCitation = db.prepare(`
    INSERT INTO family_tree_citations (id, source_id, person_id, event_id, union_id, fact, detail, url, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // A NOTE value may be inline text or a pointer to a shared NOTE record.
  const noteText = (node: GedcomNode | undefined): string =>
    node ? (noteRecords.get(node.value.trim()) ?? node.value).trim() : "";

  db.transaction(() => {
    if (mode === "replace") {
      const keys = db.prepare(
        "SELECT portrait_storage_key AS key FROM family_tree_persons WHERE portrait_storage_key IS NOT NULL"
      ).all() as { key: string }[];
      removedPortraitKeys.push(...keys.map((r) => r.key));
      // Persons cascade unions, which cascade child links; photo attachments,
      // events, and citations cascade too. Sources are tree data, so replacing
      // the tree replaces them as well. Gallery items and people are untouched.
      // Tag links have no FK on entity_id, so they need explicit cleanup.
      db.prepare(`
        DELETE FROM taggables WHERE entity_type = 'family_tree_person'
          AND entity_id IN (SELECT id FROM family_tree_persons)
      `).run();
      result.personsRemoved = db.prepare("DELETE FROM family_tree_persons").run().changes;
      db.prepare("DELETE FROM family_tree_sources").run();
    }

    // ── Sources ──
    // Re-importing the same file must not duplicate the bibliography, so
    // sources dedup by title (case-insensitive) against what's already there.
    const repoNames = new Map(
      records.filter((r) => r.tag === "REPO" && r.xref).map((r) => [r.xref!, childValue(r, "NAME")])
    );
    const sourceIdByTitle = new Map<string, string>(
      (db.prepare("SELECT id, title FROM family_tree_sources").all() as { id: string; title: string }[])
        .map((r) => [r.title.toLowerCase(), r.id])
    );
    const sourceIdByXref = new Map<string, string>();
    const internSource = (title: string, fields: { author?: string; publisher?: string; url?: string; note?: string }): string => {
      const key = title.toLowerCase();
      const existing = sourceIdByTitle.get(key);
      if (existing) return existing;
      const id = nanoid(16);
      insertSource.run(
        id, title.slice(0, 300), fields.author?.slice(0, 200) || null, fields.publisher?.slice(0, 300) || null,
        fields.url?.slice(0, 1000) || null, fields.note?.slice(0, 2000) || null
      );
      sourceIdByTitle.set(key, id);
      result.sourcesCreated += 1;
      return id;
    };
    for (const rec of records.filter((r) => r.tag === "SOUR" && r.xref)) {
      const publ = child(rec, "PUBL");
      const publisher = publ
        ? [publ.value.trim(), childValue(publ, "PLAC"), childValue(publ, "DATE")].filter(Boolean).join(", ")
        : "";
      const repoName = repoNames.get(childValue(rec, "REPO")) ?? "";
      const note = [
        rec.children.find((c) => c.tag === "NOTE")?.value.trim() ?? "",
        repoName ? `Repository: ${repoName}` : ""
      ].filter(Boolean).join("\n");
      sourceIdByXref.set(rec.xref!, internSource(childValue(rec, "TITL") || "Untitled source", {
        author: childValue(rec, "AUTH"),
        publisher,
        url: childValue(rec, "WWW") || childValue(rec, "URL"),
        note
      }));
    }

    // SOUR children of `node` become citations on `target`. Pointer values
    // resolve to source records; a plain-text value (embedded source) becomes
    // a source titled with that text.
    const addCitations = (
      node: GedcomNode | undefined,
      target: { person?: string; event?: string; union?: string },
      fact: string | null,
      who: string
    ) => {
      if (!node) return;
      for (const sour of node.children.filter((c) => c.tag === "SOUR")) {
        const value = sour.value.trim();
        let sourceId: string | undefined;
        if (value.startsWith("@")) {
          sourceId = sourceIdByXref.get(value);
          if (!sourceId) {
            warnings.push(`${who}: source ${value} not found in the file — citation skipped.`);
            continue;
          }
        } else if (value) {
          sourceId = internSource(value.split("\n")[0], {});
        } else {
          continue;
        }
        const data = child(sour, "DATA");
        insertCitation.run(
          nanoid(16), sourceId,
          target.person ?? null, target.event ?? null, target.union ?? null, fact,
          childValue(sour, "PAGE").slice(0, 500) || null,
          (data ? childValue(data, "WWW") : "").slice(0, 1000) || null,
          noteText(child(sour, "NOTE")).slice(0, 2000) || null
        );
        result.citationsCreated += 1;
      }
    };

    const parseDate = (node: GedcomNode | undefined, what: string, who: string): string | null => {
      const raw = node ? childValue(node, "DATE") : "";
      if (!raw) return null;
      const iso = gedcomDateToIso(raw);
      if (iso == null) warnings.push(`${who}: couldn't read ${what} date "${raw}" — left blank.`);
      return iso;
    };

    const idByXref = new Map<string, string>();
    const nameByXref = new Map<string, string>();
    for (const indi of indis) {
      const nameNodes = indi.children.filter((c) => c.tag === "NAME");
      let name = nameNodes.length > 0 ? parseNameNode(nameNodes[0]).full : "";
      if (!name) {
        name = "Unknown";
        warnings.push(`${indi.xref}: person has no name — imported as "Unknown".`);
      }
      const maidenNode = nameNodes.slice(1).find((n) => childValue(n, "TYPE").toLowerCase() === "maiden");
      const maidenName = maidenNode ? parseNameNode(maidenNode).surname : "";
      const sex = childValue(indi, "SEX").toUpperCase();
      const gender = sex === "M" ? "male" : sex === "F" ? "female" : "unknown";
      const birth = child(indi, "BIRT");
      const death = child(indi, "DEAT");
      const bio = noteText(child(indi, "NOTE"));

      const id = nanoid(16);
      insertPerson.run(
        id, name.slice(0, 120), maidenName.slice(0, 120) || null, gender,
        parseDate(birth, "birth", name), parseDate(death, "death", name),
        (birth ? childValue(birth, "PLAC") : "").slice(0, 200) || null,
        (death ? childValue(death, "PLAC") : "").slice(0, 200) || null,
        bio.slice(0, 4000) || null, createdBy
      );
      idByXref.set(indi.xref!, id);
      nameByXref.set(indi.xref!, name);
      result.personsCreated += 1;

      addCitations(indi, { person: id }, null, name);
      if (nameNodes.length > 0) addCitations(nameNodes[0], { person: id }, "name", name);
      addCitations(birth, { person: id }, "birth", name);
      addCitations(death, { person: id }, "death", name);

      // Every other event-ish tag becomes a timeline entry. The line value
      // (e.g. "1 OCCU Farmer") or a TYPE subtag is the label; DATE may be a
      // range ("FROM 2001 TO 2007", Ancestry's "2001-2007").
      for (const node of indi.children) {
        const mapping = EVENT_TAG_MAP[node.tag];
        if (!mapping) continue;
        const inlineValue = node.value.trim();
        const label = (!inlineValue.startsWith("@") && inlineValue)
          || childValue(node, "TYPE")
          || mapping.label
          || null;
        // An EVEN whose TYPE names one of our typed events comes back typed.
        const eventType = (node.tag === "EVEN" && label && EVEN_TYPE_BY_LABEL[label.toLowerCase()]) || mapping.type;
        const rawDate = childValue(node, "DATE");
        const range = rawDate ? gedcomDateRangeToIso(rawDate) : null;
        if (rawDate && !range) {
          warnings.push(`${name}: couldn't read date "${rawDate}" on a ${eventType} event — left blank.`);
        }
        const eventId = nanoid(16);
        insertEvent.run(
          eventId, id, eventType,
          label ? label.slice(0, 120) : null,
          range?.start ?? null, range?.end ?? null,
          childValue(node, "PLAC").slice(0, 200) || null,
          noteText(child(node, "NOTE")).slice(0, 2000) || null
        );
        result.eventsCreated += 1;
        addCitations(node, { event: eventId }, null, name);
      }
    }

    // In "add" mode existing children keep their one-parent-union invariant too.
    const linkedChildren = new Set<string>(
      (db.prepare("SELECT child_id FROM family_tree_children").all() as { child_id: string }[]).map((r) => r.child_id)
    );

    const resolve = (fam: GedcomNode, tag: string): string | null => {
      const xref = childValue(fam, tag);
      if (!xref) return null;
      const id = idByXref.get(xref);
      if (!id) warnings.push(`${fam.xref}: ${tag === "HUSB" ? "husband" : tag === "WIFE" ? "wife" : "member"} ${xref} not found in the file — skipped.`);
      return id ?? null;
    };

    for (const fam of fams) {
      const husb = resolve(fam, "HUSB");
      const wife = resolve(fam, "WIFE");
      const partners = [husb, wife].filter((id): id is string => id != null);
      const childNodes = fam.children.filter((c) => c.tag === "CHIL");
      if (partners.length === 0) {
        if (childNodes.length > 0) {
          warnings.push(`${fam.xref}: family has no resolvable parents — its ${childNodes.length} child link(s) were skipped.`);
        }
        continue;
      }

      const marr = child(fam, "MARR");
      const div = child(fam, "DIV");
      const customStatus = childValue(fam, "_STATUS").toLowerCase();
      const status = (UNION_STATUSES as readonly string[]).includes(customStatus)
        ? customStatus
        : div ? "divorced" : marr ? "married" : "unknown";

      const unionId = nanoid(16);
      insertUnion.run(
        unionId, partners[0], partners[1] ?? null, status,
        parseDate(marr, "marriage", String(fam.xref)),
        (marr ? childValue(marr, "PLAC") : "").slice(0, 200) || null,
        parseDate(div, "divorce", String(fam.xref)),
        childValue(fam, "NOTE").slice(0, 1000) || null
      );
      result.unionsCreated += 1;

      addCitations(fam, { union: unionId }, null, String(fam.xref));
      addCitations(marr, { union: unionId }, "marriage", String(fam.xref));
      addCitations(div, { union: unionId }, "divorce", String(fam.xref));

      for (const chil of childNodes) {
        const xref = chil.value.trim();
        const childId = idByXref.get(xref);
        const childName = nameByXref.get(xref) ?? xref;
        if (!childId) {
          warnings.push(`${fam.xref}: child ${xref} not found in the file — skipped.`);
          continue;
        }
        if (childId === partners[0] || childId === partners[1]) {
          warnings.push(`${fam.xref}: ${childName} is listed as both parent and child — child link skipped.`);
          continue;
        }
        if (linkedChildren.has(childId)) {
          warnings.push(`${childName} appears as a child in more than one family — kept the first, skipped ${fam.xref}.`);
          continue;
        }
        if (partners.some((parent) => isAncestorOf(childId, parent))) {
          warnings.push(`${fam.xref}: linking ${childName} would make someone their own ancestor — skipped.`);
          continue;
        }
        // The child's own FAMC pointing back at this family carries PEDI
        // (adopted/foster/birth) or our round-trip `_REL` tag.
        const indi = indis.find((r) => r.xref === xref);
        const famc = indi?.children.find((c) => c.tag === "FAMC" && c.value.trim() === fam.xref);
        const pedi = famc ? childValue(famc, "PEDI").toLowerCase() : "";
        const rel = famc ? childValue(famc, "_REL").toLowerCase() : "";
        const relation = PEDI_RELATION[pedi]
          ?? ((CHILD_RELATIONS as readonly string[]).includes(rel) ? rel : "biological");
        insertChild.run(unionId, childId, relation);
        linkedChildren.add(childId);
        result.childrenLinked += 1;
      }
    }
  })();

  return { result, removedPortraitKeys };
}

// ── Export ──

export function exportGedcom(): string {
  const persons = db.prepare(`
    SELECT id, name, maiden_name, gender, birth_date, death_date, birthplace, death_place, bio
    FROM family_tree_persons ORDER BY name COLLATE NOCASE
  `).all() as {
    id: string; name: string; maiden_name: string | null; gender: string;
    birth_date: string | null; death_date: string | null;
    birthplace: string | null; death_place: string | null; bio: string | null;
  }[];
  const unions = db.prepare(`
    SELECT id, person1_id, person2_id, status, married_date, married_place, divorced_date, note
    FROM family_tree_unions ORDER BY married_date IS NULL, married_date, id
  `).all() as {
    id: string; person1_id: string; person2_id: string | null; status: string;
    married_date: string | null; married_place: string | null;
    divorced_date: string | null; note: string | null;
  }[];
  const childLinks = db.prepare(
    "SELECT union_id, child_id, relation FROM family_tree_children"
  ).all() as { union_id: string; child_id: string; relation: string }[];
  const eventRows = db.prepare(`
    SELECT id, person_id, type, label, date, end_date, place, note
    FROM family_tree_events ORDER BY date IS NULL, date, created_at
  `).all() as {
    id: string; person_id: string; type: string; label: string | null;
    date: string | null; end_date: string | null; place: string | null; note: string | null;
  }[];
  const sources = db.prepare(
    "SELECT id, title, author, publisher, url, note FROM family_tree_sources ORDER BY title COLLATE NOCASE"
  ).all() as {
    id: string; title: string; author: string | null; publisher: string | null;
    url: string | null; note: string | null;
  }[];
  const citations = db.prepare(`
    SELECT source_id, person_id, event_id, union_id, fact, detail, url, note
    FROM family_tree_citations ORDER BY created_at
  `).all() as {
    source_id: string; person_id: string | null; event_id: string | null; union_id: string | null;
    fact: string | null; detail: string | null; url: string | null; note: string | null;
  }[];
  const sourceXref = new Map(sources.map((s, i) => [s.id, `@S${i + 1}@`]));

  const personXref = new Map(persons.map((p, i) => [p.id, `@I${i + 1}@`]));
  const unionXref = new Map(unions.map((u, i) => [u.id, `@F${i + 1}@`]));
  const genderById = new Map(persons.map((p) => [p.id, p.gender]));
  const birthById = new Map(persons.map((p) => [p.id, p.birth_date]));

  const lines: string[] = [];
  // Splits multi-line values into CONT and chunks long ones into CONC so no
  // physical line exceeds GEDCOM's limit.
  const push = (level: number, tag: string, value = "") => {
    value.split("\n").forEach((segment, index) => {
      let rest = segment;
      let first = true;
      do {
        const chunk = rest.slice(0, 200);
        rest = rest.slice(200);
        const lineTag = first ? (index === 0 ? tag : "CONT") : "CONC";
        const lineLevel = first && index === 0 ? level : level + 1;
        lines.push(`${lineLevel} ${lineTag}${chunk ? ` ${chunk}` : ""}`);
        first = false;
      } while (rest);
    });
  };

  type Citation = (typeof citations)[number];
  const pushCitation = (level: number, citation: Citation) => {
    push(level, "SOUR", sourceXref.get(citation.source_id)!);
    if (citation.detail) push(level + 1, "PAGE", citation.detail);
    // Citation-specific links use Ancestry's DATA > WWW shape, which the
    // importer reads back.
    if (citation.url) {
      push(level + 1, "DATA");
      push(level + 2, "WWW", citation.url);
    }
    if (citation.note) push(level + 1, "NOTE", citation.note);
  };
  const personCites = (personId: string, fact: string | null) =>
    citations.filter((c) => c.person_id === personId && (fact === null ? c.fact == null || !["name", "birth", "death"].includes(c.fact) : c.fact === fact));
  const unionCites = (unionId: string, fact: string | null) =>
    citations.filter((c) => c.union_id === unionId && (fact === null ? c.fact == null || !["marriage", "divorce"].includes(c.fact) : c.fact === fact));
  const eventCites = (eventId: string) => citations.filter((c) => c.event_id === eventId);

  const now = new Date();
  lines.push("0 HEAD");
  push(1, "SOUR", "isputnik.home");
  push(2, "NAME", "isputnik.home");
  push(1, "DATE", `${now.getUTCDate()} ${MONTH_ABBR[now.getUTCMonth()]} ${now.getUTCFullYear()}`);
  push(1, "SUBM", "@SUBM1@");
  push(1, "GEDC");
  push(2, "VERS", "5.5.1");
  push(2, "FORM", "LINEAGE-LINKED");
  push(1, "CHAR", "UTF-8");
  lines.push("0 @SUBM1@ SUBM");
  push(1, "NAME", "isputnik.home");

  for (const person of persons) {
    lines.push(`0 ${personXref.get(person.id)} INDI`);
    const { given, surname } = splitName(person.name);
    push(1, "NAME", `${given} /${surname}/`);
    if (given) push(2, "GIVN", given);
    if (surname) push(2, "SURN", surname);
    for (const citation of personCites(person.id, "name")) pushCitation(2, citation);
    if (person.maiden_name) {
      push(1, "NAME", `${given} /${person.maiden_name}/`);
      push(2, "TYPE", "maiden");
      push(2, "SURN", person.maiden_name);
    }
    push(1, "SEX", person.gender === "male" ? "M" : person.gender === "female" ? "F" : "U");
    // A bare BIRT/DEAT still gets emitted when only citations exist for the
    // fact, so their targeting survives the round trip.
    const birthCites = personCites(person.id, "birth");
    if (person.birth_date || person.birthplace || birthCites.length > 0) {
      push(1, "BIRT");
      if (person.birth_date) push(2, "DATE", isoToGedcomDate(person.birth_date));
      if (person.birthplace) push(2, "PLAC", person.birthplace);
      for (const citation of birthCites) pushCitation(2, citation);
    }
    const deathCites = personCites(person.id, "death");
    if (person.death_date || person.death_place || deathCites.length > 0) {
      push(1, "DEAT");
      if (person.death_date) push(2, "DATE", isoToGedcomDate(person.death_date));
      if (person.death_place) push(2, "PLAC", person.death_place);
      for (const citation of deathCites) pushCitation(2, citation);
    }
    if (person.bio) push(1, "NOTE", person.bio);
    for (const citation of personCites(person.id, null)) pushCitation(1, citation);
    for (const event of eventRows.filter((e) => e.person_id === person.id)) {
      const mapping = EVENT_TYPE_TAG[event.type] ?? EVENT_TYPE_TAG.custom;
      push(1, mapping.tag, mapping.labelAsValue && event.label ? event.label : "");
      const typeLabel = mapping.labelAsValue ? null : (event.label || mapping.defaultLabel || null);
      if (typeLabel) push(2, "TYPE", typeLabel);
      if (event.date && event.end_date) {
        push(2, "DATE", `FROM ${isoToGedcomDate(event.date)} TO ${isoToGedcomDate(event.end_date)}`);
      } else if (event.date) {
        push(2, "DATE", isoToGedcomDate(event.date));
      }
      if (event.place) push(2, "PLAC", event.place);
      if (event.note) push(2, "NOTE", event.note);
      for (const citation of eventCites(event.id)) pushCitation(2, citation);
    }
    for (const link of childLinks.filter((l) => l.child_id === person.id)) {
      push(1, "FAMC", unionXref.get(link.union_id)!);
      if (link.relation === "adopted" || link.relation === "foster") push(2, "PEDI", link.relation);
      else if (link.relation === "step") push(2, "_REL", "step");
    }
    for (const union of unions) {
      if (union.person1_id === person.id || union.person2_id === person.id) {
        push(1, "FAMS", unionXref.get(union.id)!);
      }
    }
  }

  for (const union of unions) {
    lines.push(`0 ${unionXref.get(union.id)} FAM`);
    // HUSB/WIFE by gender where it disambiguates; otherwise partner order.
    let husb: string | null = union.person1_id;
    let wife = union.person2_id;
    const g1 = genderById.get(union.person1_id);
    const g2 = union.person2_id ? genderById.get(union.person2_id) : undefined;
    if ((g1 === "female" && g2 !== "female") || (g2 === "male" && g1 !== "male")) {
      [husb, wife] = [wife ?? null, union.person1_id];
    }
    if (husb) push(1, "HUSB", personXref.get(husb)!);
    if (wife) push(1, "WIFE", personXref.get(wife)!);
    const marriageCites = unionCites(union.id, "marriage");
    if (union.married_date || union.married_place || marriageCites.length > 0
      || ["married", "divorced", "widowed"].includes(union.status)) {
      push(1, "MARR");
      if (union.married_date) push(2, "DATE", isoToGedcomDate(union.married_date));
      if (union.married_place) push(2, "PLAC", union.married_place);
      for (const citation of marriageCites) pushCitation(2, citation);
    }
    const divorceCites = unionCites(union.id, "divorce");
    if (union.divorced_date || union.status === "divorced" || divorceCites.length > 0) {
      push(1, "DIV");
      if (union.divorced_date) push(2, "DATE", isoToGedcomDate(union.divorced_date));
      for (const citation of divorceCites) pushCitation(2, citation);
    }
    for (const citation of unionCites(union.id, null)) pushCitation(1, citation);
    // MARR/DIV don't encode these two; the custom tag round-trips them.
    if (union.status === "partners" || union.status === "widowed") push(1, "_STATUS", union.status);
    const children = childLinks
      .filter((l) => l.union_id === union.id)
      .sort((a, b) => (birthById.get(a.child_id) ?? "9999").localeCompare(birthById.get(b.child_id) ?? "9999"));
    for (const link of children) push(1, "CHIL", personXref.get(link.child_id)!);
    if (union.note) push(1, "NOTE", union.note);
  }

  for (const source of sources) {
    lines.push(`0 ${sourceXref.get(source.id)} SOUR`);
    push(1, "TITL", source.title);
    if (source.author) push(1, "AUTH", source.author);
    if (source.publisher) push(1, "PUBL", source.publisher);
    // WWW under a SOUR record is a mild 5.5.1 extension; common readers (and
    // our importer) accept it.
    if (source.url) push(1, "WWW", source.url);
    if (source.note) push(1, "NOTE", source.note);
  }

  lines.push("0 TRLR");
  return lines.join("\r\n") + "\r\n";
}
