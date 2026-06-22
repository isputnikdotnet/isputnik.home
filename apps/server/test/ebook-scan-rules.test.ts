import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { ingestEbookGroup, reconcileOwnedItems } from "../src/modules/library/ebook/scanner.js";
import { createScanRule, isScanRuleError } from "../src/modules/library/shared/scan-rules.js";
import { normalizeLibrarySettings } from "../src/modules/library/shared/library-settings.js";
import { resetDb, makeUser, makeLibrary, grant } from "./helpers/seed.js";

const SETTINGS = normalizeLibrarySettings("ebook", "{}");

interface FileEntry { absolutePath: string; relativePath: string; fileName: string; extension: string; size: number }
const fileEntry = (relativePath: string, size = 100): FileEntry => ({
  absolutePath: `/src/EB/${relativePath}`,
  relativePath,
  fileName: relativePath.split("/").pop()!,
  extension: `.${relativePath.split(".").pop()}`,
  size
});

const seriesOf = (itemId: string) =>
  db.prepare("SELECT s.name AS name, si.position AS position FROM series_items si JOIN series s ON s.id = si.series_id WHERE si.item_id = ?")
    .get(itemId) as { name: string; position: number } | undefined;
const authorsOf = (itemId: string) =>
  (db.prepare("SELECT p.name FROM item_people ip JOIN people p ON p.id = ip.person_id WHERE ip.item_id = ? AND ip.role = 'author' ORDER BY ip.sort_order").all(itemId) as { name: string }[]).map((r) => r.name);
const ruleIdOf = (itemId: string) =>
  (db.prepare("SELECT scan_rule_id FROM library_items WHERE id = ?").get(itemId) as { scan_rule_id: string | null }).scan_rule_id;
const deletedAt = (itemId: string) =>
  (db.prepare("SELECT deleted_at FROM library_items WHERE id = ?").get(itemId) as { deleted_at: string | null }).deleted_at;

beforeEach(() => {
  resetDb();
  makeUser("u1");
  makeLibrary("EB", { createdBy: "u1", type: "ebook" });
  grant("group", EVERYONE_GROUP_ID, "EB", "member");
});

describe("rule-scoped ebook ingest", () => {
  it("tags the item with scan_rule_id and applies pattern-derived series/author/title", async () => {
    const rule = createScanRule("EB", { name: "Круз", pattern: "{author}/{series}/{position}. {title}", paths: ["Круз Андрей"] });
    if (isScanRuleError(rule)) throw new Error("setup failed");

    const id = await ingestEbookGroup("EB", [fileEntry("Круз Андрей/Ар-Деко/1. Ар-Деко.fb2")], SETTINGS, false, {
      scanRuleId: rule.id,
      fields: { matched: true, author: "Андрей Круз", series: "Ар-Деко", position: 1, title: "Ар-Деко" }
    });

    expect(ruleIdOf(id)).toBe(rule.id);
    expect(seriesOf(id)).toEqual({ name: "Ар-Деко", position: 1 });
    expect(authorsOf(id)).toEqual(["Андрей Круз"]);
    expect((db.prepare("SELECT title FROM item_metadata WHERE item_id = ?").get(id) as { title: string }).title).toBe("Ар-Деко");
  });

  it("clears the scanned series when an item moves from a rule back to the default", async () => {
    const rule = createScanRule("EB", { name: "R", pattern: "{series}/{title}", paths: ["Dir"] });
    if (isScanRuleError(rule)) throw new Error("setup failed");

    const id = await ingestEbookGroup("EB", [fileEntry("Dir/Foo.fb2")], SETTINGS, false, {
      scanRuleId: rule.id, fields: { matched: true, series: "MySeries", title: "Foo" }
    });
    expect(seriesOf(id)?.name).toBe("MySeries");

    // Re-ingest as default-owned (rule removed/disabled): same item, series cleared.
    const id2 = await ingestEbookGroup("EB", [fileEntry("Dir/Foo.fb2")], SETTINGS, false, { scanRuleId: null });
    expect(id2).toBe(id);
    expect(seriesOf(id)).toBeUndefined();
    expect(ruleIdOf(id)).toBeNull();
  });
});

describe("reconcileOwnedItems", () => {
  it("removes only the targeted owner's absent items", () => {
    const rule = createScanRule("EB", { name: "R", pattern: "{title}", paths: ["rule"] });
    if (isScanRuleError(rule)) throw new Error("setup failed");
    const ins = db.prepare("INSERT INTO library_items (id, library_id, type, folder_path, scan_rule_id) VALUES (?, 'EB', 'ebook', ?, ?)");
    ins.run("d1", "keep/d", null);
    ins.run("d2", "gone/d", null);
    ins.run("r1", "rule/keep", rule.id);
    ins.run("r2", "rule/gone", rule.id);

    // Default reconcile: only NULL-owned, absent items go; rule items untouched.
    reconcileOwnedItems("EB", null, new Set(["keep/d"]));
    expect(deletedAt("d1")).toBeNull();
    expect(deletedAt("d2")).not.toBeNull();
    expect(deletedAt("r1")).toBeNull();
    expect(deletedAt("r2")).toBeNull();

    // Rule reconcile: only that rule's absent items go.
    reconcileOwnedItems("EB", rule.id, new Set(["rule/keep"]));
    expect(deletedAt("r1")).toBeNull();
    expect(deletedAt("r2")).not.toBeNull();
  });
});
