// Saved diagnostics reports (Diagnostics › Saved reports): the text exactly as the
// admin saved it from the report window — so a report made before a fix can sit
// beside one made after, or be attached later. Kept in the database (and so in its
// backups, which hold everything a report could name anyway); the last
// SAVED_KEPT are kept, saving one more drops the oldest. Nothing is sent anywhere.
import { randomUUID } from "node:crypto";
import { db } from "../../db.js";
import type { DiagnosticReportRow } from "../../db/rows.js";

export const SAVED_KEPT = 10;
/** A report is a few dozen KB; this only stops a runaway body. */
export const SAVED_MAX_CHARS = 2_000_000;

export interface SavedReportSummary {
  id: string;
  createdAt: string;
  createdBy: string | null;
  /** The saver's name, while their account exists. */
  createdByName: string | null;
  span: "hour" | "day" | "week";
  parts: string[];
  hidden: string[];
  sizeBytes: number;
}

export interface SavedReport extends SavedReportSummary {
  text: string;
}

type Row = DiagnosticReportRow & { created_by_name: string | null; size_bytes: number };

const parseList = (json: string): string[] => {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
};

const summary = (row: Row): SavedReportSummary => ({
  id: row.id,
  createdAt: row.created_at,
  createdBy: row.created_by,
  createdByName: row.created_by_name,
  span: row.span,
  parts: parseList(row.parts_json),
  hidden: parseList(row.hidden_json),
  sizeBytes: row.size_bytes
});

const SELECT = `
  SELECT r.*, u.display_name AS created_by_name, length(CAST(r.text AS BLOB)) AS size_bytes
  FROM diagnostic_reports r LEFT JOIN users u ON u.id = r.created_by`;

/** Newest first; `part` keeps only the reports that carry that section. */
export function listSaved(part?: string): SavedReportSummary[] {
  const rows = db.prepare(`${SELECT} ORDER BY r.created_at DESC, r.rowid DESC`).all() as Row[];
  const all = rows.map(summary);
  return part ? all.filter((report) => report.parts.includes(part)) : all;
}

export function getSaved(id: string): SavedReport | null {
  const row = db.prepare(`${SELECT} WHERE r.id = ?`).get(id) as Row | undefined;
  return row ? { ...summary(row), text: row.text } : null;
}

export function saveReport(input: { text: string; span: SavedReport["span"]; parts: string[]; hidden: string[] }, userId: string | null): SavedReportSummary {
  const id = randomUUID();
  db.transaction(() => {
    db.prepare("INSERT INTO diagnostic_reports (id, created_by, span, parts_json, hidden_json, text) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, userId, input.span, JSON.stringify(input.parts), JSON.stringify(input.hidden), input.text);
    // Keep the newest SAVED_KEPT.
    db.prepare(`
      DELETE FROM diagnostic_reports WHERE rowid NOT IN (
        SELECT rowid FROM diagnostic_reports ORDER BY created_at DESC, rowid DESC LIMIT ?
      )`).run(SAVED_KEPT);
  })();
  return summary(db.prepare(`${SELECT} WHERE r.id = ?`).get(id) as Row);
}

export function deleteSaved(id: string): boolean {
  return db.prepare("DELETE FROM diagnostic_reports WHERE id = ?").run(id).changes > 0;
}
