// Sources ("where a fact came from") and citations (source → one target).
// A citation points at exactly one of: a person (optionally a specific fact —
// name/birth/death), a life event, or a union (optionally marriage/divorce).
// Deleting a source cascades its citations; deleting a citation never touches
// the source.
import { nanoid } from "nanoid";
import { db } from "../../db.js";

export const CITATION_FACTS = ["name", "birth", "death", "marriage", "divorce"] as const;

export interface FamilySourceSummary {
  id: string;
  title: string;
  author: string | null;
  publisher: string | null;
  url: string | null;
  note: string | null;
  citationCount: number;
}

interface SourceRow {
  id: string;
  title: string;
  author: string | null;
  publisher: string | null;
  url: string | null;
  note: string | null;
  citation_count: number;
}

function mapSource(row: SourceRow): FamilySourceSummary {
  return {
    id: row.id,
    title: row.title,
    author: row.author,
    publisher: row.publisher,
    url: row.url,
    note: row.note,
    citationCount: row.citation_count
  };
}

const SOURCE_SELECT = `
  SELECT s.id, s.title, s.author, s.publisher, s.url, s.note,
    (SELECT COUNT(*) FROM family_tree_citations c WHERE c.source_id = s.id) AS citation_count
  FROM family_tree_sources s`;

export function getFamilySource(sourceId: string): FamilySourceSummary | null {
  const row = db.prepare(`${SOURCE_SELECT} WHERE s.id = ?`).get(sourceId) as SourceRow | undefined;
  return row ? mapSource(row) : null;
}

export function listFamilySources(): FamilySourceSummary[] {
  const rows = db.prepare(`${SOURCE_SELECT} ORDER BY s.title COLLATE NOCASE`).all() as SourceRow[];
  return rows.map(mapSource);
}

export interface FamilySourceFields {
  title: string;
  author?: string | null;
  publisher?: string | null;
  url?: string | null;
  note?: string | null;
}

export function createFamilySource(fields: FamilySourceFields): FamilySourceSummary {
  const id = nanoid(16);
  db.prepare(`
    INSERT INTO family_tree_sources (id, title, author, publisher, url, note)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    id, fields.title.trim(), fields.author?.trim() || null, fields.publisher?.trim() || null,
    fields.url?.trim() || null, fields.note?.trim() || null
  );
  return getFamilySource(id)!;
}

export function updateFamilySource(sourceId: string, fields: Partial<FamilySourceFields>): FamilySourceSummary | null {
  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (column: string, value: unknown) => { sets.push(`${column} = ?`); params.push(value); };
  if (fields.title !== undefined) set("title", fields.title.trim());
  if (fields.author !== undefined) set("author", fields.author?.trim() || null);
  if (fields.publisher !== undefined) set("publisher", fields.publisher?.trim() || null);
  if (fields.url !== undefined) set("url", fields.url?.trim() || null);
  if (fields.note !== undefined) set("note", fields.note?.trim() || null);
  if (sets.length === 0) return getFamilySource(sourceId);
  sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
  const res = db.prepare(`UPDATE family_tree_sources SET ${sets.join(", ")} WHERE id = ?`).run(...params, sourceId);
  return res.changes > 0 ? getFamilySource(sourceId) : null;
}

export function deleteFamilySource(sourceId: string): boolean {
  return db.prepare("DELETE FROM family_tree_sources WHERE id = ?").run(sourceId).changes > 0;
}

export interface FamilyCitationSummary {
  id: string;
  sourceId: string;
  sourceTitle: string;
  sourceUrl: string | null;
  personId: string | null;
  eventId: string | null;
  unionId: string | null;
  fact: string | null;
  detail: string | null;
  url: string | null;
  note: string | null;
}

interface CitationRow {
  id: string;
  source_id: string;
  source_title: string;
  source_url: string | null;
  person_id: string | null;
  event_id: string | null;
  union_id: string | null;
  fact: string | null;
  detail: string | null;
  url: string | null;
  note: string | null;
}

function mapCitation(row: CitationRow): FamilyCitationSummary {
  return {
    id: row.id,
    sourceId: row.source_id,
    sourceTitle: row.source_title,
    sourceUrl: row.source_url,
    personId: row.person_id,
    eventId: row.event_id,
    unionId: row.union_id,
    fact: row.fact,
    detail: row.detail,
    url: row.url,
    note: row.note
  };
}

const CITATION_SELECT = `
  SELECT c.id, c.source_id, s.title AS source_title, s.url AS source_url,
    c.person_id, c.event_id, c.union_id, c.fact, c.detail, c.url, c.note
  FROM family_tree_citations c
  JOIN family_tree_sources s ON s.id = c.source_id`;

export function getFamilyCitation(citationId: string): FamilyCitationSummary | null {
  const row = db.prepare(`${CITATION_SELECT} WHERE c.id = ?`).get(citationId) as CitationRow | undefined;
  return row ? mapCitation(row) : null;
}

// Everything backing a person's profile: citations on the person themselves,
// on their life events, and on unions they are a partner in.
export function listPersonCitations(personId: string): FamilyCitationSummary[] {
  const rows = db.prepare(`${CITATION_SELECT}
    WHERE c.person_id = ?
      OR c.event_id IN (SELECT id FROM family_tree_events WHERE person_id = ?)
      OR c.union_id IN (SELECT id FROM family_tree_unions WHERE person1_id = ? OR person2_id = ?)
    ORDER BY s.title COLLATE NOCASE, c.created_at
  `).all(personId, personId, personId, personId) as CitationRow[];
  return rows.map(mapCitation);
}

export interface FamilyCitationFields {
  sourceId: string;
  personId?: string | null;
  eventId?: string | null;
  unionId?: string | null;
  fact?: string | null;
  detail?: string | null;
  url?: string | null;
  note?: string | null;
}

export type CitationError = "source_not_found" | "target_not_found" | "bad_target";

export function createFamilyCitation(fields: FamilyCitationFields): { citation: FamilyCitationSummary } | { error: CitationError } {
  const targets = [fields.personId, fields.eventId, fields.unionId].filter((t): t is string => t != null);
  if (targets.length !== 1) return { error: "bad_target" };
  if (!db.prepare("SELECT 1 FROM family_tree_sources WHERE id = ?").get(fields.sourceId)) {
    return { error: "source_not_found" };
  }
  const targetTable = fields.personId ? "family_tree_persons" : fields.eventId ? "family_tree_events" : "family_tree_unions";
  if (!db.prepare(`SELECT 1 FROM ${targetTable} WHERE id = ?`).get(targets[0])) {
    return { error: "target_not_found" };
  }
  const id = nanoid(16);
  db.prepare(`
    INSERT INTO family_tree_citations (id, source_id, person_id, event_id, union_id, fact, detail, url, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, fields.sourceId, fields.personId ?? null, fields.eventId ?? null, fields.unionId ?? null,
    fields.fact ?? null, fields.detail?.trim() || null, fields.url?.trim() || null, fields.note?.trim() || null
  );
  return { citation: getFamilyCitation(id)! };
}

// Only the annotation fields change; retargeting a citation is delete + add.
export function updateFamilyCitation(
  citationId: string,
  fields: Partial<Pick<FamilyCitationFields, "fact" | "detail" | "url" | "note">>
): FamilyCitationSummary | null {
  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (column: string, value: unknown) => { sets.push(`${column} = ?`); params.push(value); };
  if (fields.fact !== undefined) set("fact", fields.fact ?? null);
  if (fields.detail !== undefined) set("detail", fields.detail?.trim() || null);
  if (fields.url !== undefined) set("url", fields.url?.trim() || null);
  if (fields.note !== undefined) set("note", fields.note?.trim() || null);
  if (sets.length === 0) return getFamilyCitation(citationId);
  const res = db.prepare(`UPDATE family_tree_citations SET ${sets.join(", ")} WHERE id = ?`).run(...params, citationId);
  return res.changes > 0 ? getFamilyCitation(citationId) : null;
}

export function deleteFamilyCitation(citationId: string): boolean {
  return db.prepare("DELETE FROM family_tree_citations WHERE id = ?").run(citationId).changes > 0;
}
