import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { db } from "../../../db.js";
import { parseBody } from "../../../core/shared.js";
import {
  listScanRules, createScanRule, updateScanRule, deleteScanRule, getScanRule, isScanRuleError,
  getDefaultLayoutRule, setDefaultLayout, scanRuleStats, folderOwnership, normalizeRulePath,
  type ScanRule, type ScanRuleStats
} from "./scan-rules.js";
import { validateLibrarySource } from "./library-source.js";
import { normalizeLibrarySettings } from "./library-settings.js";
import { relativePathWithinRoot, pathIsInside, normaliseRelativePath } from "./storage-roots.js";
import { previewEbookRulePattern, enqueueEbookScan } from "../ebook/scanner.js";
import { previewAudiobookRulePattern, enqueueAudiobookScan } from "../audiobook/scanner.js";

// Custom scan rules are a library-config action, gated to admins like rescan and
// library settings. Routes are cross-type (the rule inherits the library's type).
const layoutsField = z.array(z.string().trim().min(1).max(500)).min(1).max(10);

const ruleBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  // Ordered layouts. `pattern` is the pre-layouts form, still accepted as a one-layout list.
  layouts: layoutsField.optional(),
  pattern: z.string().trim().min(1).max(500).optional(),
  preset: z.string().trim().max(64).nullable().optional(),
  enabled: z.boolean().optional(),
  // An entry may be "" (the library root); normalizePaths keeps it as a whole-library anchor.
  paths: z.array(z.string().trim().max(1000)).min(1).max(200)
}).refine((body) => body.layouts !== undefined || body.pattern !== undefined, { message: "Enter a pattern." });

const defaultLayoutSchema = z.object({
  layouts: layoutsField,
  preset: z.string().trim().max(64).nullable().optional(),
  enabled: z.boolean().optional()
});

const previewSchema = z.object({
  layouts: layoutsField.optional(),
  pattern: z.string().trim().min(1).max(500).optional(),
  paths: z.array(z.string().trim().max(1000)).min(1).max(200),
  // The rule being edited, so the preview can tell "already this rule's" from "moves".
  ruleId: z.string().trim().max(64).nullable().optional()
}).refine((body) => body.layouts !== undefined || body.pattern !== undefined, { message: "Enter a pattern." });

type RuleWithStats = ScanRule & ScanRuleStats;

export async function scanRulesPlugin(app: FastifyInstance) {
  const findLibrary = (id: string) =>
    db.prepare("SELECT id, type, source_path FROM libraries WHERE id = ?").get(id) as { id: string; type: string; source_path: string } | undefined;

  // The validated source root, or null when the folder is currently unreachable
  // (the rule list still renders; folder existence just isn't checked).
  const sourceRootOrNull = (sourcePath: string): string | null => {
    try { return validateLibrarySource(sourcePath); } catch { return null; }
  };

  const withStats = (rule: ScanRule, root: string | null): RuleWithStats => ({ ...rule, ...scanRuleStats(rule, root) });

  app.get("/api/library/libraries/:id/scan-rules", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const library = findLibrary(id);
    if (!library) { return reply.code(404).send({ error: "Library not found" }); }
    const root = sourceRootOrNull(library.source_path);
    const rules = listScanRules(id).map((rule) => withStats(rule, root));
    const defaultLayout = rules.find((rule) => rule.isDefault) ?? null;
    return reply.send({ rules, defaultLayout });
  });

  app.post("/api/library/libraries/:id/scan-rules", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!findLibrary(id)) { return reply.code(404).send({ error: "Library not found" }); }
    const parsed = parseBody(ruleBodySchema, request.body);
    if (parsed.error) { return reply.code(400).send({ error: "Invalid scan rule", details: parsed.error }); }
    const result = createScanRule(id, parsed.data);
    if (isScanRuleError(result)) { return reply.code(400).send(result); }
    return reply.send({ rule: result });
  });

  app.patch("/api/library/libraries/:id/scan-rules/:ruleId", { preHandler: app.requireAdmin }, async (request, reply) => {
    const { id, ruleId } = request.params as { id: string; ruleId: string };
    const existing = getScanRule(ruleId);
    if (!existing || existing.libraryId !== id) { return reply.code(404).send({ error: "Scan rule not found" }); }
    const parsed = parseBody(ruleBodySchema, request.body);
    if (parsed.error) { return reply.code(400).send({ error: "Invalid scan rule", details: parsed.error }); }
    const result = updateScanRule(ruleId, parsed.data);
    if (isScanRuleError(result)) { return reply.code(400).send(result); }
    return reply.send({ rule: result });
  });

  app.delete("/api/library/libraries/:id/scan-rules/:ruleId", { preHandler: app.requireAdmin }, async (request, reply) => {
    const { id, ruleId } = request.params as { id: string; ruleId: string };
    const existing = getScanRule(ruleId);
    if (!existing || existing.libraryId !== id) { return reply.code(404).send({ error: "Scan rule not found" }); }
    if (existing.isDefault) {
      return reply.code(400).send({ error: "The default layout cannot be deleted. Edit it, or turn it off to fall back to the scanner defaults." });
    }
    deleteScanRule(ruleId);
    return reply.send({ deleted: true });
  });

  // The library's default layout: the rule anchored at the root. GET returns null
  // when the library still runs on scanner defaults; PUT creates or replaces it.
  app.get("/api/library/libraries/:id/default-layout", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const library = findLibrary(id);
    if (!library) { return reply.code(404).send({ error: "Library not found" }); }
    const rule = getDefaultLayoutRule(id);
    return reply.send({ rule: rule ? withStats(rule, sourceRootOrNull(library.source_path)) : null });
  });

  app.put("/api/library/libraries/:id/default-layout", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!findLibrary(id)) { return reply.code(404).send({ error: "Library not found" }); }
    const parsed = parseBody(defaultLayoutSchema, request.body);
    if (parsed.error) { return reply.code(400).send({ error: "Invalid default layout", details: parsed.error }); }
    const result = setDefaultLayout(id, parsed.data);
    if (isScanRuleError(result)) { return reply.code(400).send(result); }
    return reply.send({ rule: result });
  });

  // Browse subfolders under the library source so the rule editor can pick rule
  // folders. Same containment + symlink-escape guard as the storage browser. Each
  // folder carries how many catalogued books sit under it today and which rule
  // owns it, so the picker can show counts and lock badges in one round trip.
  app.get("/api/library/libraries/:id/folders", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const library = findLibrary(id);
    if (!library) { return reply.code(404).send({ error: "Library not found" }); }
    const requested = typeof (request.query as { path?: string }).path === "string" ? (request.query as { path?: string }).path! : "";
    try {
      const root = validateLibrarySource(library.source_path);
      const currentPath = relativePathWithinRoot(root, requested);
      const itemPaths = (db.prepare("SELECT folder_path FROM library_items WHERE library_id = ? AND deleted_at IS NULL")
        .all(id) as { folder_path: string }[]).map((row) => row.folder_path);
      const booksUnder = (rel: string) => rel === ""
        ? itemPaths.length
        : itemPaths.reduce((n, p) => n + (p === rel || p.startsWith(`${rel}/`) ? 1 : 0), 0);
      const folders = fs.readdirSync(currentPath, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .flatMap((entry) => {
          const abs = path.join(currentPath, entry.name);
          try {
            const real = fs.realpathSync(abs);
            if (!pathIsInside(real, root) || !fs.statSync(real).isDirectory()) return [];
            const relativePath = normaliseRelativePath(path.relative(root, real));
            return [{ name: entry.name, relativePath, books: booksUnder(relativePath), ownedBy: folderOwnership(id, relativePath) }];
          } catch {
            return [];
          }
        })
        .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));
      const currentRelative = normaliseRelativePath(path.relative(root, currentPath));
      const parent = currentPath === root ? null : normaliseRelativePath(path.relative(root, path.dirname(currentPath)));
      return reply.send({
        path: currentRelative, parent, folders,
        books: booksUnder(normalizeRulePath(currentRelative)),
        ownedBy: folderOwnership(id, currentRelative),
        totalBooks: itemPaths.length
      });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : "Unable to browse folders" });
    }
  });

  // Representative paths under the chosen folders for the layout builder to label:
  // one per distinct shape (depth, whether the leaf carries a separator, and for
  // audiobooks whether disc-like folders sit below), so the user sees every kind of
  // path the folders hold without scrolling a full listing. Paths are relative to
  // their anchor, which is what the layouts are read against.
  app.get("/api/library/libraries/:id/scan-rules/examples", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const library = findLibrary(id);
    if (!library) { return reply.code(404).send({ error: "Library not found" }); }
    if (library.type !== "ebook" && library.type !== "audiobook") {
      return reply.code(400).send({ error: "Scan rules apply to ebook and audiobook libraries." });
    }
    const raw = (request.query as { paths?: string }).paths ?? "";
    const anchors = raw.split("\n").map((p) => normalizeRulePath(p)).filter((p, i, all) => all.indexOf(p) === i);
    if (anchors.length === 0) anchors.push("");
    try {
      const root = validateLibrarySource(library.source_path);
      const settingsRow = db.prepare("SELECT settings_json FROM libraries WHERE id = ?").get(id) as { settings_json: string };
      const extensions = new Set(normalizeLibrarySettings(library.type, settingsRow.settings_json).scan_extensions.map((e) => `.${e}`));
      return reply.send({ examples: sampleLayoutExamples(root, anchors, extensions, library.type) });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : "Unable to read folders" });
    }
  });

  // Read-only dry run: how the layouts would parse the selected folders. No writes.
  app.post("/api/library/libraries/:id/scan-rules/preview", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const library = findLibrary(id);
    if (!library) { return reply.code(404).send({ error: "Library not found" }); }
    if (library.type !== "ebook" && library.type !== "audiobook") {
      return reply.code(400).send({ error: "Scan rules apply to ebook and audiobook libraries." });
    }
    const parsed = parseBody(previewSchema, request.body);
    if (parsed.error) { return reply.code(400).send({ error: "Invalid preview request", details: parsed.error }); }
    const layouts = parsed.data.layouts ?? [parsed.data.pattern!];
    try {
      const rows = library.type === "audiobook"
        ? await previewAudiobookRulePattern(id, parsed.data.paths, layouts, parsed.data.ruleId ?? null)
        : previewEbookRulePattern(id, parsed.data.paths, layouts, parsed.data.ruleId ?? null);
      return reply.send({ rows });
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : "Preview failed" });
    }
  });

  // Scan just this rule's folders: walks them, re-derives their books, and
  // reconciles only the rule's own items. The rest of the library is untouched.
  app.post("/api/library/libraries/:id/scan-rules/:ruleId/scan", { preHandler: app.requireAdmin }, async (request, reply) => {
    const { id, ruleId } = request.params as { id: string; ruleId: string };
    const library = findLibrary(id);
    if (!library) { return reply.code(404).send({ error: "Library not found" }); }
    const rule = getScanRule(ruleId);
    if (!rule || rule.libraryId !== id) { return reply.code(404).send({ error: "Scan rule not found" }); }
    if (!rule.enabled) { return reply.code(400).send({ error: "Turn the rule on before scanning its folders." }); }
    if (library.type !== "ebook" && library.type !== "audiobook") {
      return reply.code(400).send({ error: "Scan rules apply to ebook and audiobook libraries." });
    }
    try {
      validateLibrarySource(library.source_path);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : "Library source is not accessible" });
    }
    const jobId = library.type === "audiobook" ? enqueueAudiobookScan(id, { ruleId }) : enqueueEbookScan(id, { ruleId });
    return reply.send({ queued: true, jobId });
  });
}

export interface LayoutExample { anchor: string; path: string }

const DISC_LIKE = /^(cd|disc|disk|part|часть|диск)\s*\d+$/i;

// Walk each anchor for content files (bounded), then keep one path per shape.
export function sampleLayoutExamples(
  root: string,
  anchors: string[],
  extensions: Set<string>,
  type: string,
  limit = 12
): LayoutExample[] {
  const out: LayoutExample[] = [];
  const seen = new Set<string>();
  const MAX_FILES = 4000;
  for (const anchor of anchors) {
    const anchorAbs = anchor ? path.join(root, ...anchor.split("/")) : root;
    let visited = 0;
    const walk = (dir: string, rel: string[]) => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      for (const entry of entries) {
        if (visited >= MAX_FILES || out.length >= limit) return;
        if (entry.name.startsWith(".")) continue;
        if (entry.isDirectory()) { walk(path.join(dir, entry.name), [...rel, entry.name]); continue; }
        if (!entry.isFile()) continue;
        visited += 1;
        const ext = path.extname(entry.name).toLowerCase();
        if (!extensions.has(ext)) continue;
        const dirs = rel;
        const leaf = type === "ebook" ? path.basename(entry.name, ext) : dirs[dirs.length - 1] ?? "";
        const shape = [
          dirs.length,
          / - |_|\(|\[/.test(leaf) ? "sep" : "plain",
          type === "audiobook" ? dirs.map((d) => DISC_LIKE.test(d) ? "d" : "x").join("") : ""
        ].join(":");
        if (seen.has(shape)) continue;
        seen.add(shape);
        out.push({ anchor, path: [...dirs, entry.name].join("/") });
      }
    };
    walk(anchorAbs, []);
    if (out.length >= limit) break;
  }
  return out;
}
