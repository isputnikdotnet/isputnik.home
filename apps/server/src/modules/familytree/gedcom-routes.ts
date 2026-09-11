import fs from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { logActivity } from "../../db.js";
import { parseBody } from "../../core/shared.js";
import { thumbnailAbsolutePath } from "../library/shared/thumbnail.js";
import { exportGedcom, importGedcom } from "./gedcom.js";

const importGedcomSchema = z.object({
  gedcom: z.string().min(1),
  mode: z.enum(["add", "replace"]).optional()
});

export function registerGedcomRoutes(app: FastifyInstance) {
  // ── GEDCOM import/export ──

  // A read like the rest of the browse endpoints — any signed-in user already
  // sees all of this data, so any of them may download it.
  app.get("/api/family-tree/export", { preHandler: app.authenticate }, async (_request, reply) => {
    const filename = `family-tree-${new Date().toISOString().slice(0, 10)}.ged`;
    return reply
      .header("Content-Type", "text/x-gedcom; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="${filename}"`)
      .send(exportGedcom());
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
