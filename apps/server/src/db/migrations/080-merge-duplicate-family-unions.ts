import type Database from "better-sqlite3";

// 4.11.1: one couple, one union. Adding someone as a child's second parent when
// they were already that first parent's partner used to make a second union of
// the same two people — the child under one, the marriage facts on the other —
// so the profile showed the partner twice. The flow now joins the existing union;
// this folds the copies already made.
//
// Only copies that cannot disagree are folded: when two unions of the same couple
// carry different facts (two marriage dates, a status each), that may be a real
// divorce and remarriage, and it is left for a person to judge. The oldest union
// is kept; the others' children and citations move to it and fill what it lacks.
// Self-contained SQL rather than relations.ts, so later changes there cannot
// change what this migration did.
export const version = 80;

interface UnionRow {
  id: string;
  status: string;
  married_date: string | null;
  married_place: string | null;
  divorced_date: string | null;
  note: string | null;
}

function disagree(rows: UnionRow[]): boolean {
  const distinct = (values: (string | null)[]) => new Set(values.filter((value) => value != null && value.trim() !== "")).size > 1;
  return distinct(rows.map((row) => (row.status === "unknown" ? null : row.status)))
    || distinct(rows.map((row) => row.married_date))
    || distinct(rows.map((row) => row.married_place))
    || distinct(rows.map((row) => row.divorced_date))
    || distinct(rows.map((row) => row.note));
}

export function up(db: Database.Database): void {
  const tables = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name)
  );
  if (!tables.has("family_tree_unions") || !tables.has("family_tree_children")) return;
  const unionColumns = new Set(
    (db.prepare("PRAGMA table_info(family_tree_unions)").all() as { name: string }[]).map((c) => c.name)
  );
  const hasPins = unionColumns.has("married_lat") && unionColumns.has("married_lng");

  const pairs = db.prepare(`
    SELECT MIN(person1_id, person2_id) AS a, MAX(person1_id, person2_id) AS b
    FROM family_tree_unions
    WHERE person2_id IS NOT NULL
    GROUP BY a, b
    HAVING COUNT(*) > 1
  `).all() as { a: string; b: string }[];

  const unionsOf = db.prepare(`
    SELECT id, status, married_date, married_place, divorced_date, note FROM family_tree_unions
    WHERE (person1_id = ? AND person2_id = ?) OR (person1_id = ? AND person2_id = ?)
    ORDER BY created_at, id
  `);
  const moveChildren = db.prepare("UPDATE OR IGNORE family_tree_children SET union_id = ? WHERE union_id = ?");
  const moveCitations = tables.has("family_tree_citations")
    ? db.prepare("UPDATE family_tree_citations SET union_id = ? WHERE union_id = ?")
    : null;
  const fill = db.prepare(`
    UPDATE family_tree_unions AS t SET
      status = CASE WHEN t.status = 'unknown' THEN s.status ELSE t.status END,
      married_date = COALESCE(t.married_date, s.married_date),
      ${hasPins ? `married_lat = CASE WHEN t.married_place IS NULL THEN s.married_lat ELSE t.married_lat END,
      married_lng = CASE WHEN t.married_place IS NULL THEN s.married_lng ELSE t.married_lng END,` : ""}
      married_place = COALESCE(t.married_place, s.married_place),
      divorced_date = COALESCE(t.divorced_date, s.divorced_date),
      note = COALESCE(t.note, s.note),
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM family_tree_unions AS s
    WHERE t.id = ? AND s.id = ?
  `);
  const remove = db.prepare("DELETE FROM family_tree_unions WHERE id = ?");

  for (const { a, b } of pairs) {
    const rows = unionsOf.all(a, b, b, a) as UnionRow[];
    if (rows.length < 2 || disagree(rows)) continue;
    const [keeper, ...copies] = rows;
    for (const copy of copies) {
      moveChildren.run(keeper.id, copy.id);
      moveCitations?.run(keeper.id, copy.id);
      fill.run(keeper.id, copy.id);
      // Child links the keeper already had cascade away with the copy.
      remove.run(copy.id);
    }
  }
}
