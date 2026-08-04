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
  resolveDuplicateSelection,
  resolveAllExactGroups,
  preferredFolders,
  setPreferredFolders,
  rebuildDuplicateGroups
} from "./duplicates.js";
import {
  listDuplicateFolderGroups,
  setDuplicateFolderKeeper,
  ignoreDuplicateFolderGroup,
  resolveDuplicateFolderGroup,
  listContainedFolders,
  ignoreContainedFolder,
  resolveContainedFolder
} from "./duplicate-folders.js";

// The ONE shape the page's state is built from. Both the list and the scan route
// return exactly this, because the client assigns the response straight onto its
// state — an endpoint returning a partial object (e.g. status without `groups`)
// leaves the page rendering against undefined and takes the whole app down.
//
// `folderGroups` are a rollup of the identical-file sets, so their bytes are already
// inside `reclaimableBytes` — never add the two together.
function duplicatePayload() {
  const groups = listDuplicateGroups();
  return {
    ...duplicateScanStatus(),
    groups,
    folderGroups: listDuplicateFolderGroups(),
    containedFolders: listContainedFolders(),
    preferredFolders: preferredFolders(),
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

  // Sweep byte-identical sets at once. Deliberately not offered for the
  // near-identical tier. `libraryId` confines it to that library exactly as the admin
  // page's picker does: only sets with two or more copies there are swept, and only
  // copies there are removed, so the button clears what's on screen and never reaches
  // into a library the admin isn't looking at.
  const resolveAllSchema = z.object({ libraryId: z.string().min(1).max(64).nullish() });
  app.post("/api/library/gallery/duplicates/resolve-all", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(resolveAllSchema, request.body ?? {});
    if (parsed.error) { reply.code(400).send({ error: "Invalid request", details: parsed.error }); return; }

    const libraryId = parsed.data.libraryId ?? null;
    if (libraryId) {
      const library = db.prepare("SELECT id FROM libraries WHERE id = ? AND type = 'gallery'").get(libraryId);
      if (!library) { reply.code(404).send({ error: "No such photo library." }); return; }
    }
    reply.send(resolveAllExactGroups(request.user!.id, libraryId));
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

  // Delete an explicit selection from one set. `deleteItemIds` may name every copy,
  // which removes the picture entirely — the client warns before sending that.
  const selectionSchema = z.object({
    deleteItemIds: z.array(z.string().min(1).max(64)).min(1).max(200)
  });
  app.post("/api/library/gallery/duplicates/:id/resolve-selection", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(selectionSchema, request.body);
    if (parsed.error) { reply.code(400).send({ error: "Invalid request", details: parsed.error }); return; }
    const { id } = request.params as { id: string };
    const result = resolveDuplicateSelection(id, parsed.data.deleteItemIds, request.user!.id);
    if (!result) {
      reply.code(409).send({
        error: "These photos have changed since the last scan. Run a new scan and review the set again."
      });
      return;
    }
    reply.send(result);
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

  // ── Duplicate folders ─────────────────────────────────────────────────────
  //
  // A folder is named by (library, path) rather than an id: it has no row of its own,
  // it only exists as a prefix of the paths below it.
  const folderRefSchema = z.object({
    libraryId: z.string().min(1).max(64),
    // A folder path is bounded for the same reason the browse route bounds it: it goes
    // into a LIKE pattern, and real relative paths are short.
    folderPath: z.string().max(1024)
  });

  app.post("/api/library/gallery/duplicates/folders/:id/keeper", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(folderRefSchema, request.body);
    if (parsed.error) { reply.code(400).send({ error: "Invalid request", details: parsed.error }); return; }
    const { id } = request.params as { id: string };
    if (!setDuplicateFolderKeeper(id, parsed.data)) {
      reply.code(404).send({ error: "That folder isn't part of this set." });
      return;
    }
    reply.send({ keeper: parsed.data });
  });

  // Remove whole folders, keeping the rest. The client never sends every member — a
  // set with nothing left to keep isn't de-duplicating — and the server refuses the
  // keeper itself regardless.
  const folderResolveSchema = z.object({
    deleteFolders: z.array(folderRefSchema).min(1).max(50)
  });
  app.post("/api/library/gallery/duplicates/folders/:id/resolve", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(folderResolveSchema, request.body);
    if (parsed.error) { reply.code(400).send({ error: "Invalid request", details: parsed.error }); return; }
    const { id } = request.params as { id: string };
    const result = resolveDuplicateFolderGroup(id, parsed.data.deleteFolders, request.user!.id);
    if (!result) {
      reply.code(409).send({
        error: "These folders no longer hold exactly the same photos. Run a new scan and review the set again."
      });
      return;
    }
    reply.send(result);
  });

  // ── Contained folders ─────────────────────────────────────────────────────
  //
  // One folder, not a set: the row already names which folder goes and which one
  // covers it, so there is no keeper to choose.
  app.post("/api/library/gallery/duplicates/folders/contained/:id/resolve", { preHandler: app.requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = resolveContainedFolder(id, request.user!.id);
    if (!result) {
      reply.code(409).send({
        error: "Some photos in this folder no longer have a copy in the folder being kept. Run a new scan and review it again."
      });
      return;
    }
    reply.send(result);
  });

  app.post("/api/library/gallery/duplicates/folders/contained/:id/ignore", { preHandler: app.requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!ignoreContainedFolder(id)) {
      reply.code(404).send({ error: "No such folder." });
      return;
    }
    logActivity({
      event: "library.gallery.contained_folder_dismissed",
      actorUserId: request.user!.id,
      targetType: "library",
      targetId: null,
      detail: "Dismissed a folder whose photos all exist elsewhere; it won't be suggested again.",
      ipAddress: request.ip
    });
    reply.send({ ignored: true });
  });

  // ── Preferred folders ─────────────────────────────────────────────────────
  //
  // "When copies are in more than one place, keep the one here." Saving re-picks every
  // automatic keeper straight away — the choice is only meaningful if the page reflects
  // it — which is pure database work and costs no disk access. Keepers set by hand are
  // untouched, as they outrank the automatic choice by definition.
  const preferredSchema = z.object({
    folders: z.array(z.object({
      libraryId: z.string().min(1).max(64),
      folderPath: z.string().max(1024)
    })).max(50)
  });
  app.post("/api/library/gallery/duplicates/preferred-folders", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(preferredSchema, request.body);
    if (parsed.error) { reply.code(400).send({ error: "Invalid request", details: parsed.error }); return; }

    const known = new Set((db.prepare("SELECT id FROM libraries WHERE type = 'gallery'").all() as { id: string }[]).map((row) => row.id));
    const folders = parsed.data.folders.filter((folder) => known.has(folder.libraryId));
    setPreferredFolders(folders);
    rebuildDuplicateGroups();

    logActivity({
      event: "library.gallery.duplicate_preferences",
      actorUserId: request.user!.id,
      targetType: "library",
      targetId: null,
      detail: folders.length > 0
        ? `Set ${folders.length} preferred folder${folders.length === 1 ? "" : "s"} for keeping duplicate photos.`
        : "Cleared the preferred folders for keeping duplicate photos.",
      ipAddress: request.ip
    });
    reply.send(duplicatePayload());
  });

  app.post("/api/library/gallery/duplicates/folders/:id/ignore", { preHandler: app.requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!ignoreDuplicateFolderGroup(id)) {
      reply.code(404).send({ error: "No such duplicate folder set." });
      return;
    }
    logActivity({
      event: "library.gallery.duplicate_folders_dismissed",
      actorUserId: request.user!.id,
      targetType: "library",
      targetId: null,
      detail: "Marked a set of folders as different; those folders won't be grouped again.",
      ipAddress: request.ip
    });
    reply.send({ ignored: true });
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
