// Custom scan rules: persistence + the deterministic ownership resolution that
// both the rule API and the scanners rely on (docs/scan-layout-plan.md).
// A rule owns one or more folders (relative to the library source) and scans them
// with its own ordered layouts. Folders are unique per library, so the longest
// (most-specific) matching path decides ownership. A rule anchored at the library
// root ("") is the library's DEFAULT LAYOUT: it owns everything no other rule does.
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { db } from "../../../db.js";
import { matchLayouts, validateLayouts, MAX_LAYOUTS } from "./scan-rule-pattern.js";

export interface ScanRule {
  id: string;
  libraryId: string;
  name: string;
  enabled: boolean;
  preset: string | null;
  // Ordered patterns; the first that fits a book key wins.
  layouts: string[];
  paths: string[];
  // True for the root-anchored rule (paths === [""]): the library's default layout.
  isDefault: boolean;
  lastScannedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScanRuleInput {
  name: string;
  // Either form is accepted; `layouts` wins when both are present.
  layouts?: string[];
  pattern?: string;
  preset?: string | null;
  enabled?: boolean;
  paths: string[];
}

export interface ScanRuleError { error: string; }

export const isScanRuleError = (value: unknown): value is ScanRuleError =>
  typeof value === "object" && value !== null && "error" in value;

export const DEFAULT_LAYOUT_NAME = "Default layout";

// Folder paths arrive with either separator; store them POSIX, slash-trimmed.
export function normalizeRulePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "").trim();
}

function normalizePaths(raw: unknown): string[] | ScanRuleError {
  if (!Array.isArray(raw)) return { error: "Select at least one folder." };
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    // An empty path is the library root — a whole-library anchor. Kept, not dropped.
    const norm = normalizeRulePath(entry);
    if (norm.split("/").includes("..")) return { error: "Folder paths must stay inside the library." };
    if (!out.includes(norm)) out.push(norm);
  }
  if (out.length === 0) return { error: "Select at least one folder." };
  return out;
}

function normalizeLayouts(input: ScanRuleInput): string[] {
  const list = Array.isArray(input.layouts) && input.layouts.length > 0
    ? input.layouts
    : typeof input.pattern === "string" ? [input.pattern] : [];
  const out: string[] = [];
  for (const entry of list) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
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

function parseLayouts(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  } catch {
    // a corrupt row reads as "no layouts"; validation stops it being written that way
  }
  return [];
}

interface RuleRow {
  id: string; library_id: string; name: string; enabled: number; preset: string | null;
  layouts_json: string; last_scanned_at: string | null; created_at: string; updated_at: string;
}

function rowToRule(r: RuleRow, paths: string[]): ScanRule {
  return {
    id: r.id, libraryId: r.library_id, name: r.name, enabled: r.enabled === 1,
    preset: r.preset, layouts: parseLayouts(r.layouts_json), paths,
    isDefault: paths.includes(""), lastScannedAt: r.last_scanned_at,
    createdAt: r.created_at, updatedAt: r.updated_at
  };
}

const RULE_COLUMNS = "id, library_id, name, enabled, preset, layouts_json, last_scanned_at, created_at, updated_at";

export function getScanRule(id: string): ScanRule | null {
  const r = db.prepare(`SELECT ${RULE_COLUMNS} FROM library_scan_rules WHERE id = ?`).get(id) as RuleRow | undefined;
  if (!r) return null;
  const paths = (db.prepare("SELECT relative_path FROM library_scan_rule_paths WHERE rule_id = ? ORDER BY relative_path")
    .all(id) as { relative_path: string }[]).map((row) => row.relative_path);
  return rowToRule(r, paths);
}

export function listScanRules(libraryId: string): ScanRule[] {
  const ids = db.prepare("SELECT id FROM library_scan_rules WHERE library_id = ? ORDER BY name COLLATE NOCASE")
    .all(libraryId) as { id: string }[];
  return ids.map((row) => getScanRule(row.id)).filter((r): r is ScanRule => r !== null);
}

// The library's default layout: the rule anchored at the root, if any.
export function getDefaultLayoutRule(libraryId: string): ScanRule | null {
  const row = db.prepare("SELECT rule_id FROM library_scan_rule_paths WHERE library_id = ? AND relative_path = ''")
    .get(libraryId) as { rule_id: string } | undefined;
  return row ? getScanRule(row.rule_id) : null;
}

function validate(libraryId: string, input: ScanRuleInput): { name: string; layouts: string[]; paths: string[] } | ScanRuleError {
  const mediaType = libraryMediaType(libraryId);
  if (!mediaType) return { error: "Library not found." };
  const name = (input.name ?? "").trim();
  if (!name) return { error: "Enter a rule name." };
  const layouts = normalizeLayouts(input);
  if (layouts.length > MAX_LAYOUTS) return { error: `A rule can hold at most ${MAX_LAYOUTS} layouts.` };
  const patternErrors = validateLayouts(layouts, mediaType);
  if (patternErrors.length > 0) return { error: patternErrors[0] };
  const paths = normalizePaths(input.paths);
  if (isScanRuleError(paths)) return paths;
  return { name, layouts, paths };
}

function conflictError(conflict: string): ScanRuleError {
  return conflict === ""
    ? { error: "This library already has a default layout. Edit it instead of adding another." }
    : { error: `The folder "${conflict}" is already used by another rule.` };
}

export function createScanRule(libraryId: string, input: ScanRuleInput): ScanRule | ScanRuleError {
  const v = validate(libraryId, input);
  if (isScanRuleError(v)) return v;
  const conflict = conflictingPath(libraryId, v.paths, null);
  if (conflict !== null) return conflictError(conflict);

  const id = nanoid(16);
  db.transaction(() => {
    db.prepare("INSERT INTO library_scan_rules (id, library_id, name, enabled, preset, layouts_json) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, libraryId, v.name, input.enabled === false ? 0 : 1, input.preset ?? null, JSON.stringify(v.layouts));
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
  if (conflict !== null) return conflictError(conflict);

  db.transaction(() => {
    db.prepare("UPDATE library_scan_rules SET name = ?, enabled = ?, preset = ?, layouts_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
      .run(v.name, input.enabled === false ? 0 : 1, input.preset ?? null, JSON.stringify(v.layouts), id);
    db.prepare("DELETE FROM library_scan_rule_paths WHERE rule_id = ?").run(id);
    for (const path of v.paths) {
      db.prepare("INSERT INTO library_scan_rule_paths (rule_id, library_id, relative_path) VALUES (?, ?, ?)").run(id, existing.libraryId, path);
    }
  })();
  return getScanRule(id)!;
}

// Create or replace the library's default layout (the root-anchored rule). The
// name is fixed; enabled state and preset are optional.
export function setDefaultLayout(
  libraryId: string,
  input: { layouts: string[]; preset?: string | null; enabled?: boolean }
): ScanRule | ScanRuleError {
  const existing = getDefaultLayoutRule(libraryId);
  const body: ScanRuleInput = { name: DEFAULT_LAYOUT_NAME, layouts: input.layouts, preset: input.preset ?? null, enabled: input.enabled, paths: [""] };
  return existing ? updateScanRule(existing.id, body) : createScanRule(libraryId, body);
}

export function deleteScanRule(id: string): boolean {
  return db.prepare("DELETE FROM library_scan_rules WHERE id = ?").run(id).changes > 0;
}

// Stamp the rules a scan just covered. `ruleIds` null = every rule of the library.
export function markScanRulesScanned(libraryId: string, ruleIds: string[] | null): void {
  if (ruleIds === null) {
    db.prepare("UPDATE library_scan_rules SET last_scanned_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE library_id = ?").run(libraryId);
    return;
  }
  const stmt = db.prepare("UPDATE library_scan_rules SET last_scanned_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND library_id = ?");
  for (const id of ruleIds) stmt.run(id, libraryId);
}

export interface ResolvedOwner {
  rule: ScanRule;
  anchor: string; // the rule folder (relative path) that owns the item
}

interface OwnerPathRow { path: string; ruleId: string; enabled: number }

function ownerPathRows(libraryId: string): OwnerPathRow[] {
  return db.prepare(`
    SELECT p.relative_path AS path, p.rule_id AS ruleId, r.enabled AS enabled
    FROM library_scan_rule_paths p
    JOIN library_scan_rules r ON r.id = p.rule_id
    WHERE p.library_id = ?
  `).all(libraryId) as OwnerPathRow[];
}

// The most-specific rule folder containing a path, enabled or not. Root ("") owns
// the whole library; it's length 0, so any real folder rule is more specific.
function mostSpecific(rows: OwnerPathRow[], norm: string): OwnerPathRow | null {
  let best: OwnerPathRow | null = null;
  for (const row of rows) {
    if (row.path === "" || norm === row.path || norm.startsWith(`${row.path}/`)) {
      if (!best || row.path.length > best.path.length) best = row;
    }
  }
  return best;
}

// The rule + the specific folder (anchor) that owns a given item path: the
// most-specific (longest) rule folder containing it. If that most-specific match
// is disabled, the default scanner owns the path — a broader enabled rule does not
// reach through the disabled one — so this returns null. Null also means "no rule
// covers this path". The anchor is what the pattern is matched relative to.
export function resolveOwner(libraryId: string, itemPath: string): ResolvedOwner | null {
  return resolveOwnerFrom(ownerPathRows(libraryId), itemPath);
}

// Same resolution over rows loaded once — for scanners that resolve thousands of
// paths per run. Pair with `loadOwnerIndex`.
export interface OwnerIndex { rows: OwnerPathRow[]; rules: Map<string, ScanRule> }

export function loadOwnerIndex(libraryId: string): OwnerIndex {
  const rows = ownerPathRows(libraryId);
  const rules = new Map<string, ScanRule>();
  for (const row of rows) if (!rules.has(row.ruleId)) { const r = getScanRule(row.ruleId); if (r) rules.set(row.ruleId, r); }
  return { rows, rules };
}

export function resolveOwnerIndexed(index: OwnerIndex, itemPath: string): ResolvedOwner | null {
  const best = mostSpecific(index.rows, normalizeRulePath(itemPath));
  if (!best || best.enabled !== 1) return null;
  const rule = index.rules.get(best.ruleId);
  return rule ? { rule, anchor: best.path } : null;
}

function resolveOwnerFrom(rows: OwnerPathRow[], itemPath: string): ResolvedOwner | null {
  const best = mostSpecific(rows, normalizeRulePath(itemPath));
  if (!best || best.enabled !== 1) return null;
  const rule = getScanRule(best.ruleId);
  return rule ? { rule, anchor: best.path } : null;
}

export function resolveOwningRule(libraryId: string, itemPath: string): ScanRule | null {
  return resolveOwner(libraryId, itemPath)?.rule ?? null;
}

// The book key relative to the owning anchor: what a rule's layouts are matched to.
export function keyRelativeToAnchor(key: string, anchor: string): string {
  return anchor && key.startsWith(`${anchor}/`) ? key.slice(anchor.length + 1) : key;
}

// For the folder picker: who owns a folder today, enabled or not, and whether that
// rule sits on exactly this folder (then nothing else may take it) or above it
// (then a new rule here takes over just this part).
export interface FolderOwnership { ruleId: string; name: string; enabled: boolean; exact: boolean }

export function folderOwnership(libraryId: string, folderPath: string): FolderOwnership | null {
  const norm = normalizeRulePath(folderPath);
  const best = mostSpecific(ownerPathRows(libraryId), norm);
  if (!best) return null;
  const rule = getScanRule(best.ruleId);
  if (!rule) return null;
  return { ruleId: rule.id, name: rule.name, enabled: rule.enabled, exact: best.path === norm };
}

// ── Preview ──
//
// One book as a dry run would catalog it. Type-neutral: ebooks fill `formats`,
// audiobooks fill `tracks`. `change` says what saving the rule does to the book
// that exists at this path today.
export type PreviewChange =
  | "new"                 // nothing catalogued at this path today
  | "unchanged"           // already owned by the rule being edited
  | "moves-from-default"  // owned by the default scanner today
  | `moves-from-rule:${string}`
  | `merges:${number}`    // several books today become this one (audiobook boundary)
  | "added-without-fields"; // fits no layout: catalogued with file metadata only

export interface RulePreviewRow {
  path: string;
  matched: boolean;
  layoutIndex: number | null;
  author?: string;
  series?: string;
  position?: number;
  title?: string;
  narrator?: string;
  year?: number;
  publisher?: string;
  formats?: string[];
  tracks?: number;
  warnings: string[];
  change: PreviewChange;
}

export function classifyPreviewChange(libraryId: string, itemPath: string, ruleId: string | null, matched: boolean): PreviewChange {
  const row = db.prepare("SELECT scan_rule_id FROM library_items WHERE library_id = ? AND folder_path = ? AND deleted_at IS NULL")
    .get(libraryId, itemPath) as { scan_rule_id: string | null } | undefined;
  if (!matched) return "added-without-fields";
  if (!row) return "new";
  if (row.scan_rule_id === null) return "moves-from-default";
  if (ruleId && row.scan_rule_id === ruleId) return "unchanged";
  return `moves-from-rule:${row.scan_rule_id}`;
}

// Cross-row checks a single match cannot see: two books claiming the same position
// in one series, and a position captured without a series to hang it on.
export function annotatePreviewRows(rows: RulePreviewRow[]): RulePreviewRow[] {
  const byPosition = new Map<string, RulePreviewRow[]>();
  for (const row of rows) {
    if (!row.matched) continue;
    if (row.position != null && !row.series) {
      row.warnings.push("A position with no series: the number is dropped. Label a series, or skip the number.");
    }
    if (row.series && row.position != null) {
      const key = `${row.series.toLowerCase()} ${row.position}`;
      const list = byPosition.get(key) ?? [];
      list.push(row);
      byPosition.set(key, list);
    }
  }
  for (const list of byPosition.values()) {
    if (list.length < 2) continue;
    for (const row of list) row.warnings.push(`${list.length} books share position ${row.position} in "${row.series}".`);
  }
  return rows;
}

// What the Layout panel shows per rule: how many books it owns, how many of those
// fit none of its layouts, which of its folders are gone from disk, and when it
// was last applied. Unmatched is recomputed from folder_path with the pure matcher
// rather than stored, so it is always true to the current layouts.
export interface ScanRuleStats { books: number; unmatched: number; missingFolders: string[] }

export function scanRuleStats(rule: ScanRule, sourceRoot: string | null): ScanRuleStats {
  const items = db.prepare("SELECT folder_path FROM library_items WHERE library_id = ? AND scan_rule_id = ? AND deleted_at IS NULL")
    .all(rule.libraryId, rule.id) as { folder_path: string }[];
  let unmatched = 0;
  for (const item of items) {
    // The anchor is the rule's own most specific folder containing the item.
    let anchor = "";
    for (const p of rule.paths) if (p !== "" && (item.folder_path === p || item.folder_path.startsWith(`${p}/`)) && p.length >= anchor.length) anchor = p;
    if (!matchLayouts(rule.layouts, keyRelativeToAnchor(item.folder_path, anchor)).matched) unmatched += 1;
  }
  const missingFolders: string[] = [];
  if (sourceRoot) {
    for (const p of rule.paths) {
      if (p === "") continue;
      try {
        if (!fs.statSync(path.join(sourceRoot, ...p.split("/"))).isDirectory()) missingFolders.push(p);
      } catch {
        missingFolders.push(p);
      }
    }
  }
  return { books: items.length, unmatched, missingFolders };
}
