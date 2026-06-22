// Custom scan rules: persistence + the deterministic ownership resolution that
// both the rule API and the scanner rely on (docs/custom-scan-rules-proposal.md).
// A rule owns one or more folders (relative to the library source) and scans them
// with its own layout pattern. Folders are unique per library, so the longest
// (most-specific) matching path decides ownership.
import { nanoid } from "nanoid";
import { db } from "../../../db.js";
import { validatePattern } from "./scan-rule-pattern.js";

export interface ScanRule {
  id: string;
  libraryId: string;
  name: string;
  enabled: boolean;
  preset: string | null;
  pattern: string;
  paths: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ScanRuleInput {
  name: string;
  pattern: string;
  preset?: string | null;
  enabled?: boolean;
  paths: string[];
}

export interface ScanRuleError { error: string; }

export const isScanRuleError = (value: unknown): value is ScanRuleError =>
  typeof value === "object" && value !== null && "error" in value;

// Folder paths arrive with either separator; store them POSIX, slash-trimmed.
function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "").trim();
}

function normalizePaths(raw: unknown): string[] | ScanRuleError {
  if (!Array.isArray(raw)) return { error: "Select at least one folder." };
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const norm = normalizePath(entry);
    if (!norm) continue;
    if (norm.split("/").includes("..")) return { error: "Folder paths must stay inside the library." };
    if (!out.includes(norm)) out.push(norm);
  }
  if (out.length === 0) return { error: "Select at least one folder." };
  return out;
}

function libraryMediaType(libraryId: string): "audiobook" | "ebook" | null {
  const row = db.prepare("SELECT type FROM libraries WHERE id = ?").get(libraryId) as { type: string } | undefined;
  if (!row) return null;
  return row.type === "audiobook" ? "audiobook" : "ebook";
}

// The path already claimed by a different rule in this library, or null.
function conflictingPath(libraryId: string, paths: string[], excludeRuleId: string | null): string | null {
  for (const path of paths) {
    const row = db.prepare("SELECT rule_id FROM library_scan_rule_paths WHERE library_id = ? AND relative_path = ?")
      .get(libraryId, path) as { rule_id: string } | undefined;
    if (row && row.rule_id !== excludeRuleId) return path;
  }
  return null;
}

export function getScanRule(id: string): ScanRule | null {
  const r = db.prepare(
    "SELECT id, library_id, name, enabled, preset, pattern, created_at, updated_at FROM library_scan_rules WHERE id = ?"
  ).get(id) as {
    id: string; library_id: string; name: string; enabled: number;
    preset: string | null; pattern: string; created_at: string; updated_at: string;
  } | undefined;
  if (!r) return null;
  const paths = (db.prepare("SELECT relative_path FROM library_scan_rule_paths WHERE rule_id = ? ORDER BY relative_path")
    .all(id) as { relative_path: string }[]).map((row) => row.relative_path);
  return {
    id: r.id, libraryId: r.library_id, name: r.name, enabled: r.enabled === 1,
    preset: r.preset, pattern: r.pattern, paths, createdAt: r.created_at, updatedAt: r.updated_at
  };
}

export function listScanRules(libraryId: string): ScanRule[] {
  const ids = db.prepare("SELECT id FROM library_scan_rules WHERE library_id = ? ORDER BY name COLLATE NOCASE")
    .all(libraryId) as { id: string }[];
  return ids.map((row) => getScanRule(row.id)).filter((r): r is ScanRule => r !== null);
}

function validate(libraryId: string, input: ScanRuleInput): { name: string; pattern: string; paths: string[] } | ScanRuleError {
  const mediaType = libraryMediaType(libraryId);
  if (!mediaType) return { error: "Library not found." };
  const name = (input.name ?? "").trim();
  if (!name) return { error: "Enter a rule name." };
  const patternErrors = validatePattern(input.pattern ?? "", mediaType);
  if (patternErrors.length > 0) return { error: patternErrors[0] };
  const paths = normalizePaths(input.paths);
  if (isScanRuleError(paths)) return paths;
  return { name, pattern: input.pattern.trim(), paths };
}

export function createScanRule(libraryId: string, input: ScanRuleInput): ScanRule | ScanRuleError {
  const v = validate(libraryId, input);
  if (isScanRuleError(v)) return v;
  const conflict = conflictingPath(libraryId, v.paths, null);
  if (conflict) return { error: `The folder "${conflict}" is already used by another rule.` };

  const id = nanoid(16);
  db.transaction(() => {
    db.prepare("INSERT INTO library_scan_rules (id, library_id, name, enabled, preset, pattern) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, libraryId, v.name, input.enabled === false ? 0 : 1, input.preset ?? null, v.pattern);
    for (const path of v.paths) {
      db.prepare("INSERT INTO library_scan_rule_paths (rule_id, library_id, relative_path) VALUES (?, ?, ?)").run(id, libraryId, path);
    }
  })();
  return getScanRule(id)!;
}

export function updateScanRule(id: string, input: ScanRuleInput): ScanRule | ScanRuleError {
  const existing = getScanRule(id);
  if (!existing) return { error: "Rule not found." };
  const v = validate(existing.libraryId, input);
  if (isScanRuleError(v)) return v;
  const conflict = conflictingPath(existing.libraryId, v.paths, id);
  if (conflict) return { error: `The folder "${conflict}" is already used by another rule.` };

  db.transaction(() => {
    db.prepare("UPDATE library_scan_rules SET name = ?, enabled = ?, preset = ?, pattern = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
      .run(v.name, input.enabled === false ? 0 : 1, input.preset ?? null, v.pattern, id);
    db.prepare("DELETE FROM library_scan_rule_paths WHERE rule_id = ?").run(id);
    for (const path of v.paths) {
      db.prepare("INSERT INTO library_scan_rule_paths (rule_id, library_id, relative_path) VALUES (?, ?, ?)").run(id, existing.libraryId, path);
    }
  })();
  return getScanRule(id)!;
}

export function deleteScanRule(id: string): boolean {
  return db.prepare("DELETE FROM library_scan_rules WHERE id = ?").run(id).changes > 0;
}

export interface ResolvedOwner {
  rule: ScanRule;
  anchor: string; // the rule folder (relative path) that owns the item
}

// The rule + the specific folder (anchor) that owns a given item path: the
// most-specific (longest) rule folder containing it. If that most-specific match
// is disabled, the default scanner owns the path — a broader enabled rule does not
// reach through the disabled one — so this returns null. Null also means "no rule
// covers this path". The anchor is what the pattern is matched relative to.
export function resolveOwner(libraryId: string, itemPath: string): ResolvedOwner | null {
  const norm = normalizePath(itemPath);
  const rows = db.prepare(`
    SELECT p.relative_path AS path, p.rule_id AS ruleId, r.enabled AS enabled
    FROM library_scan_rule_paths p
    JOIN library_scan_rules r ON r.id = p.rule_id
    WHERE p.library_id = ?
  `).all(libraryId) as { path: string; ruleId: string; enabled: number }[];

  let best: { len: number; ruleId: string; enabled: number; path: string } | null = null;
  for (const row of rows) {
    if (norm === row.path || norm.startsWith(`${row.path}/`)) {
      if (!best || row.path.length > best.len) {
        best = { len: row.path.length, ruleId: row.ruleId, enabled: row.enabled, path: row.path };
      }
    }
  }
  if (!best || best.enabled !== 1) return null;
  const rule = getScanRule(best.ruleId);
  return rule ? { rule, anchor: best.path } : null;
}

export function resolveOwningRule(libraryId: string, itemPath: string): ScanRule | null {
  return resolveOwner(libraryId, itemPath)?.rule ?? null;
}
