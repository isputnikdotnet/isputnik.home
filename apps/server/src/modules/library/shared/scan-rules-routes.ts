import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../../../db.js";
import { parseBody } from "../../../core/shared.js";
import {
  listScanRules, createScanRule, updateScanRule, deleteScanRule, getScanRule, isScanRuleError
} from "./scan-rules.js";
import { previewEbookRulePattern } from "../ebook/scanner.js";

// Custom scan rules are a library-config action, gated to admins like rescan and
// library settings. Routes are cross-type (the rule inherits the library's type).
const ruleBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  pattern: z.string().trim().min(1).max(500),
  preset: z.string().trim().max(64).nullable().optional(),
  enabled: z.boolean().optional(),
  paths: z.array(z.string().trim().min(1).max(1000)).min(1).max(200)
});

const previewSchema = z.object({
  pattern: z.string().trim().min(1).max(500),
  paths: z.array(z.string().trim().min(1).max(1000)).min(1).max(200)
});

export async function scanRulesPlugin(app: FastifyInstance) {
  const findLibrary = (id: string) =>
    db.prepare("SELECT id, type FROM libraries WHERE id = ?").get(id) as { id: string; type: string } | undefined;

  app.get("/api/library/libraries/:id/scan-rules", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!findLibrary(id)) { reply.code(404).send({ error: "Library not found" }); return; }
    reply.send({ rules: listScanRules(id) });
  });

  app.post("/api/library/libraries/:id/scan-rules", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!findLibrary(id)) { reply.code(404).send({ error: "Library not found" }); return; }
    const parsed = parseBody(ruleBodySchema, request.body);
    if (parsed.error) { reply.code(400).send({ error: "Invalid scan rule", details: parsed.error }); return; }
    const result = createScanRule(id, parsed.data);
    if (isScanRuleError(result)) { reply.code(400).send(result); return; }
    reply.send({ rule: result });
  });

  app.patch("/api/library/libraries/:id/scan-rules/:ruleId", { preHandler: app.requireAdmin }, async (request, reply) => {
    const { id, ruleId } = request.params as { id: string; ruleId: string };
    const existing = getScanRule(ruleId);
    if (!existing || existing.libraryId !== id) { reply.code(404).send({ error: "Scan rule not found" }); return; }
    const parsed = parseBody(ruleBodySchema, request.body);
    if (parsed.error) { reply.code(400).send({ error: "Invalid scan rule", details: parsed.error }); return; }
    const result = updateScanRule(ruleId, parsed.data);
    if (isScanRuleError(result)) { reply.code(400).send(result); return; }
    reply.send({ rule: result });
  });

  app.delete("/api/library/libraries/:id/scan-rules/:ruleId", { preHandler: app.requireAdmin }, async (request, reply) => {
    const { id, ruleId } = request.params as { id: string; ruleId: string };
    const existing = getScanRule(ruleId);
    if (!existing || existing.libraryId !== id) { reply.code(404).send({ error: "Scan rule not found" }); return; }
    deleteScanRule(ruleId);
    reply.send({ deleted: true });
  });

  // Read-only dry run: how the pattern would parse the selected folders. No writes.
  app.post("/api/library/libraries/:id/scan-rules/preview", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const library = findLibrary(id);
    if (!library) { reply.code(404).send({ error: "Library not found" }); return; }
    if (library.type !== "ebook") {
      reply.code(400).send({ error: "Preview is currently available for ebook libraries only." });
      return;
    }
    const parsed = parseBody(previewSchema, request.body);
    if (parsed.error) { reply.code(400).send({ error: "Invalid preview request", details: parsed.error }); return; }
    try {
      reply.send({ rows: previewEbookRulePattern(id, parsed.data.paths, parsed.data.pattern, 50) });
    } catch (err) {
      reply.code(502).send({ error: err instanceof Error ? err.message : "Preview failed" });
    }
  });
}
