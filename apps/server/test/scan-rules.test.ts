import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { db } from "../src/db.js";
import { runMigrationsFrom } from "../src/db/migrate.js";
import {
  createScanRule, updateScanRule, deleteScanRule, getScanRule, listScanRules,
  resolveOwningRule, resolveOwner, isScanRuleError,
  getDefaultLayoutRule, setDefaultLayout, DEFAULT_LAYOUT_NAME, scanRuleStats, folderOwnership, markScanRulesScanned
} from "../src/modules/library/shared/scan-rules.js";
import { resetDb, makeUser, makeLibrary } from "./helpers/seed.js";

beforeEach(() => {
  resetDb();
  makeUser("u1");
  makeLibrary("L1", { createdBy: "u1", type: "ebook" });
});

describe("createScanRule", () => {
  it("creates a rule and round-trips with normalized, deduped paths", () => {
    const rule = createScanRule("L1", {
      name: "Круз",
      pattern: "{series}/{position}. {title}",
      paths: ["Круз Андрей\\", "/Круз Андрей/"]
    });
    expect(isScanRuleError(rule)).toBe(false);
    if (isScanRuleError(rule)) return;
    expect(rule.paths).toEqual(["Круз Андрей"]);
    expect(rule.enabled).toBe(true);
    expect(getScanRule(rule.id)?.layouts).toEqual(["{series}/{position}. {title}"]);
    expect(listScanRules("L1")).toHaveLength(1);
  });

  it("rejects bad input", () => {
    expect(createScanRule("L1", { name: "  ", pattern: "{title}", paths: ["A"] })).toEqual({ error: "Enter a rule name." });
    expect(createScanRule("L1", { name: "x", pattern: "{narrator}/{title}", paths: ["A"] }))
      .toEqual({ error: "{narrator} is only valid for audiobook rules." });
    expect(createScanRule("L1", { name: "x", pattern: "{title}", paths: [] })).toEqual({ error: "Select at least one folder." });
    expect(createScanRule("L1", { name: "x", pattern: "{title}", paths: ["../escape"] }))
      .toEqual({ error: "Folder paths must stay inside the library." });
  });

  it("rejects a folder already used by another rule", () => {
    createScanRule("L1", { name: "A", pattern: "{title}", paths: ["Shared"] });
    expect(createScanRule("L1", { name: "B", pattern: "{title}", paths: ["Shared"] }))
      .toEqual({ error: 'The folder "Shared" is already used by another rule.' });
  });
});

describe("resolveOwningRule", () => {
  it("picks the most-specific rule; a disabled match falls back to the default", () => {
    const a = createScanRule("L1", { name: "Coll", pattern: "{title}", paths: ["Collections"] });
    const b = createScanRule("L1", { name: "Box", pattern: "{title}", paths: ["Collections/Box Sets"] });
    if (isScanRuleError(a) || isScanRuleError(b)) throw new Error("setup failed");

    expect(resolveOwningRule("L1", "Collections/Box Sets/Dune")?.id).toBe(b.id);
    expect(resolveOwningRule("L1", "Collections/Other/X")?.id).toBe(a.id);
    expect(resolveOwningRule("L1", "Elsewhere/Y")).toBeNull();

    // Disabling the most-specific rule hands its scope to the default — not to A.
    updateScanRule(b.id, { name: "Box", pattern: "{title}", paths: ["Collections/Box Sets"], enabled: false });
    expect(resolveOwningRule("L1", "Collections/Box Sets/Dune")).toBeNull();
    expect(resolveOwningRule("L1", "Collections/Other/X")?.id).toBe(a.id);
  });

  it("resolveOwner returns the most-specific owning folder as the anchor", () => {
    const a = createScanRule("L1", { name: "Coll", pattern: "{title}", paths: ["Collections"] });
    const b = createScanRule("L1", { name: "Box", pattern: "{title}", paths: ["Collections/Box Sets"] });
    if (isScanRuleError(a) || isScanRuleError(b)) throw new Error("setup failed");
    expect(resolveOwner("L1", "Collections/Box Sets/Dune")).toMatchObject({ rule: { id: b.id }, anchor: "Collections/Box Sets" });
    expect(resolveOwner("L1", "Collections/Other/X")).toMatchObject({ rule: { id: a.id }, anchor: "Collections" });
    expect(resolveOwner("L1", "Elsewhere/Y")).toBeNull();
  });

  it("a root (empty-path) rule owns the whole library but yields to a more-specific folder rule", () => {
    const root = createScanRule("L1", { name: "Whole library", pattern: "{author}/{title}", paths: [""] });
    if (isScanRuleError(root)) throw new Error("setup failed");
    expect(root.paths).toEqual([""]);

    // With only the root rule, every path is owned by it, anchored at "" (so the
    // pattern matches the full relative key).
    expect(resolveOwner("L1", "Asimov/Foundation")).toMatchObject({ rule: { id: root.id }, anchor: "" });
    expect(resolveOwner("L1", "Deep/Nested/Book")).toMatchObject({ rule: { id: root.id }, anchor: "" });

    // A folder rule is more specific than root and wins within its scope.
    const sci = createScanRule("L1", { name: "Sci-Fi", pattern: "{series}/{title}", paths: ["Sci-Fi"] });
    if (isScanRuleError(sci)) throw new Error("setup failed");
    expect(resolveOwner("L1", "Sci-Fi/Dune")).toMatchObject({ rule: { id: sci.id }, anchor: "Sci-Fi" });
    expect(resolveOwner("L1", "Asimov/Foundation")).toMatchObject({ rule: { id: root.id }, anchor: "" });

    // Disabling the root rule hands its scope back to the default scanner.
    updateScanRule(root.id, { name: "Whole library", pattern: "{author}/{title}", paths: [""], enabled: false });
    expect(resolveOwner("L1", "Asimov/Foundation")).toBeNull();
    expect(resolveOwner("L1", "Sci-Fi/Dune")).toMatchObject({ rule: { id: sci.id } });
  });
});

describe("updateScanRule / deleteScanRule", () => {
  it("replaces paths and pattern on update", () => {
    const r = createScanRule("L1", { name: "R", pattern: "{title}", paths: ["Old"] });
    if (isScanRuleError(r)) throw new Error("setup failed");
    updateScanRule(r.id, { name: "R2", pattern: "{series}/{title}", paths: ["New/Place"] });
    const updated = getScanRule(r.id)!;
    expect(updated.name).toBe("R2");
    expect(updated.layouts).toEqual(["{series}/{title}"]);
    expect(updated.paths).toEqual(["New/Place"]);
  });

  it("deleting a rule cascades its paths and clears scan_rule_id on its items", () => {
    const r = createScanRule("L1", { name: "R", pattern: "{title}", paths: ["Dir"] });
    if (isScanRuleError(r)) throw new Error("setup failed");
    db.prepare("INSERT INTO library_items (id, library_id, type, folder_path, scan_rule_id) VALUES ('it1','L1','ebook','Dir/Book',?)").run(r.id);

    expect(deleteScanRule(r.id)).toBe(true);
    expect(getScanRule(r.id)).toBeNull();
    expect((db.prepare("SELECT COUNT(*) c FROM library_scan_rule_paths WHERE rule_id = ?").get(r.id) as { c: number }).c).toBe(0);
    expect((db.prepare("SELECT scan_rule_id FROM library_items WHERE id = 'it1'").get() as { scan_rule_id: string | null }).scan_rule_id).toBeNull();
  });
});

describe("layouts (ordered fallback patterns)", () => {
  it("stores an ordered list and still accepts the old one-pattern input", () => {
    const r = createScanRule("L1", { name: "Two", layouts: ["{author}/{series}/{position} - {title}", "{author}/{title}"], paths: ["Books"] });
    if (isScanRuleError(r)) throw new Error(r.error);
    expect(r.layouts).toEqual(["{author}/{series}/{position} - {title}", "{author}/{title}"]);
    expect((db.prepare("SELECT layouts_json FROM library_scan_rules WHERE id = ?").get(r.id) as { layouts_json: string }))
      .toEqual({ layouts_json: JSON.stringify(["{author}/{series}/{position} - {title}", "{author}/{title}"]) });

    const old = createScanRule("L1", { name: "One", pattern: "{title}", paths: ["Other"] });
    if (isScanRuleError(old)) throw new Error(old.error);
    expect(old.layouts).toEqual(["{title}"]);
  });

  it("validates every layout and names the failing one", () => {
    expect(createScanRule("L1", { name: "x", layouts: ["{title}", "{narrator}/{title}"], paths: ["A"] }))
      .toEqual({ error: "Layout 2: {narrator} is only valid for audiobook rules." });
    expect(createScanRule("L1", { name: "x", layouts: [], paths: ["A"] })).toEqual({ error: "Enter a pattern." });
  });

  it("migrations 64 and 65 carry a pre-layouts rule's pattern into layouts_json and drop the column", () => {
    // A throwaway file shaped like a 3.61 database: rules table with the single
    // pattern column and no layouts_json, stamped at the version just before 64.
    const legacy = new Database(":memory:");
    legacy.exec(`
      CREATE TABLE libraries (id TEXT PRIMARY KEY);
      CREATE TABLE library_scan_rules (
        id TEXT PRIMARY KEY, library_id TEXT NOT NULL, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
        preset TEXT, pattern TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      INSERT INTO library_scan_rules (id, library_id, name, pattern) VALUES ('legacy', 'L1', 'Legacy', '{series}/{title}');
    `);
    runMigrationsFrom(legacy, 63);
    const columns = (legacy.prepare("PRAGMA table_info(library_scan_rules)").all() as { name: string }[]).map((c) => c.name);
    expect(columns).toContain("layouts_json");
    expect(columns).toContain("last_scanned_at");
    expect(columns).not.toContain("pattern");
    expect((legacy.prepare("SELECT layouts_json FROM library_scan_rules WHERE id = 'legacy'").get() as { layouts_json: string }).layouts_json)
      .toBe(JSON.stringify(["{series}/{title}"]));
    legacy.close();
  });
});

describe("default layout", () => {
  it("is the root-anchored rule: created once, then replaced in place, never duplicated", () => {
    expect(getDefaultLayoutRule("L1")).toBeNull();
    const created = setDefaultLayout("L1", { layouts: ["{author}/{title}"] });
    if (isScanRuleError(created)) throw new Error(created.error);
    expect(created).toMatchObject({ isDefault: true, paths: [""], name: DEFAULT_LAYOUT_NAME, layouts: ["{author}/{title}"] });

    const replaced = setDefaultLayout("L1", { layouts: ["{author}/{series}/{title}", "{author}/{title}"] });
    if (isScanRuleError(replaced)) throw new Error(replaced.error);
    expect(replaced.id).toBe(created.id);
    expect(getDefaultLayoutRule("L1")?.layouts).toEqual(["{author}/{series}/{title}", "{author}/{title}"]);

    expect(createScanRule("L1", { name: "Another root", pattern: "{title}", paths: [""] }))
      .toEqual({ error: "This library already has a default layout. Edit it instead of adding another." });
  });
});

describe("scanRuleStats and folderOwnership", () => {
  it("counts owned books, those fitting no layout, and folders gone from disk", () => {
    const r = createScanRule("L1", { name: "R", layouts: ["{series}/{position} - {title}"], paths: ["Shelf"] });
    if (isScanRuleError(r)) throw new Error(r.error);
    const ins = db.prepare("INSERT INTO library_items (id, library_id, type, folder_path, scan_rule_id, deleted_at) VALUES (?, 'L1', 'ebook', ?, ?, ?)");
    ins.run("a", "Shelf/Dune/01 - Dune", r.id, null);
    ins.run("b", "Shelf/Loose Book", r.id, null);            // fits no layout
    ins.run("c", "Shelf/Gone/02 - Gone", r.id, "2026-01-01"); // deleted: not counted
    ins.run("d", "Elsewhere/Book", null, null);               // default-owned: not this rule's

    expect(scanRuleStats(r, null)).toEqual({ books: 2, unmatched: 1, missingFolders: [] });
    // With a source root the folder is checked on disk; a made-up root has no "Shelf".
    expect(scanRuleStats(r, "/definitely/not/a/real/root").missingFolders).toEqual(["Shelf"]);
  });

  it("reports who owns a folder, enabled or not, and whether the rule sits exactly on it", () => {
    const coll = createScanRule("L1", { name: "Coll", pattern: "{title}", paths: ["Collections"] });
    if (isScanRuleError(coll)) throw new Error(coll.error);
    expect(folderOwnership("L1", "Collections")).toEqual({ ruleId: coll.id, name: "Coll", enabled: true, exact: true });
    expect(folderOwnership("L1", "Collections/Box Sets")).toEqual({ ruleId: coll.id, name: "Coll", enabled: true, exact: false });
    expect(folderOwnership("L1", "Elsewhere")).toBeNull();

    updateScanRule(coll.id, { name: "Coll", pattern: "{title}", paths: ["Collections"], enabled: false });
    expect(folderOwnership("L1", "Collections")?.enabled).toBe(false);
  });

  it("markScanRulesScanned stamps the rules a scan covered", () => {
    const a = createScanRule("L1", { name: "A", pattern: "{title}", paths: ["A"] });
    const b = createScanRule("L1", { name: "B", pattern: "{title}", paths: ["B"] });
    if (isScanRuleError(a) || isScanRuleError(b)) throw new Error("setup failed");
    markScanRulesScanned("L1", [a.id]);
    expect(getScanRule(a.id)?.lastScannedAt).not.toBeNull();
    expect(getScanRule(b.id)?.lastScannedAt).toBeNull();
  });
});
