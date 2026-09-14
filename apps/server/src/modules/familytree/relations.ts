// Union (spouse/partner) and child-link mutations. A union is the only edge
// children hang off (person2 NULL = single parent), so the graph stays uniform
// and GEDCOM-shaped. The guards here keep it a tree in v1: at most one
// parent-union per child, and no cycles.
import { nanoid } from "nanoid";
import { db } from "../../db.js";
import { isAncestorOf, mapUnion, UNION_COLUMNS, type FamilyUnionSummary, type UnionRow } from "./persons.js";
import { pinForPlace, placeUpdate, type PlacePin } from "./place-pins.js";
import type { FamilyTreeChildRow } from "../../db/rows.js";

export const UNION_STATUSES = ["married", "partners", "divorced", "widowed", "unknown"] as const;
export const CHILD_RELATIONS = ["biological", "adopted", "step", "foster", "unknown"] as const;

export type RelationError =
  | "person_not_found"
  | "union_not_found"
  | "same_person"
  | "child_is_partner"
  | "child_has_parents"
  | "union_has_partner"
  | "already_partners"
  | "would_create_cycle";

function getUnionRow(unionId: string): UnionRow | null {
  const row = db.prepare(
    `SELECT ${UNION_COLUMNS} FROM family_tree_unions WHERE id = ?`
  ).get(unionId) as UnionRow | undefined;
  return row ?? null;
}

export function getUnion(unionId: string): FamilyUnionSummary | null {
  const row = getUnionRow(unionId);
  return row ? mapUnion(row) : null;
}

/** Another union between these two people, oldest first — a couple is recorded once. */
function unionOfPair(personA: string, personB: string, excludeUnionId: string | null = null): string | null {
  const row = db.prepare(`
    SELECT id FROM family_tree_unions
    WHERE ((person1_id = ? AND person2_id = ?) OR (person1_id = ? AND person2_id = ?))
      AND (? IS NULL OR id <> ?)
    ORDER BY created_at, id LIMIT 1
  `).get(personA, personB, personB, personA, excludeUnionId, excludeUnionId) as { id: string } | undefined;
  return row?.id ?? null;
}

/** Fold one union into another of the same couple: its children and citations
 *  move over, facts the keeper lacks are filled from it, and it is deleted. The
 *  keeper's own facts always win. Run inside a transaction. */
export function foldUnionInto(sourceId: string, targetId: string): void {
  // A child already in the keeper keeps that link; the duplicate goes with the source.
  db.prepare("UPDATE OR IGNORE family_tree_children SET union_id = ? WHERE union_id = ?").run(targetId, sourceId);
  db.prepare("UPDATE family_tree_citations SET union_id = ? WHERE union_id = ?").run(targetId, sourceId);
  db.prepare(`
    UPDATE family_tree_unions AS t SET
      status = CASE WHEN t.status = 'unknown' THEN s.status ELSE t.status END,
      married_date = COALESCE(t.married_date, s.married_date),
      married_lat = CASE WHEN t.married_place IS NULL THEN s.married_lat ELSE t.married_lat END,
      married_lng = CASE WHEN t.married_place IS NULL THEN s.married_lng ELSE t.married_lng END,
      married_place = COALESCE(t.married_place, s.married_place),
      divorced_date = COALESCE(t.divorced_date, s.divorced_date),
      note = COALESCE(t.note, s.note),
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM family_tree_unions AS s
    WHERE t.id = ? AND s.id = ?
  `).run(targetId, sourceId);
  db.prepare("DELETE FROM family_tree_unions WHERE id = ?").run(sourceId);
}

function personExists(personId: string): boolean {
  return db.prepare("SELECT 1 FROM family_tree_persons WHERE id = ?").get(personId) != null;
}

export interface UnionFields {
  status?: string;
  marriedDate?: string | null;
  marriedPlace?: string | null;
  /** Follows marriedPlace (see place-pins.ts). */
  marriedPin?: PlacePin | null;
  divorcedDate?: string | null;
  note?: string | null;
}

export function createUnion(
  person1Id: string,
  person2Id: string | null,
  fields: UnionFields
): { union: FamilyUnionSummary } | { error: RelationError } {
  if (person2Id && person1Id === person2Id) return { error: "same_person" };
  if (!personExists(person1Id) || (person2Id && !personExists(person2Id))) {
    return { error: "person_not_found" };
  }
  // Adding the same partner twice made two couples of one, each with half the
  // children; edit the existing relationship instead.
  if (person2Id && unionOfPair(person1Id, person2Id)) return { error: "already_partners" };
  const id = nanoid(16);
  const marriedPin = pinForPlace(fields.marriedPlace, fields.marriedPin);
  db.prepare(`
    INSERT INTO family_tree_unions (id, person1_id, person2_id, status, married_date, married_place, married_lat, married_lng, divorced_date, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, person1Id, person2Id, fields.status ?? "unknown",
    fields.marriedDate || null, fields.marriedPlace?.trim() || null,
    marriedPin?.lat ?? null, marriedPin?.lng ?? null,
    fields.divorcedDate || null, fields.note?.trim() || null
  );
  return { union: getUnion(id)! };
}

export function updateUnion(unionId: string, fields: UnionFields): FamilyUnionSummary | null {
  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (column: string, value: unknown) => { sets.push(`${column} = ?`); params.push(value); };
  if (fields.status !== undefined) set("status", fields.status);
  if (fields.marriedDate !== undefined) set("married_date", fields.marriedDate || null);
  const place = placeUpdate({ text: "married_place", lat: "married_lat", lng: "married_lng" }, fields.marriedPlace, fields.marriedPin);
  sets.push(...place.sets);
  params.push(...place.params);
  if (fields.divorcedDate !== undefined) set("divorced_date", fields.divorcedDate || null);
  if (fields.note !== undefined) set("note", fields.note?.trim() || null);
  if (sets.length === 0) return getUnion(unionId);
  sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
  const res = db.prepare(`UPDATE family_tree_unions SET ${sets.join(", ")} WHERE id = ?`).run(...params, unionId);
  return res.changes > 0 ? getUnion(unionId) : null;
}

// Fill the empty partner slot of a single-parent union — the "add the other
// parent" flow. Only an empty slot can be filled; replacing a partner means
// deleting the union and starting over, which is a deliberate act.
//
// When the new partner is ALREADY recorded as a couple with the first parent,
// this union is folded into that one rather than becoming a second copy of the
// couple — and the union returned is the one that remains. (Adding Peter as
// Anna's father and then Dora as her mother, when Peter and Dora were already
// married, used to show Dora twice on Peter's profile.)
export function setUnionPartner(
  unionId: string,
  partnerId: string
): { union: FamilyUnionSummary } | { error: RelationError } {
  const union = getUnionRow(unionId);
  if (!union) return { error: "union_not_found" };
  if (!personExists(partnerId)) return { error: "person_not_found" };
  if (union.person2_id) return { error: "union_has_partner" };
  if (partnerId === union.person1_id) return { error: "same_person" };
  const children = db.prepare("SELECT child_id FROM family_tree_children WHERE union_id = ?")
    .all(unionId) as Pick<FamilyTreeChildRow, "child_id">[];
  for (const { child_id } of children) {
    if (child_id === partnerId) return { error: "child_is_partner" };
    // The new partner becomes a parent of every child in this union — the same
    // cycle rule addChild enforces, from the other side.
    if (isAncestorOf(child_id, partnerId)) return { error: "would_create_cycle" };
  }
  const existing = unionOfPair(union.person1_id, partnerId, unionId);
  if (existing) {
    db.transaction(() => foldUnionInto(unionId, existing))();
    return { union: getUnion(existing)! };
  }
  db.prepare(
    "UPDATE family_tree_unions SET person2_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
  ).run(partnerId, unionId);
  return { union: getUnion(unionId)! };
}

// Child links cascade away with the union; the child persons are untouched.
export function deleteUnion(unionId: string): boolean {
  return db.prepare("DELETE FROM family_tree_unions WHERE id = ?").run(unionId).changes > 0;
}

// v1 keeps the graph a tree: a child belongs to at most one parent-union
// (reassigning = remove + add), can't be a partner of the union they hang off,
// and can't be an ancestor of either partner (that would close a cycle). The
// schema itself allows multiple parent-unions so a future release — or a GEDCOM
// import — can relax this deliberately.
export function addChild(
  unionId: string,
  childId: string,
  relation: string
): { ok: true } | { error: RelationError } {
  const union = getUnionRow(unionId);
  if (!union) return { error: "union_not_found" };
  if (!personExists(childId)) return { error: "person_not_found" };
  if (childId === union.person1_id || childId === union.person2_id) return { error: "child_is_partner" };
  const existing = db.prepare("SELECT 1 FROM family_tree_children WHERE child_id = ?").get(childId);
  if (existing) return { error: "child_has_parents" };
  for (const parent of [union.person1_id, union.person2_id]) {
    if (parent && (parent === childId || isAncestorOf(childId, parent))) {
      return { error: "would_create_cycle" };
    }
  }
  db.prepare(
    "INSERT INTO family_tree_children (union_id, child_id, relation) VALUES (?, ?, ?)"
  ).run(unionId, childId, relation);
  return { ok: true };
}

export function removeChild(unionId: string, childId: string): boolean {
  return db.prepare(
    "DELETE FROM family_tree_children WHERE union_id = ? AND child_id = ?"
  ).run(unionId, childId).changes > 0;
}
