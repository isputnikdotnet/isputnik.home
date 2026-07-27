// Life events: a person's timeline beyond the birth/death/marriage columns
// (school, work, residences, service…). `label` is the short "what" for every
// type — occupation title, school name — and is the only required field for
// `custom` events; everything else is optional so sparse genealogy data fits.
import { nanoid } from "nanoid";
import { db } from "../../db.js";

export const EVENT_TYPES = [
  "residence", "education", "occupation", "military",
  "immigration", "emigration", "burial", "custom"
] as const;

export interface FamilyEventSummary {
  id: string;
  personId: string;
  type: string;
  label: string | null;
  date: string | null;
  endDate: string | null;
  place: string | null;
  note: string | null;
}

interface EventRow {
  id: string;
  person_id: string;
  type: string;
  label: string | null;
  date: string | null;
  end_date: string | null;
  place: string | null;
  note: string | null;
}

function mapEvent(row: EventRow): FamilyEventSummary {
  return {
    id: row.id,
    personId: row.person_id,
    type: row.type,
    label: row.label,
    date: row.date,
    endDate: row.end_date,
    place: row.place,
    note: row.note
  };
}

const EVENT_SELECT = "SELECT id, person_id, type, label, date, end_date, place, note FROM family_tree_events";

export function getFamilyEvent(eventId: string): FamilyEventSummary | null {
  const row = db.prepare(`${EVENT_SELECT} WHERE id = ?`).get(eventId) as EventRow | undefined;
  return row ? mapEvent(row) : null;
}

// Chronological; undated events sink to the end in creation order.
export function listFamilyEvents(personId: string): FamilyEventSummary[] {
  const rows = db.prepare(
    `${EVENT_SELECT} WHERE person_id = ? ORDER BY date IS NULL, date, created_at`
  ).all(personId) as EventRow[];
  return rows.map(mapEvent);
}

export interface FamilyEventFields {
  type: string;
  label?: string | null;
  date?: string | null;
  endDate?: string | null;
  place?: string | null;
  note?: string | null;
}

export function createFamilyEvent(personId: string, fields: FamilyEventFields): FamilyEventSummary | null {
  const exists = db.prepare("SELECT 1 FROM family_tree_persons WHERE id = ?").get(personId);
  if (!exists) return null;
  const id = nanoid(16);
  db.prepare(`
    INSERT INTO family_tree_events (id, person_id, type, label, date, end_date, place, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, personId, fields.type, fields.label?.trim() || null,
    fields.date || null, fields.endDate || null,
    fields.place?.trim() || null, fields.note?.trim() || null
  );
  return getFamilyEvent(id);
}

export function updateFamilyEvent(eventId: string, fields: Partial<FamilyEventFields>): FamilyEventSummary | null {
  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (column: string, value: unknown) => { sets.push(`${column} = ?`); params.push(value); };
  if (fields.type !== undefined) set("type", fields.type);
  if (fields.label !== undefined) set("label", fields.label?.trim() || null);
  if (fields.date !== undefined) set("date", fields.date || null);
  if (fields.endDate !== undefined) set("end_date", fields.endDate || null);
  if (fields.place !== undefined) set("place", fields.place?.trim() || null);
  if (fields.note !== undefined) set("note", fields.note?.trim() || null);
  if (sets.length === 0) return getFamilyEvent(eventId);
  sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
  const res = db.prepare(`UPDATE family_tree_events SET ${sets.join(", ")} WHERE id = ?`).run(...params, eventId);
  return res.changes > 0 ? getFamilyEvent(eventId) : null;
}

export function deleteFamilyEvent(eventId: string): boolean {
  return db.prepare("DELETE FROM family_tree_events WHERE id = ?").run(eventId).changes > 0;
}
