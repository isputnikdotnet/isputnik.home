// Package export and import (docs/family-tree-exchange-plan.md). Admin only: a
// package is a copy of everyone's data and their photos.
//
//   GET    /api/family-tree/export/package                  stream the zip
//   POST   /api/family-tree/import/package                  upload → token + preview (writes nothing)
//   POST   /api/family-tree/import/package/:token/preview   re-plan with the admin's decisions
//   POST   /api/family-tree/import/package/:token/apply     write it
//   DELETE /api/family-tree/import/package/:token           forget the upload
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { logActivity } from "../../../db.js";
import { parseBody } from "../../../core/shared.js";
import { buildPackage, writePackage } from "./export.js";
import { planImport, type ImportDecisions } from "./import-plan.js";
import { applyImportPlan } from "./import-apply.js";
import { discardPendingImport, getPendingImport, PackageError, receivePackage } from "./pending.js";

const decisionsSchema = z.object({
  mode: z.enum(["migrate", "replace"]).default("migrate"),
  persons: z.record(
    z.string().min(1).max(64),
    z.object({
      action: z.enum(["add", "skip", "merge", "usePackage", "keepMine"]),
      matchId: z.string().min(1).max(64).nullable().optional()
    })
  ).default({})
});

const DEFAULT_DECISIONS: ImportDecisions = { mode: "migrate", persons: {} };

export function registerPackageRoutes(app: FastifyInstance) {
  app.get("/api/family-tree/export/package", { preHandler: app.requireAdmin }, async (request, reply) => {
    const build = await buildPackage();
    const filename = `family-tree-${new Date().toISOString().slice(0, 10)}.zip`;
    logActivity({
      event: "familytree.exported",
      actorUserId: request.user!.id,
      targetType: "family_tree_person",
      detail: `Exported the family tree as a package: ${build.manifest.counts?.persons ?? 0} people, ${build.manifest.counts?.photos ?? 0} photos.`,
      ipAddress: request.ip
    });
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-cache"
    });
    try {
      await writePackage(build, reply.raw);
    } catch (err) {
      request.log.warn({ err }, "Family-tree package export failed mid-stream.");
      reply.raw.destroy(err instanceof Error ? err : new Error(String(err)));
    }
  });

  app.post("/api/family-tree/import/package", { preHandler: app.requireAdmin }, async (request, reply) => {
    let entry;
    try {
      entry = await receivePackage(request, request.user!.id);
    } catch (err) {
      if (err instanceof PackageError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
    const plan = planImport(entry.tree, entry.manifest.sourceServer, DEFAULT_DECISIONS);
    return reply.send({
      token: entry.token,
      package: {
        exportedAt: entry.manifest.exportedAt,
        appVersion: entry.manifest.appVersion ?? null,
        counts: entry.manifest.counts ?? {}
      },
      preview: plan.preview
    });
  });

  app.post("/api/family-tree/import/package/:token/preview", { preHandler: app.requireAdmin }, async (request, reply) => {
    const entry = getPendingImport((request.params as { token: string }).token, request.user!.id);
    if (!entry) return reply.code(404).send({ error: "This upload has expired. Choose the package again." });
    const parsed = parseBody(decisionsSchema, request.body ?? {});
    if (parsed.error) return reply.code(400).send({ error: "Invalid import decisions", details: parsed.error });
    return reply.send({ preview: planImport(entry.tree, entry.manifest.sourceServer, parsed.data).preview });
  });

  app.post("/api/family-tree/import/package/:token/apply", { preHandler: app.requireAdmin }, async (request, reply) => {
    const token = (request.params as { token: string }).token;
    const entry = getPendingImport(token, request.user!.id);
    if (!entry) return reply.code(404).send({ error: "This upload has expired. Choose the package again." });
    const parsed = parseBody(decisionsSchema, request.body ?? {});
    if (parsed.error) return reply.code(400).send({ error: "Invalid import decisions", details: parsed.error });
    const plan = planImport(entry.tree, entry.manifest.sourceServer, parsed.data);
    let result;
    try {
      result = await applyImportPlan(plan, entry.packagePath, entry.stagingDir, request.user!.id);
    } finally {
      discardPendingImport(token);
    }
    const s = result.summary;
    logActivity({
      event: "familytree.imported",
      actorUserId: request.user!.id,
      targetType: "family_tree_person",
      detail: `Imported a family-tree package (${result.mode}): ${s.personsCreated} people added, ${s.personsMatched} matched, `
        + `${s.unionsCreated} families, ${s.photosImported} photos`
        + (s.personsRemoved > 0 ? `, replacing ${s.personsRemoved} existing people.` : "."),
      ipAddress: request.ip
    });
    return reply.send(result);
  });

  app.delete("/api/family-tree/import/package/:token", { preHandler: app.requireAdmin }, async (request, reply) => {
    const token = (request.params as { token: string }).token;
    if (getPendingImport(token, request.user!.id)) discardPendingImport(token);
    return reply.code(204).send();
  });
}
