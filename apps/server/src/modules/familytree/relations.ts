// Union (spouse/partner) and child-link mutations. A union is the only edge
// children hang off (person2 NULL = single parent), so the graph stays uniform
// and GEDCOM-shaped. The guards here keep it a tree in v1: at most one
// parent-union per child, and no cycles.
import { nanoid } from "nanoid";
import { db } from "../../db.js";
import { isAncestorOf, mapUnion, type FamilyUnionSummary } from "./persons.js";

export const UNION_STATUSES = ["married", "partners", "divorced", "widowed", "unknown"] as const;
export const CHILD_RELATIONS = ["biological", "adopted", "step", "foster", "unknown"] as const;

export type RelationError =
  | "person_not_found"
  | "union_not_found"
  | "same_person"
  | "child_is_partner"
  | "child_has_parents"
  | "would_create_cycle";

interface UnionRow {
  id: string;
  person1_id: string;
  person2_id: string | null;
  status: string;
  married_date: string | null;
  divorced_date: string | null;
  note: string | null;
}

function getUnionRow(unionId: string): UnionRow | null {
  const row = db.prepare(
    "SELECT id, person1_id, person2_id, status, married_date, divorced_date, note FROM family_tree_unions WHERE id = ?"
  ).get(unionId) as UnionRow | undefined;
  return row ?? null;
}

export function getUnion(unionId: string): FamilyUnionSummary | null {
  const row = getUnionRow(unionId);
  return row ? mapUnion(row) : null;
}

function personExists(personId: string): boolean {
  return db.prepare("SELECT 1 FROM family_tree_persons WHERE id = ?").get(personId) != null;
}

export interface UnionFields {
  status?: string;
  marriedDate?: string | null;
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
  const id = nanoid(16);
  db.prepare(`
    INSERT INTO family_tree_unions (id, person1_id, person2_id, status, married_date, divorced_date, note)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, person1Id, person2Id, fields.status ?? "unknown",
    fields.marriedDate || null, fields.divorcedDate || null, fields.note?.trim() || null
  );
  return { union: getUnion(id)! };
}

export function updateUnion(unionId: string, fields: UnionFields): FamilyUnionSummary | null {
  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (column: string, value: unknown) => { sets.push(`${column} = ?`); params.push(value); };
  if (fields.status !== undefined) set("status", fields.status);
  if (fields.marriedDate !== undefined) set("married_date", fields.marriedDate || null);
  if (fields.divorcedDate !== undefined) set("divorced_date", fields.divorcedDate || null);
  if (fields.note !== undefined) set("note", fields.note?.trim() || null);
  if (sets.length === 0) return getUnion(unionId);
  sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
  const res = db.prepare(`UPDATE family_tree_unions SET ${sets.join(", ")} WHERE id = ?`).run(...params, unionId);
  return res.changes > 0 ? getUnion(unionId) : null;
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
