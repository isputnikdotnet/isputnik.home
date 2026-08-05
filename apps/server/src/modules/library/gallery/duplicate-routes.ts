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
  searchDuplicateGroups,
  sweepableGroupIds,
  duplicateSetFolders,
  duplicateReclaimableBytes,
  type DuplicateSearch,
  duplicateScanStatus,
  enqueueDuplicateScan,
  processDuplicateScanQueue,
  setDuplicateKeeper,
  ignoreDuplicateGroup,
  resolveDuplicateGroup,
  resolveDuplicateSelection,
  resolveAllExactGroups,
  folderPreferences,
  setFolderPreferences,
  rebuildDuplicateGroups
} from "./duplicates.js";
import {
  searchFolderMatches,
  folderAnswerSummary,
  setDuplicateFolderKeeper,
  ignoreDuplicateFolderGroup,
  resolveDuplicateFolderGroup,
  ignoreContainedFolder,
  resolveContainedFolder,
  resolveFolderOverlap,
  ignoreFolderOverlap,
  type ContainedRefusal,
  type OverlapRefusal,
  type FolderSearch
} from "./duplicate-folders.js";

// The ONE shape the page's state is built from. Both the list and the scan route
// return exactly this, because the client assigns the response straight onto its
// state — an endpoint returning a partial object (e.g. status without `groups`)
// leaves the page rendering against undefined and takes the whole app down.
//
// `folderGroups` are a rollup of the identical-file sets, so their bytes are already
// inside `reclaimableBytes` — never add the two together.
// The page-level state every duplicate tab shares: the scan, the standing folder
// instructions, and the filter box's vocabulary. No lists — all three are paged now,
// and building them here was the whole problem.
function duplicatePayload() {
  const summary = folderAnswerSummary();

  // The filter box's folder list: the folders duplicated PHOTOS sit in, plus the
  // folders the two folder answers name.
  const options = new Map(duplicateSetFolders().map((option) => [option.key, option]));
  for (const folder of summary.folders) {
    const key = `${folder.libraryId} ${folder.folderPath}`;
    const existing = options.get(key);
    if (existing) existing.setCount += 1;
    else options.set(key, { key, ...folder, setCount: 1 });
  }

  return {
    ...duplicateScanStatus(),
    folderPreferences: folderPreferences(),
    folderOptions: [...options.values()].sort((a, b) =>
      a.libraryName.localeCompare(b.libraryName) || a.folderPath.localeCompare(b.folderPath)),
    /** How many of each folder answer there are — the photo page links with these. */
    folderSetCount: summary.folderSets,
    containedCount: summary.containedRowCount,
    overlapCount: summary.overlapCount,
    reclaimableBytes: duplicateReclaimableBytes()
  };
}

// The filters the page narrows by, as a query string. `folders` is JSON because a
// folder path may contain anything a filesystem allows, including whatever separator
// a flatter encoding would have picked.
const searchSchema = z.object({
  library: z.string().trim().max(64).optional(),
  tier: z.enum(["all", "exact", "near"]).optional(),
  kind: z.enum(["all", "photo", "video"]).optional(),
  q: z.string().max(200).optional(),
  // The photo tab's orders, then the folder tabs'.
  sort: z.enum(["recent", "size", "copies", "identical", "name", "newest", "photos"]).optional(),
  folders: z.string().max(20000).optional(),
  page: z.coerce.number().int().min(1).max(100000).optional(),
  perPage: z.coerce.number().int().min(0).max(500).optional()
});

type ParsedSearch = DuplicateSearch & { rawSort?: string };

function parseSearch(raw: unknown): ParsedSearch | { error: string } {
  const parsed = searchSchema.safeParse(raw ?? {});
  if (!parsed.success) return { error: "Invalid filters" };
  const data = parsed.data;

  let folders: { libraryId: string; folderPath: string }[] = [];
  if (data.folders) {
    try {
      const decoded = JSON.parse(data.folders) as unknown;
      if (!Array.isArray(decoded)) return { error: "Invalid folder filter" };
      folders = decoded.slice(0, 500).map((entry) => {
        const pair = entry as { libraryId?: unknown; folderPath?: unknown };
        return {
          libraryId: typeof pair.libraryId === "string" ? pair.libraryId : "",
          folderPath: typeof pair.folderPath === "string" ? pair.folderPath : ""
        };
      }).filter((pair) => pair.libraryId !== "");
    } catch {
      return { error: "Invalid folder filter" };
    }
  }

  // The two families of tab order overlap only in "size" and "name"; each route takes
  // the ones it knows and falls back to its own default for the rest.
  const photoSorts = ["recent", "size", "copies", "identical", "name"] as const;
  return {
    libraryId: data.library || null,
    tier: data.tier,
    mediaKind: data.kind,
    search: data.q,
    sort: (photoSorts as readonly string[]).includes(data.sort ?? "")
      ? data.sort as DuplicateSearch["sort"]
      : undefined,
    rawSort: data.sort,
    folders,
    page: data.page,
    perPage: data.perPage
  };
}

export async function galleryDuplicateRoutesPlugin(app: FastifyInstance) {
  app.get("/api/library/gallery/duplicates", { preHandler: app.requireAdmin }, async () => {
    return duplicatePayload();
  });

  // One page of photo sets, filtered and ordered by the server. The whole-payload
  // route above stays for the folder tabs and the scan status, which are small; this
  // is the one that used to describe every set in the install on every load.
  app.get("/api/library/gallery/duplicates/search", { preHandler: app.requireAdmin }, async (request, reply) => {
    const query = parseSearch(request.query);
    if ("error" in query) { reply.code(400).send({ error: query.error }); return; }
    reply.send(searchDuplicateGroups(query));
  });

  // What "Delete all extras" would cover, as explicit ids: the page confirms this
  // exact count and then names them, so the destructive route below still acts on a
  // list rather than on a filter re-run at delete time.
  app.get("/api/library/gallery/duplicates/sweep-ids", { preHandler: app.requireAdmin }, async (request, reply) => {
    const query = parseSearch(request.query);
    if ("error" in query) { reply.code(400).send({ error: query.error }); return; }
    reply.send(sweepableGroupIds(query));
  });

  // The two folder answers, paged the same way. Their cards are the expensive ones —
  // a link count over what may be an entire library — so they are built for the ten
  // on screen rather than for every folder the scan found.
  const folderQuery = (raw: unknown): FolderSearch | { error: string } => {
    const parsed = parseSearch(raw);
    if ("error" in parsed) return parsed;
    const folderSorts = ["newest", "photos", "size", "name"] as const;
    return {
      libraryId: parsed.libraryId,
      folders: parsed.folders,
      search: parsed.search,
      sort: (folderSorts as readonly string[]).includes(parsed.rawSort ?? "")
        ? parsed.rawSort as FolderSearch["sort"]
        : "newest",
      page: parsed.page,
      perPage: parsed.perPage
    };
  };

  // ONE list for all three folder answers — identical, stored elsewhere, and
  // overlapping — strongest statement first. The contained search kept its old
  // address for a release; both now serve the merged page.
  app.get("/api/library/gallery/duplicates/folders/search", { preHandler: app.requireAdmin }, async (request, reply) => {
    const query = folderQuery(request.query);
    if ("error" in query) { reply.code(400).send({ error: query.error }); return; }
    reply.send(searchFolderMatches(query));
  });

  // Delete the shared copies from an overlap pair's losing side. Which side loses is
  // re-derived at this moment — protected library first, then the saved Keep/Clear
  // instructions — so a policy changed since the page rendered is honoured.
  const OVERLAP_REFUSALS: Record<OverlapRefusal, { code: number; error: string }> = {
    missing: { code: 404, error: "This pair is no longer on the list — it has already been resolved or dismissed." },
    nothing_shared: {
      code: 409,
      error: "These folders no longer share any photos, so there is nothing to delete. The pair has been taken off the list."
    },
    protected: {
      code: 403,
      error: "Both folders are in libraries that don't allow deleting, so neither side's copies can be removed."
    }
  };

  app.post("/api/library/gallery/duplicates/folders/overlaps/:id/resolve", { preHandler: app.requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const outcome = resolveFolderOverlap(id, request.user!.id);
    if (!outcome.ok) {
      const refusal = OVERLAP_REFUSALS[outcome.refused];
      reply.code(refusal.code).send({ error: refusal.error });
      return;
    }
    reply.send(outcome.resolution);
  });

  app.post("/api/library/gallery/duplicates/folders/overlaps/:id/ignore", { preHandler: app.requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!ignoreFolderOverlap(id)) {
      reply.code(404).send({ error: "No such pair." });
      return;
    }
    logActivity({
      event: "library.gallery.folder_overlap_dismissed",
      actorUserId: request.user!.id,
      targetType: "library",
      targetId: null,
      detail: "Dismissed a pair of folders that share some photos; they won't be paired again.",
      ipAddress: request.ip
    });
    reply.send({ ignored: true });
  });

  // Rebuild the results from the digests already stored, without reading a single
  // file. Every list on these pages is a derived cache, so anything that looks stale
  // — a set that shouldn't be there, a keeper that ignored a preference, two sections
  // showing the same pair — is answered by recomputing rather than by a full rescan,
  // which would re-read the library for no reason.
  app.post("/api/library/gallery/duplicates/rebuild", { preHandler: app.requireAdmin }, async (request, reply) => {
    const totals = rebuildDuplicateGroups();
    logActivity({
      event: "library.gallery.duplicates_rebuilt",
      actorUserId: request.user!.id,
      targetType: "library",
      targetId: null,
      detail: `Rebuilt duplicate results from the stored digests: ${totals.groups} photo sets, ${totals.folders.groups} folder sets, ${totals.contained.folders} folders stored elsewhere, ${totals.overlaps.pairs} overlapping pairs.`,
      ipAddress: request.ip
    });
    reply.send(duplicatePayload());
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
  // `groupIds` narrows the sweep to the sets the page is showing. The page always
  // sends them, so the button clears what a person can actually see rather than
  // everything a scan found; omitting them keeps the old whole-install behaviour.
  const resolveAllSchema = z.object({
    libraryId: z.string().min(1).max(64).nullish(),
    groupIds: z.array(z.string().min(1).max(64)).max(5000).nullish()
  });
  app.post("/api/library/gallery/duplicates/resolve-all", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(resolveAllSchema, request.body ?? {});
    if (parsed.error) { reply.code(400).send({ error: "Invalid request", details: parsed.error }); return; }

    const libraryId = parsed.data.libraryId ?? null;
    if (libraryId) {
      const library = db.prepare("SELECT id FROM libraries WHERE id = ? AND type = 'gallery'").get(libraryId);
      if (!library) { reply.code(404).send({ error: "No such photo library." }); return; }
    }
    reply.send(resolveAllExactGroups(request.user!.id, libraryId, parsed.data.groupIds ?? null));
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
  // Three ways this is refused and they mean different things to whoever is looking
  // at the page. "The copies are gone" sends someone hunting for lost photos; on a
  // folder that is simply already empty there is nothing to hunt for.
  const REFUSALS: Record<ContainedRefusal, { code: number; error: string }> = {
    missing: { code: 404, error: "This folder is no longer on the list — it has already been removed or dismissed." },
    empty: {
      code: 409,
      error: "This folder holds no photos any more, so there is nothing to delete. It has been taken off the list."
    },
    uncovered: {
      code: 409,
      error: "Some photos in this folder no longer have a copy in the folder being kept. Run a new scan and review it again."
    }
  };

  app.post("/api/library/gallery/duplicates/folders/contained/:id/resolve", { preHandler: app.requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const outcome = resolveContainedFolder(id, request.user!.id);
    if (!outcome.ok) {
      const refusal = REFUSALS[outcome.refused];
      reply.code(refusal.code).send({ error: refusal.error });
      return;
    }
    reply.send(outcome.resolution);
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
      folderPath: z.string().max(1024),
      mode: z.enum(["keep", "clear"])
    })).max(50)
  });
  app.post("/api/library/gallery/duplicates/preferred-folders", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(preferredSchema, request.body);
    if (parsed.error) { reply.code(400).send({ error: "Invalid request", details: parsed.error }); return; }

    const known = new Set((db.prepare("SELECT id FROM libraries WHERE type = 'gallery'").all() as { id: string }[]).map((row) => row.id));
    const folders = parsed.data.folders.filter((folder) => known.has(folder.libraryId));
    setFolderPreferences(folders);
    rebuildDuplicateGroups();

    const keeping = folders.filter((folder) => folder.mode === "keep").length;
    const clearing = folders.length - keeping;
    logActivity({
      event: "library.gallery.duplicate_preferences",
      actorUserId: request.user!.id,
      targetType: "library",
      targetId: null,
      detail: folders.length > 0
        ? `Duplicate handling: keeping copies in ${keeping} folder${keeping === 1 ? "" : "s"}, clearing out ${clearing}.`
        : "Cleared every folder preference for duplicate photos.",
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
