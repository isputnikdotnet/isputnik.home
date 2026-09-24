import fs from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { logActivity } from "../../db.js";
import { parseBody } from "../../core/shared.js";
import { thumbnailAbsolutePath } from "../library/shared/thumbnail.js";
import { exportGedcom, importGedcom } from "./gedcom.js";
import { requireTreeView } from "./tree-access.js";
import { canEditTree, decoratePersons } from "./access.js";
import { listFamilyPersons } from "./persons.js";


const importGedcomSchema = z.object({
  gedcom: z.string().min(1),
  mode: z.enum(["add", "replace"]).optional()
});

export function registerGedcomRoutes(app: FastifyInstance) {
  // ── GEDCOM import/export ──

  // A whole-tree file is a copy of everyone's data, not a view of it: admins and
  // branch editors only, and an editor's file keeps the living relatives they
  // may not see the details of as name and relationships (tree-access.ts, D17).
  app.get("/api/family-tree/export", { preHandler: [app.authenticate, requireTreeView] }, async (request, reply) => {
    const user = request.user!;
    if (user.role !== "admin" && !canEditTree(user)) {
      return reply.code(403).send({ error: "Only admins and branch editors can export the family tree." });
    }
    const privateIds = user.role === "admin"
      ? new Set<string>()
      : new Set(decoratePersons(user, listFamilyPersons()).filter((p) => p.restricted).map((p) => p.id));
    const filename = `family-tree-${new Date().toISOString().slice(0, 10)}.ged`;
    return reply
      .header("Content-Type", "text/x-gedcom; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="${filename}"`)
      .send(exportGedcom(privateIds));
  });

  // The client sends the file's text as JSON. Fastify's default 1 MiB body
  // limit is too small for big trees, hence the per-route override.
  app.post("/api/family-tree/import", { preHandler: app.requireAdmin, bodyLimit: 32 * 1024 * 1024 }, async (request, reply) => {
    const parsed = parseBody(importGedcomSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid import request", details: parsed.error });
    }
    const outcome = importGedcom(parsed.data.gedcom, parsed.data.mode ?? "add", request.user!.id);
    if ("error" in outcome) {
      return reply.code(400).send({ error: "No people (INDI records) found — is this a GEDCOM file?" });
    }
    // Uploaded portrait files of replaced persons, removed after the commit.
    for (const key of outcome.removedPortraitKeys) {
      await fs.rm(thumbnailAbsolutePath(key), { force: true }).catch(() => {});
    }
    const { result } = outcome;
    logActivity({
      event: "familytree.imported",
      actorUserId: request.user!.id,
      targetType: "family_tree_person",
      detail: `Imported ${result.personsCreated} people and ${result.unionsCreated} families from a GEDCOM file`
        + (result.personsRemoved > 0 ? `, replacing ${result.personsRemoved} existing people.` : "."),
      ipAddress: request.ip
    });
    return reply.send(result);
  });
}
