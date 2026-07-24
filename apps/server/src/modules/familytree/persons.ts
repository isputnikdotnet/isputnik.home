// Family-tree person model. A third, independent "person" concept: `people` are
// book contributors, `gallery_people` are face clusters — family_tree_persons are
// family members. gallery_person_id bridges a member to their face cluster so
// tagged photos surface on the profile (see photos.ts).
//
// Everyone signed in can view the tree; only admins mutate it (enforced at the
// route layer), so reads here return full rows without per-user filtering. The
// exception is photo listings, which are always scoped to accessible libraries.
import { nanoid } from "nanoid";
import { z } from "zod";
import { db } from "../../db.js";

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

export interface FamilyPersonSummary {
  id: string;
  name: string;
  maidenName: string | null;
  gender: string;
  birthDate: string | null;
  deathDate: string | null;
  birthplace: string | null;
  bio: string | null;
  portraitUrl: string | null;
  portraitItemId: string | null;
  galleryPersonId: string | null;
}

interface PersonRow {
  id: string;
  name: string;
  maiden_name: string | null;
  gender: string;
  birth_date: string | null;
  death_date: string | null;
  birthplace: string | null;
  bio: string | null;
  portrait_storage_key: string | null;
  portrait_item_id: string | null;
  gallery_person_id: string | null;
  updated_at: string;
  portrait_item_cover: string | null;
  portrait_item_updated: string | null;
}

// The portrait is an uploaded file in the thumbnail store, or a chosen gallery
// item's cover. Both go through the shared covers route; ?v= busts the browser
// cache when the underlying image is replaced or the photo is edited/rotated.
const PERSON_SELECT = `
  SELECT p.id, p.name, p.maiden_name, p.gender, p.birth_date, p.death_date,
    p.birthplace, p.bio, p.portrait_storage_key, p.portrait_item_id,
    p.gallery_person_id, p.updated_at,
    im.cover_storage_key AS portrait_item_cover,
    gd.updated_at AS portrait_item_updated
  FROM family_tree_persons p
  LEFT JOIN library_items li ON li.id = p.portrait_item_id AND li.deleted_at IS NULL
  LEFT JOIN item_metadata im ON im.item_id = li.id
  LEFT JOIN gallery_details gd ON gd.item_id = li.id`;

function mapPerson(row: PersonRow): FamilyPersonSummary {
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
    gender: row.gender,
    birthDate: row.birth_date,
    deathDate: row.death_date,
    birthplace: row.birthplace,
    bio: row.bio,
    portraitUrl,
    portraitItemId: row.portrait_item_id,
    galleryPersonId: row.gallery_person_id
  };
}

export function getFamilyPerson(personId: string): FamilyPersonSummary | null {
  const row = db.prepare(`${PERSON_SELECT} WHERE p.id = ?`).get(personId) as PersonRow | undefined;
  return row ? mapPerson(row) : null;
}

export function listFamilyPersons(query?: string): FamilyPersonSummary[] {
  const rows = (query
    ? db.prepare(`${PERSON_SELECT}
        WHERE p.name LIKE ? COLLATE NOCASE OR p.maiden_name LIKE ? COLLATE NOCASE
        ORDER BY p.name COLLATE NOCASE`).all(`%${query}%`, `%${query}%`)
    : db.prepare(`${PERSON_SELECT} ORDER BY p.name COLLATE NOCASE`).all()) as PersonRow[];
  return rows.map(mapPerson);
}

export interface FamilyUnionSummary {
  id: string;
  person1Id: string;
  person2Id: string | null;
  status: string;
  marriedDate: string | null;
  divorcedDate: string | null;
  note: string | null;
}

export interface FamilyChildLink {
  unionId: string;
  childId: string;
  relation: string;
}

interface UnionRow {
  id: string;
  person1_id: string;
  person2_id: string | null;
  status: string;
  married_date: string | null;
  divorced_date: string | null;
  note: string | null;
}

export function mapUnion(row: UnionRow): FamilyUnionSummary {
  return {
    id: row.id,
    person1Id: row.person1_id,
    person2Id: row.person2_id,
    status: row.status,
    marriedDate: row.married_date,
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
    "SELECT id, person1_id, person2_id, status, married_date, divorced_date, note FROM family_tree_unions ORDER BY married_date IS NULL, married_date"
  ).all() as UnionRow[]).map(mapUnion);
  const children = (db.prepare(
    "SELECT union_id, child_id, relation FROM family_tree_children"
  ).all() as { union_id: string; child_id: string; relation: string }[])
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
  bio?: string | null;
}

export function createFamilyPerson(fields: FamilyPersonFields, createdBy: string): FamilyPersonSummary {
  const id = nanoid(16);
  db.prepare(`
    INSERT INTO family_tree_persons (id, name, maiden_name, gender, birth_date, death_date, birthplace, bio, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, fields.name.trim(), fields.maidenName?.trim() || null, fields.gender ?? "unknown",
    fields.birthDate || null, fields.deathDate || null,
    fields.birthplace?.trim() || null, fields.bio?.trim() || null, createdBy
  );
  return getFamilyPerson(id)!;
}

// Patch-style update: only the provided keys change. galleryPersonId / portraitItemId
// accept null to unlink. Choosing a gallery portrait clears any uploaded portrait
// file key (the caller removes the file); the two sources are mutually exclusive.
export function updateFamilyPerson(
  personId: string,
  fields: Partial<FamilyPersonFields> & { galleryPersonId?: string | null; portraitItemId?: string | null }
): FamilyPersonSummary | null {
  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (column: string, value: unknown) => { sets.push(`${column} = ?`); params.push(value); };

  if (fields.name !== undefined) set("name", fields.name.trim());
  if (fields.maidenName !== undefined) set("maiden_name", fields.maidenName?.trim() || null);
  if (fields.gender !== undefined) set("gender", fields.gender);
  if (fields.birthDate !== undefined) set("birth_date", fields.birthDate || null);
  if (fields.deathDate !== undefined) set("death_date", fields.deathDate || null);
  if (fields.birthplace !== undefined) set("birthplace", fields.birthplace?.trim() || null);
  if (fields.bio !== undefined) set("bio", fields.bio?.trim() || null);
  if (fields.galleryPersonId !== undefined) set("gallery_person_id", fields.galleryPersonId);
  if (fields.portraitItemId !== undefined) {
    set("portrait_item_id", fields.portraitItemId);
    if (fields.portraitItemId) set("portrait_storage_key", null);
  }
  if (sets.length === 0) return getFamilyPerson(personId);

  sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
  const res = db.prepare(`UPDATE family_tree_persons SET ${sets.join(", ")} WHERE id = ?`).run(...params, personId);
  return res.changes > 0 ? getFamilyPerson(personId) : null;
}

export function getPortraitStorageKey(personId: string): string | null {
  const row = db.prepare("SELECT portrait_storage_key FROM family_tree_persons WHERE id = ?")
    .get(personId) as { portrait_storage_key: string | null } | undefined;
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
    ).all(personId, personId) as { id: string; person1_id: string; person2_id: string | null }[];
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
    const rows = parentsOf.all(current) as { person1_id: string; person2_id: string | null }[];
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
    divorcedDate: string | null;
    note: string | null;
    partner: FamilyPersonSummary | null;
    children: (FamilyPersonSummary & { relation: string })[];
  }[];
  galleryPerson: { id: string; name: string } | null;
}

export function getFamilyPersonProfile(personId: string): FamilyPersonProfile | null {
  const person = getFamilyPerson(personId);
  if (!person) return null;

  const parentLink = db.prepare(`
    SELECT u.person1_id, u.person2_id, c.relation FROM family_tree_children c
    JOIN family_tree_unions u ON u.id = c.union_id
    WHERE c.child_id = ?
  `).get(personId) as { person1_id: string; person2_id: string | null; relation: string } | undefined;
  const parents = parentLink
    ? [parentLink.person1_id, parentLink.person2_id]
        .filter((id): id is string => id != null)
        .map((id) => getFamilyPerson(id))
        .filter((p): p is FamilyPersonSummary => p != null)
    : [];

  const unionRows = db.prepare(`
    SELECT id, person1_id, person2_id, status, married_date, divorced_date, note
    FROM family_tree_unions WHERE person1_id = ? OR person2_id = ?
    ORDER BY married_date IS NULL, married_date
  `).all(personId, personId) as UnionRow[];
  const childrenOf = db.prepare(`
    SELECT child_id, relation FROM family_tree_children WHERE union_id = ?
  `);
  const unions = unionRows.map((row) => {
    const partnerId = row.person1_id === personId ? row.person2_id : row.person1_id;
    const children = (childrenOf.all(row.id) as { child_id: string; relation: string }[])
      .map((c) => {
        const child = getFamilyPerson(c.child_id);
        return child ? { ...child, relation: c.relation } : null;
      })
      .filter((c): c is FamilyPersonSummary & { relation: string } => c != null)
      .sort((a, b) => (a.birthDate ?? "9999").localeCompare(b.birthDate ?? "9999"));
    return {
      id: row.id,
      status: row.status,
      marriedDate: row.married_date,
      divorcedDate: row.divorced_date,
      note: row.note,
      partner: partnerId ? getFamilyPerson(partnerId) : null,
      children
    };
  });

  const galleryPerson = person.galleryPersonId
    ? (db.prepare("SELECT id, name FROM gallery_people WHERE id = ?")
        .get(person.galleryPersonId) as { id: string; name: string } | undefined) ?? null
    : null;

  return { ...person, parents, parentRelation: parentLink?.relation ?? null, unions, galleryPerson };
}
