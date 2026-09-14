// Family-tree person model. A third, independent "person" concept: `people` are
// book contributors, `gallery_people` are face clusters — family_tree_persons are
// family members. gallery_person_id bridges a member to their face cluster so
// tagged photos surface on the profile (see photos.ts).
//
// Everyone signed in can view the tree; mutations are admin- or tag-scoped
// (enforced at the route layer via access.ts), so reads here return full rows
// without per-user filtering. The exception is photo listings, which are always
// scoped to accessible libraries.
import { nanoid } from "nanoid";
import { z } from "zod";
import { db } from "../../db.js";
import { addEntityTags, normalizeText, setEntityTags } from "../library/shared/tagging.js";
import { FAMILY_PERSON_ENTITY_TYPE } from "./access.js";
import { listFamilyEvents, type FamilyEventSummary } from "./events.js";
import { listPersonCitations, type FamilyCitationSummary } from "./sources.js";
import type { FamilyTreeChildRow, FamilyTreePersonNameRow, FamilyTreePersonRow, FamilyTreeUnionRow, GalleryDetailRow, GalleryPersonRow, ItemMetadataRow, TagRow } from "../../db/rows.js";

// Partial ISO dates: 'YYYY' | 'YYYY-MM' | 'YYYY-MM-DD'. Lexicographic order is
// chronological, and GEDCOM's partial dates map onto this 1:1 for a later import.
// The regex admits impossible month/day numbers, so a real calendar check follows.
export const partialDateSchema = z.string().trim()
  .regex(/^\d{4}(-\d{2}(-\d{2})?)?$/, "Use YYYY, YYYY-MM, or YYYY-MM-DD")
  .refine((value) => {
    const [year, month, day] = value.split("-").map(Number);
    if (month != null && (month < 1 || month > 12)) return false;
    if (day != null) {
      const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
      if (day < 1 || day > daysInMonth) return false;
    }
    return true;
  }, "Not a real calendar date");

export const GENDERS = ["male", "female", "other", "unknown"] as const;

/** The person's name as written in another language. */
export interface FamilyPersonName {
  language: string;
  name: string;
}

export interface PlacePin {
  lat: number;
  lng: number;
}

export interface FamilyPersonSummary {
  id: string;
  name: string;
  maidenName: string | null;
  otherNames: FamilyPersonName[];
  gender: string;
  birthDate: string | null;
  deathDate: string | null;
  birthplace: string | null;
  deathPlace: string | null;
  birthPin: PlacePin | null;
  deathPin: PlacePin | null;
  bio: string | null;
  portraitUrl: string | null;
  portraitItemId: string | null;
  galleryPersonId: string | null;
}

type PersonRow = Pick<FamilyTreePersonRow,
  "id" | "name" | "maiden_name" | "gender" | "birth_date" | "death_date" | "birthplace" | "death_place"
  | "birth_lat" | "birth_lng" | "death_lat" | "death_lng" | "bio"
  | "portrait_storage_key" | "portrait_item_id" | "gallery_person_id" | "updated_at"> & {
  portrait_item_cover: ItemMetadataRow["cover_storage_key"] | null;
  portrait_item_updated: GalleryDetailRow["updated_at"] | null;
};

// The portrait is an uploaded file in the thumbnail store, or a chosen gallery
// item's cover. Both go through the shared covers route; ?v= busts the browser
// cache when the underlying image is replaced or the photo is edited/rotated.
const PERSON_SELECT = `
  SELECT p.id, p.name, p.maiden_name, p.gender, p.birth_date, p.death_date,
    p.birthplace, p.death_place, p.birth_lat, p.birth_lng, p.death_lat, p.death_lng,
    p.bio, p.portrait_storage_key, p.portrait_item_id,
    p.gallery_person_id, p.updated_at,
    im.cover_storage_key AS portrait_item_cover,
    gd.updated_at AS portrait_item_updated
  FROM family_tree_persons p
  LEFT JOIN library_items li ON li.id = p.portrait_item_id AND li.deleted_at IS NULL
  LEFT JOIN item_metadata im ON im.item_id = li.id
  LEFT JOIN gallery_details gd ON gd.item_id = li.id`;

function pin(lat: number | null, lng: number | null): PlacePin | null {
  return lat != null && lng != null ? { lat, lng } : null;
}

/** Other-language names for the given people (every person when omitted), in
 *  the order they were entered. One query for a whole list. */
function otherNamesOf(personIds?: string[]): Map<string, FamilyPersonName[]> {
  const rows = (personIds
    ? personIds.length === 0
      ? []
      : db.prepare(`SELECT person_id, language, name FROM family_tree_person_names
          WHERE person_id IN (${personIds.map(() => "?").join(", ")}) ORDER BY person_id, position`).all(...personIds)
    : db.prepare("SELECT person_id, language, name FROM family_tree_person_names ORDER BY person_id, position").all()
  ) as Pick<FamilyTreePersonNameRow, "person_id" | "language" | "name">[];
  const byPerson = new Map<string, FamilyPersonName[]>();
  for (const row of rows) {
    const list = byPerson.get(row.person_id) ?? [];
    list.push({ language: row.language, name: row.name });
    byPerson.set(row.person_id, list);
  }
  return byPerson;
}

function mapPersons(rows: PersonRow[], allPeople = false): FamilyPersonSummary[] {
  const names = otherNamesOf(allPeople ? undefined : rows.map((row) => row.id));
  return rows.map((row) => mapPerson(row, names.get(row.id) ?? []));
}

function mapPerson(row: PersonRow, otherNames: FamilyPersonName[]): FamilyPersonSummary {
  let portraitUrl: string | null = null;
  if (row.portrait_storage_key) {
    portraitUrl = `/api/library/covers/${row.portrait_storage_key}?v=${encodeURIComponent(row.updated_at)}`;
  } else if (row.portrait_item_cover) {
    const v = row.portrait_item_updated ? `?v=${encodeURIComponent(row.portrait_item_updated)}` : "";
    portraitUrl = `/api/library/covers/${row.portrait_item_cover}${v}`;
  }
  return {
    id: row.id,
    name: row.name,
    maidenName: row.maiden_name,
    otherNames,
    gender: row.gender,
    birthDate: row.birth_date,
    deathDate: row.death_date,
    birthplace: row.birthplace,
    deathPlace: row.death_place,
    birthPin: pin(row.birth_lat, row.birth_lng),
    deathPin: pin(row.death_lat, row.death_lng),
    bio: row.bio,
    portraitUrl,
    portraitItemId: row.portrait_item_id,
    galleryPersonId: row.gallery_person_id
  };
}

export function getFamilyPerson(personId: string): FamilyPersonSummary | null {
  const row = db.prepare(`${PERSON_SELECT} WHERE p.id = ?`).get(personId) as PersonRow | undefined;
  return row ? mapPersons([row])[0] : null;
}

// A name in another language is found like the main name. SQLite's NOCASE folds
// ASCII only, so a Cyrillic search is case-sensitive here; the pages filter the
// loaded list themselves, with full case folding.
export function listFamilyPersons(query?: string): FamilyPersonSummary[] {
  if (!query) {
    return mapPersons(db.prepare(`${PERSON_SELECT} ORDER BY p.name COLLATE NOCASE`).all() as PersonRow[], true);
  }
  const like = `%${query}%`;
  const rows = db.prepare(`${PERSON_SELECT}
    WHERE p.name LIKE ? COLLATE NOCASE OR p.maiden_name LIKE ? COLLATE NOCASE
      OR EXISTS (SELECT 1 FROM family_tree_person_names n WHERE n.person_id = p.id AND n.name LIKE ? COLLATE NOCASE)
    ORDER BY p.name COLLATE NOCASE`).all(like, like, like) as PersonRow[];
  return mapPersons(rows);
}

// Everyone carrying one tag — the family arm of the global tag browse. Reads
// are open to every signed-in user, like the rest of the tree.
export function listFamilyPersonsByTag(tagId: string): FamilyPersonSummary[] {
  const rows = db.prepare(`${PERSON_SELECT}
    JOIN taggables ON taggables.entity_id = p.id
      AND taggables.entity_type = '${FAMILY_PERSON_ENTITY_TYPE}' AND taggables.tag_id = ?
    ORDER BY p.name COLLATE NOCASE`).all(tagId) as PersonRow[];
  return mapPersons(rows);
}

export interface FamilyPlace {
  label: string;
  pin: PlacePin | null;
  uses: number;
}

// Every place the tree already names — births, deaths, marriages, life events —
// so the editor can offer "Minsk, Belarus" the way it was written last time,
// with its pin when one was picked. Most used first.
export function listFamilyPlaces(): FamilyPlace[] {
  // The lone MAX() makes SQLite take lat/lng from the row it picked, so a label
  // spelled with a pin anywhere carries that one pin, never halves of two.
  const rows = db.prepare(`
    SELECT label, MAX(lat IS NOT NULL AND lng IS NOT NULL) AS pinned, lat, lng, COUNT(*) AS uses FROM (
      SELECT birthplace AS label, birth_lat AS lat, birth_lng AS lng FROM family_tree_persons WHERE birthplace IS NOT NULL
      UNION ALL SELECT death_place, death_lat, death_lng FROM family_tree_persons WHERE death_place IS NOT NULL
      UNION ALL SELECT married_place, NULL, NULL FROM family_tree_unions WHERE married_place IS NOT NULL
      UNION ALL SELECT place, NULL, NULL FROM family_tree_events WHERE place IS NOT NULL
    )
    WHERE TRIM(label) <> ''
    GROUP BY label
    ORDER BY uses DESC, label COLLATE NOCASE
  `).all() as { label: string; lat: number | null; lng: number | null; uses: number }[];
  return rows.map((row) => ({ label: row.label, pin: pin(row.lat, row.lng), uses: row.uses }));
}

export interface FamilyUnionSummary {
  id: string;
  person1Id: string;
  person2Id: string | null;
  status: string;
  marriedDate: string | null;
  marriedPlace: string | null;
  divorcedDate: string | null;
  note: string | null;
}

export interface FamilyChildLink {
  unionId: string;
  childId: string;
  relation: string;
}

type UnionRow = Pick<FamilyTreeUnionRow,
  "id" | "person1_id" | "person2_id" | "status" | "married_date" | "married_place" | "divorced_date" | "note">;

export function mapUnion(row: UnionRow): FamilyUnionSummary {
  return {
    id: row.id,
    person1Id: row.person1_id,
    person2Id: row.person2_id,
    status: row.status,
    marriedDate: row.married_date,
    marriedPlace: row.married_place,
    divorcedDate: row.divorced_date,
    note: row.note
  };
}

// The whole tree in one payload — a family tree is hundreds of rows at most, and
// the chart needs every edge anyway to lay out ancestors and descendants.
export function getFamilyTree(): {
  persons: FamilyPersonSummary[];
  unions: FamilyUnionSummary[];
  children: FamilyChildLink[];
} {
  const persons = listFamilyPersons();
  const unions = (db.prepare(
    "SELECT id, person1_id, person2_id, status, married_date, married_place, divorced_date, note FROM family_tree_unions ORDER BY married_date IS NULL, married_date"
  ).all() as UnionRow[]).map(mapUnion);
  const children = (db.prepare(
    "SELECT union_id, child_id, relation FROM family_tree_children"
  ).all() as Pick<FamilyTreeChildRow, "union_id" | "child_id" | "relation">[])
    .map((r) => ({ unionId: r.union_id, childId: r.child_id, relation: r.relation }));
  return { persons, unions, children };
}

export interface FamilyPersonFields {
  name: string;
  maidenName?: string | null;
  gender?: string;
  birthDate?: string | null;
  deathDate?: string | null;
  birthplace?: string | null;
  deathPlace?: string | null;
  /** A pin belongs to its place: one sent with no place is dropped. */
  birthPin?: PlacePin | null;
  deathPin?: PlacePin | null;
  otherNames?: FamilyPersonName[];
  bio?: string | null;
}

/** Replaces the person's other-language names; blank rows are dropped. */
function writeOtherNames(personId: string, names: FamilyPersonName[]): void {
  db.prepare("DELETE FROM family_tree_person_names WHERE person_id = ?").run(personId);
  const insert = db.prepare("INSERT INTO family_tree_person_names (person_id, position, language, name) VALUES (?, ?, ?, ?)");
  let position = 0;
  for (const entry of names) {
    const name = entry.name.trim();
    const language = entry.language.trim();
    if (!name || !language) continue;
    insert.run(personId, position++, language, name);
  }
}

// Tags are applied in the same transaction as the insert: for a branch editor
// the tag is the permission anchor, so a person must never exist without it.
export function createFamilyPerson(fields: FamilyPersonFields, createdBy: string, tags?: string[]): FamilyPersonSummary {
  const id = nanoid(16);
  const birthplace = fields.birthplace?.trim() || null;
  const deathPlace = fields.deathPlace?.trim() || null;
  const birthPin = birthplace ? fields.birthPin ?? null : null;
  const deathPin = deathPlace ? fields.deathPin ?? null : null;
  db.transaction(() => {
    db.prepare(`
      INSERT INTO family_tree_persons (id, name, maiden_name, gender, birth_date, death_date, birthplace, death_place,
        birth_lat, birth_lng, death_lat, death_lng, bio, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, fields.name.trim(), fields.maidenName?.trim() || null, fields.gender ?? "unknown",
      fields.birthDate || null, fields.deathDate || null,
      birthplace, deathPlace,
      birthPin?.lat ?? null, birthPin?.lng ?? null, deathPin?.lat ?? null, deathPin?.lng ?? null,
      fields.bio?.trim() || null, createdBy
    );
    if (fields.otherNames) writeOtherNames(id, fields.otherNames);
    if (tags && tags.length > 0) setEntityTags(FAMILY_PERSON_ENTITY_TYPE, id, tags);
  })();
  return getFamilyPerson(id)!;
}

// Patch-style update: only the provided keys change. galleryPersonId / portraitItemId
// accept null to unlink. Choosing a gallery portrait clears any uploaded portrait
// file key (the caller removes the file); the two sources are mutually exclusive.
export function updateFamilyPerson(
  personId: string,
  fields: Partial<FamilyPersonFields> & { galleryPersonId?: string | null; portraitItemId?: string | null; tags?: string[] }
): FamilyPersonSummary | null {
  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (column: string, value: unknown) => { sets.push(`${column} = ?`); params.push(value); };

  if (fields.name !== undefined) set("name", fields.name.trim());
  if (fields.maidenName !== undefined) set("maiden_name", fields.maidenName?.trim() || null);
  if (fields.gender !== undefined) set("gender", fields.gender);
  if (fields.birthDate !== undefined) set("birth_date", fields.birthDate || null);
  if (fields.deathDate !== undefined) set("death_date", fields.deathDate || null);
  // A pin follows its place: sent with it, it is stored (dropped for an empty
  // place); a place changed without one loses the old pin, which named the old
  // words. SET reads the row as it was, so `birthplace IS ?` compares old to new.
  const placeWithPin = (textColumn: string, lat: string, lng: string, text: string | null | undefined, sent: PlacePin | null | undefined) => {
    if (text === undefined && sent === undefined) return;
    if (text !== undefined) set(textColumn, text?.trim() || null);
    const place = text === undefined ? undefined : text?.trim() || null;
    if (sent !== undefined || place === null) {
      const kept = place === null ? null : sent ?? null;
      set(lat, kept?.lat ?? null);
      set(lng, kept?.lng ?? null);
    } else if (place !== undefined) {
      sets.push(`${lat} = CASE WHEN ${textColumn} IS ? THEN ${lat} END`, `${lng} = CASE WHEN ${textColumn} IS ? THEN ${lng} END`);
      params.push(place, place);
    }
  };
  placeWithPin("birthplace", "birth_lat", "birth_lng", fields.birthplace, fields.birthPin);
  placeWithPin("death_place", "death_lat", "death_lng", fields.deathPlace, fields.deathPin);
  if (fields.bio !== undefined) set("bio", fields.bio?.trim() || null);
  if (fields.galleryPersonId !== undefined) set("gallery_person_id", fields.galleryPersonId);
  if (fields.portraitItemId !== undefined) {
    set("portrait_item_id", fields.portraitItemId);
    if (fields.portraitItemId) set("portrait_storage_key", null);
  }
  // Tags and other names live in their own tables, not columns — they apply even
  // when no column changed.
  if (sets.length === 0 && fields.tags === undefined && fields.otherNames === undefined) return getFamilyPerson(personId);

  return db.transaction(() => {
    if (!db.prepare("SELECT 1 FROM family_tree_persons WHERE id = ?").get(personId)) return null;
    if (fields.tags !== undefined) setEntityTags(FAMILY_PERSON_ENTITY_TYPE, personId, fields.tags);
    if (fields.otherNames !== undefined) writeOtherNames(personId, fields.otherNames);
    if (sets.length > 0 || fields.otherNames !== undefined) {
      sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
      db.prepare(`UPDATE family_tree_persons SET ${sets.join(", ")} WHERE id = ?`).run(...params, personId);
    }
    return getFamilyPerson(personId);
  })();
}

export function getPortraitStorageKey(personId: string): string | null {
  const row = db.prepare("SELECT portrait_storage_key FROM family_tree_persons WHERE id = ?")
    .get(personId) as Pick<FamilyTreePersonRow, "portrait_storage_key"> | undefined;
  return row?.portrait_storage_key ?? null;
}

export function setUploadedPortrait(personId: string, storageKey: string | null): void {
  db.prepare(`
    UPDATE family_tree_persons
    SET portrait_storage_key = ?, portrait_item_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ?
  `).run(storageKey, null, personId);
}

// Deleting a person must not orphan the other partner's children: each union the
// person was in survives as a single-parent union when a partner remains (the
// survivor is promoted into person1 so the NOT NULL slot stays valid). A union
// with no surviving partner is deleted, cascading its child links; child persons
// themselves are never touched. Returns the uploaded-portrait key (if any) so the
// route can remove the file after the transaction commits.
export function deleteFamilyPerson(personId: string): { deleted: boolean; portraitKey: string | null } {
  const portraitKey = getPortraitStorageKey(personId);
  const deleted = db.transaction(() => {
    const unions = db.prepare(
      "SELECT id, person1_id, person2_id FROM family_tree_unions WHERE person1_id = ? OR person2_id = ?"
    ).all(personId, personId) as Pick<FamilyTreeUnionRow, "id" | "person1_id" | "person2_id">[];
    for (const union of unions) {
      const survivor = union.person1_id === personId ? union.person2_id : union.person1_id;
      if (survivor) {
        db.prepare(`
          UPDATE family_tree_unions
          SET person1_id = ?, person2_id = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ?
        `).run(survivor, union.id);
      } else {
        db.prepare("DELETE FROM family_tree_unions WHERE id = ?").run(union.id);
      }
    }
    // taggables has no FK on entity_id, so the person's tag links need explicit cleanup.
    db.prepare(`DELETE FROM taggables WHERE entity_type = '${FAMILY_PERSON_ENTITY_TYPE}' AND entity_id = ?`).run(personId);
    return db.prepare("DELETE FROM family_tree_persons WHERE id = ?").run(personId).changes > 0;
  })();
  return { deleted, portraitKey: deleted ? portraitKey : null };
}

// Is `ancestorId` an ancestor of `personId`? Walks parent unions upward with a
// visited set (defensive — the add-child guard should keep the graph acyclic).
// Used to reject a child link that would make someone their own ancestor.
export function isAncestorOf(ancestorId: string, personId: string): boolean {
  const parentsOf = db.prepare(`
    SELECT u.person1_id, u.person2_id FROM family_tree_children c
    JOIN family_tree_unions u ON u.id = c.union_id
    WHERE c.child_id = ?
  `);
  const visited = new Set<string>();
  const queue = [personId];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    const rows = parentsOf.all(current) as Pick<FamilyTreeUnionRow, "person1_id" | "person2_id">[];
    for (const row of rows) {
      for (const parent of [row.person1_id, row.person2_id]) {
        if (!parent) continue;
        if (parent === ancestorId) return true;
        queue.push(parent);
      }
    }
  }
  return false;
}

export interface FamilyPersonProfile extends FamilyPersonSummary {
  // The person's own parents (partners of their parent-union), and each union
  // they are a partner in, with the other partner and the children spelled out
  // as summaries so the profile page renders without extra requests.
  parents: FamilyPersonSummary[];
  parentRelation: string | null;
  unions: {
    id: string;
    status: string;
    marriedDate: string | null;
    marriedPlace: string | null;
    divorcedDate: string | null;
    note: string | null;
    partner: FamilyPersonSummary | null;
    children: (FamilyPersonSummary & { relation: string })[];
  }[];
  events: FamilyEventSummary[];
  citations: FamilyCitationSummary[];
  galleryPerson: { id: string; name: string } | null;
}

export function getFamilyPersonProfile(personId: string): FamilyPersonProfile | null {
  const person = getFamilyPerson(personId);
  if (!person) return null;

  const parentLink = db.prepare(`
    SELECT u.person1_id, u.person2_id, c.relation FROM family_tree_children c
    JOIN family_tree_unions u ON u.id = c.union_id
    WHERE c.child_id = ?
  `).get(personId) as (Pick<FamilyTreeUnionRow, "person1_id" | "person2_id"> & Pick<FamilyTreeChildRow, "relation">) | undefined;
  const parents = parentLink
    ? [parentLink.person1_id, parentLink.person2_id]
        .filter((id): id is string => id != null)
        .map((id) => getFamilyPerson(id))
        .filter((p): p is FamilyPersonSummary => p != null)
    : [];

  const unionRows = db.prepare(`
    SELECT id, person1_id, person2_id, status, married_date, married_place, divorced_date, note
    FROM family_tree_unions WHERE person1_id = ? OR person2_id = ?
    ORDER BY married_date IS NULL, married_date
  `).all(personId, personId) as UnionRow[];
  const childrenOf = db.prepare(`
    SELECT child_id, relation FROM family_tree_children WHERE union_id = ?
  `);
  const unions = unionRows.map((row) => {
    const partnerId = row.person1_id === personId ? row.person2_id : row.person1_id;
    const children = (childrenOf.all(row.id) as Pick<FamilyTreeChildRow, "child_id" | "relation">[])
      .map((c) => {
        const child = getFamilyPerson(c.child_id);
        return child ? { ...child, relation: c.relation } : null;
      })
      .filter((c): c is FamilyPersonSummary & { relation: FamilyTreeChildRow["relation"] } => c != null)
      .sort((a, b) => (a.birthDate ?? "9999").localeCompare(b.birthDate ?? "9999"));
    return {
      id: row.id,
      status: row.status,
      marriedDate: row.married_date,
      marriedPlace: row.married_place,
      divorcedDate: row.divorced_date,
      note: row.note,
      partner: partnerId ? getFamilyPerson(partnerId) : null,
      children
    };
  });

  const galleryPerson = person.galleryPersonId
    ? (db.prepare("SELECT id, name FROM gallery_people WHERE id = ?")
        .get(person.galleryPersonId) as Pick<GalleryPersonRow, "id" | "name"> | undefined) ?? null
    : null;

  return {
    ...person,
    parents,
    parentRelation: parentLink?.relation ?? null,
    unions,
    events: listFamilyEvents(personId),
    citations: listPersonCitations(personId),
    galleryPerson
  };
}

// Everyone reachable from `seedIds` through the relationship graph — partners,
// children, parents and, transitively, their relatives. "The whole family" is a
// graph question, not a surname one: spouses keep their own names and
// married-in relatives share none, so a surname sweep both misses and
// over-reaches. Loads both edge tables once (the tree is hundreds of rows) and
// walks them breadth-first. Seeds are included; unknown ids drop out.
export function expandToRelatives(seedIds: string[]): string[] {
  const unions = db.prepare(
    "SELECT id, person1_id, person2_id FROM family_tree_unions"
  ).all() as Pick<FamilyTreeUnionRow, "id" | "person1_id" | "person2_id">[];
  const children = db.prepare(
    "SELECT union_id, child_id FROM family_tree_children"
  ).all() as Pick<FamilyTreeChildRow, "union_id" | "child_id">[];

  // Union id -> everyone standing in it (partners + children). Every member of
  // a union is a relative of every other, which makes the walk a single hop.
  const membersOfUnion = new Map<string, string[]>();
  const unionsOfPerson = new Map<string, string[]>();
  const join = (unionId: string, personId: string) => {
    const members = membersOfUnion.get(unionId) ?? [];
    members.push(personId);
    membersOfUnion.set(unionId, members);
    const ids = unionsOfPerson.get(personId) ?? [];
    ids.push(unionId);
    unionsOfPerson.set(personId, ids);
  };
  for (const union of unions) {
    join(union.id, union.person1_id);
    if (union.person2_id) join(union.id, union.person2_id);
  }
  for (const child of children) join(child.union_id, child.child_id);

  const known = new Set(
    (db.prepare("SELECT id FROM family_tree_persons").all() as Pick<FamilyTreePersonRow, "id">[]).map((row) => row.id)
  );
  const found = new Set<string>();
  const queue = seedIds.filter((id) => known.has(id));
  for (const id of queue) found.add(id);
  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const unionId of unionsOfPerson.get(current) ?? []) {
      for (const member of membersOfUnion.get(unionId) ?? []) {
        if (found.has(member)) continue;
        found.add(member);
        queue.push(member);
      }
    }
  }
  return [...found];
}

// Add and/or remove family tags across many people in one transaction. Adding
// is additive — a person can carry several branch tags — so this never
// replaces a tag set the way updateFamilyPerson's `tags` field does.
export function applyFamilyPersonTags(personIds: string[], add: string[], remove: string[]): void {
  const removeKeys = [...new Set(remove.map(normalizeText).filter(Boolean))];
  const removeIds = removeKeys.length > 0
    ? (db.prepare(
        `SELECT id FROM tags WHERE key IN (${removeKeys.map(() => "?").join(", ")})`
      ).all(...removeKeys) as Pick<TagRow, "id">[]).map((row) => row.id)
    : [];
  const deleteTags = removeIds.length > 0
    ? db.prepare(
        `DELETE FROM taggables WHERE entity_type = ? AND entity_id = ?
           AND tag_id IN (${removeIds.map(() => "?").join(", ")})`
      )
    : null;

  db.transaction(() => {
    for (const personId of personIds) {
      if (add.length > 0) addEntityTags(FAMILY_PERSON_ENTITY_TYPE, personId, add);
      deleteTags?.run(FAMILY_PERSON_ENTITY_TYPE, personId, ...removeIds);
    }
  })();
}
