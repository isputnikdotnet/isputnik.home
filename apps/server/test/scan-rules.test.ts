import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import {
  createScanRule, updateScanRule, deleteScanRule, getScanRule, listScanRules,
  resolveOwningRule, resolveOwner, isScanRuleError
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
    expect(getScanRule(rule.id)?.pattern).toBe("{series}/{position}. {title}");
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
    expect(updated.pattern).toBe("{series}/{title}");
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
