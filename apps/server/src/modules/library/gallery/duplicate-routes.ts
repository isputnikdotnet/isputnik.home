// Admin API for duplicate photos (duplicates.ts). Admin-only throughout: a duplicate
// set spans libraries, so deciding which copy survives is a whole-install decision, not
// one scoped to whatever libraries the caller happens to see.
//
// Nothing here deletes directly — resolve routes go through resolveDuplicateGroup, which
// re-validates the digests, merges the losing copies' metadata onto the keeper, and
// moves the rest to the Recycle Bin.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, logActivity } from "../../../db.js";
import { parseBody } from "../../../core/shared.js";
import {
  listDuplicateGroups,
  duplicateScanStatus,
  enqueueDuplicateScan,
  processDuplicateScanQueue,
  setDuplicateKeeper,
  ignoreDuplicateGroup,
  resolveDuplicateGroup,
  resolveAllExactGroups
} from "./duplicates.js";

// The ONE shape the page's state is built from. Both the list and the scan route
// return exactly this, because the client assigns the response straight onto its
// state — an endpoint returning a partial object (e.g. status without `groups`)
// leaves the page rendering against undefined and takes the whole app down.
function duplicatePayload() {
  const groups = listDuplicateGroups();
  return {
    ...duplicateScanStatus(),
    groups,
    reclaimableBytes: groups.reduce((sum, g) => sum + g.reclaimableBytes, 0)
  };
}

export async function galleryDuplicateRoutesPlugin(app: FastifyInstance) {
  app.get("/api/library/gallery/duplicates", { preHandler: app.requireAdmin }, async () => {
    return duplicatePayload();
  });

  // Queue a scan and nudge the worker so it starts without waiting for the next poll.
  // `libraryId` narrows only which files are read from disk; the sets it produces are
  // always rebuilt across every library.
  const scanSchema = z.object({ libraryId: z.string().min(1).max(64).nullish() });
  app.post("/api/library/gallery/duplicates/scan", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(scanSchema, request.body ?? {});
    if (parsed.error) { reply.code(400).send({ error: "Invalid request", details: parsed.error }); return; }

    const libraryId = parsed.data.libraryId ?? null;
    const library = libraryId
      ? db.prepare("SELECT id, name FROM libraries WHERE id = ? AND type = 'gallery'")
          .get(libraryId) as { id: string; name: string } | undefined
      : undefined;
    if (libraryId && !library) {
      reply.code(404).send({ error: "No such photo library." });
      return;
    }

    const queued = enqueueDuplicateScan(libraryId);
    if (queued) {
      logActivity({
        event: "library.gallery.duplicate_scan",
        actorUserId: request.user!.id,
        targetType: "library",
        targetId: libraryId,
        detail: library
          ? `Started a duplicate photo scan of "${library.name}".`
          : "Started a duplicate photo scan of every photo library.",
        ipAddress: request.ip
      });
      void processDuplicateScanQueue().catch(() => { /* logged per-job */ });
    }
    reply.send({ queued, ...duplicatePayload() });
  });

  // Sweep every byte-identical set at once. Deliberately not offered for the
  // near-identical tier.
  app.post("/api/library/gallery/duplicates/resolve-all", { preHandler: app.requireAdmin }, async (request) => {
    return resolveAllExactGroups(request.user!.id);
  });

  const keeperSchema = z.object({ itemId: z.string().min(1).max(64) });
  app.post("/api/library/gallery/duplicates/:id/keeper", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(keeperSchema, request.body);
    if (parsed.error) { reply.code(400).send({ error: "Invalid request", details: parsed.error }); return; }
    const { id } = request.params as { id: string };
    if (!setDuplicateKeeper(id, parsed.data.itemId)) {
      reply.code(404).send({ error: "That photo isn't part of this duplicate set." });
      return;
    }
    reply.send({ keeperItemId: parsed.data.itemId });
  });

  app.post("/api/library/gallery/duplicates/:id/resolve", { preHandler: app.requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = resolveDuplicateGroup(id, request.user!.id);
    if (!result) {
      // Stale view: a copy changed or vanished between the scan and the click. Say so
      // rather than guessing a new keeper — the admin re-scans and decides again.
      reply.code(409).send({
        error: "These photos have changed since the last scan. Run a new scan and review the set again."
      });
      return;
    }
    reply.send(result);
  });

  app.post("/api/library/gallery/duplicates/:id/ignore", { preHandler: app.requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!ignoreDuplicateGroup(id)) {
      reply.code(404).send({ error: "No such duplicate set." });
      return;
    }
    logActivity({
      event: "library.gallery.duplicates_dismissed",
      actorUserId: request.user!.id,
      targetType: "library",
      targetId: null,
      detail: "Marked a duplicate set as \"not duplicates\"; those photos won't be grouped again.",
      ipAddress: request.ip
    });
    reply.send({ ignored: true });
  });
}
