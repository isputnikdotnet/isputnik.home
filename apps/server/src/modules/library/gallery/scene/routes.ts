// The admin's side of scene search (docs/scene-search-plan.md, S2): the switch,
// how far the scan has got, "scan again" and "delete search data". And, for
// everyone signed in, the search itself (S3).
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, logActivity } from "../../../../db.js";
import { parseBody } from "../../../../core/shared.js";
import { resolveGalleryBrowseLibraryIds } from "../catalog-scope.js";
import { getGalleryAssets } from "../catalog-asset.js";
import { galleryAssetIdsPassing } from "../catalog.js";
import { EMPTY_GALLERY_FILTERS } from "../catalog-filters.js";
import { isSceneLibrary } from "./settings.js";
import { SCENE_MAX_RESULTS, clearSceneSearchCache, rankScenes } from "./search.js";
import { SCENE_MODEL, SCENE_PASS } from "./model-id.js";
import { NoSceneEngineError, sceneEngine } from "./engine-client.js";
import { sceneSearchEnabled, setSceneSearchEnabled, sceneLibraryIds } from "./settings.js";
import { MAX_SCENE_SCAN_ATTEMPTS } from "./queue.js";
import {
  activeSceneScan, clearSceneData, enqueueSceneScans, processSceneScanQueue, resetLibrarySceneMarkers, sceneVectorsChanged
} from "./scanner.js";

/** Per library: how many photos there are, how many are described under the
 *  current model, and how many were given up on. */
function sceneLibraryStatus() {
  return (db.prepare(`
    SELECT libraries.id AS id, libraries.name AS name,
      (libraries.personal_user_id IS NOT NULL) AS personal,
      COUNT(library_items.id) AS photos,
      COUNT(CASE WHEN s.status = 'ok' THEN 1 END) AS described,
      COUNT(CASE WHEN s.status = 'failed' AND s.attempts >= ${MAX_SCENE_SCAN_ATTEMPTS} THEN 1 END) AS unreadable
    FROM libraries
    LEFT JOIN library_items ON library_items.library_id = libraries.id
      AND library_items.deleted_at IS NULL AND library_items.status = 'ready'
      AND EXISTS (SELECT 1 FROM gallery_details gd WHERE gd.item_id = library_items.id AND gd.kind = 'photo' AND gd.derived_from_item_id IS NULL)
    LEFT JOIN item_model_scans s ON s.item_id = library_items.id AND s.pass = '${SCENE_PASS}' AND s.model = ?
    WHERE libraries.type = 'gallery' AND libraries.role IS NULL
    GROUP BY libraries.id
    ORDER BY libraries.name
  `).all(SCENE_MODEL) as { id: string; name: string; personal: number; photos: number; described: number; unreadable: number }[])
    // A member's personal library: the Recognition page counts those together.
    .map((row) => ({ ...row, personal: row.personal === 1 }));
}

async function settingsAnswer() {
  return {
    enabled: sceneSearchEnabled(),
    model: SCENE_MODEL,
    engine: await sceneEngine().status(),
    libraries: sceneLibraryStatus(),
    scan: activeSceneScan()
  };
}

export async function gallerySceneRoutesPlugin(app: FastifyInstance) {
  // ── The search ──────────────────────────────────────────────────────────
  // The Gallery's own search asks this beside its search by name, with the same
  // scope and filters, and shows what comes back as "looks like …". It answers
  // `available: false` instead of failing when the feature is off or the engine
  // is not there: search by name never waits on it.
  const filterList = z.array(z.string().trim().min(1).max(200)).max(100).default([]);
  const searchSchema = z.object({
    q: z.string().trim().min(2).max(200),
    kinds: z.array(z.enum(["photo", "video", "audio"])).default([]),
    // The timeline's filters, unchanged (browse-routes.ts): a search respects them.
    filters: z.object({
      libraries: filterList,
      people: filterList,
      peopleMatch: z.enum(["any", "all"]).default("any"),
      tags: filterList,
      years: filterList,
      months: z.array(z.string().regex(/^(0[1-9]|1[0-2])$/)).max(12).default([]),
      taken: z.array(z.string().regex(/^(from|to):d{4}-d{2}-d{2}$/)).max(2).default([]),
      cameras: filterList,
      sizes: z.array(z.enum(["small", "medium", "large", "huge"])).max(4).default([]),
      location: z.array(z.enum(["with_gps", "no_gps"])).max(2).default([]),
      places: z.array(z.string().regex(/^d{1,12}$/)).max(100).default([]),
      likes: z.array(z.enum(["mine", "anyone", "none"])).max(3).default([])
    }).prefault({})
  });

  app.post("/api/library/gallery/scene/search", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(searchSchema, request.body ?? {});
    if (parsed.error) return reply.code(400).send({ error: "Invalid search", details: parsed.error });
    const nothing = { available: false, assets: [] as unknown[] };
    if (!sceneSearchEnabled()) return reply.send(nothing);
    const { q, kinds, filters } = parsed.data;

    // The libraries this person browses, as the timeline resolves them. Vectors
    // are only ever read for those.
    const libIds = resolveGalleryBrowseLibraryIds(request.user!, filters.libraries);
    let hits;
    try {
      hits = await rankScenes(libIds.filter(isSceneLibrary), q);
    } catch (err) {
      request.log.warn(`scene search: ${err instanceof Error ? err.message : String(err)}`);
      return reply.send(nothing);
    }
    // Ranked ids are only candidates: the gallery's own scoped query decides
    // which of them this person may see, with the filters they have on.
    const ranked = hits.map((hit) => hit.itemId);
    const passing = galleryAssetIdsPassing(request.user!.id, libIds, ranked, { kinds, filters: { ...EMPTY_GALLERY_FILTERS, ...filters } });
    const shown = ranked.filter((id) => passing.has(id)).slice(0, SCENE_MAX_RESULTS);
    return reply.send({ available: true, assets: getGalleryAssets(request.user!.id, libIds, shown) });
  });

  app.get("/api/library/gallery/scene/settings", { preHandler: app.requireAdmin }, async () => settingsAnswer());

  const settingsSchema = z.object({ enabled: z.boolean() });

  app.patch("/api/library/gallery/scene/settings", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(settingsSchema, request.body);
    if (parsed.error) return reply.code(400).send({ error: "Invalid settings", details: parsed.error });
    const { enabled } = parsed.data;
    if (enabled === sceneSearchEnabled()) return reply.send(await settingsAnswer());

    // Switching it on with nothing to describe photos would queue scans that skip
    // themselves: say so here, where the admin expects it to start. Off always works.
    if (enabled) {
      try {
        await sceneEngine().ensure();
      } catch (err) {
        if (err instanceof NoSceneEngineError) return reply.code(503).send({ error: err.message });
        throw err;
      }
    }
    setSceneSearchEnabled(enabled, request.user!.id);
    let queued = 0;
    if (enabled) {
      // The first scan starts now and runs to the end: it is why the switch was thrown.
      queued = enqueueSceneScans({ manual: true }).length;
      void processSceneScanQueue();
    } else {
      // Scans not yet started have nothing to do; the one running stops at its
      // next photo by finding the switch off. What was described is kept.
      db.prepare("DELETE FROM jobs WHERE type = 'SCAN_GALLERY_SCENES' AND status = 'pending'").run();
    }
    logActivity({
      event: "library.gallery.scene.settings",
      actorUserId: request.user!.id,
      targetType: "setting",
      targetId: "scene_search",
      detail: enabled
        ? `Search by what a photo shows switched on; ${queued} librar${queued === 1 ? "y" : "ies"} queued for a first scan.`
        : "Search by what a photo shows switched off.",
      ipAddress: request.ip
    });
    return reply.send(await settingsAnswer());
  });

  // Describe what is not described yet; with `force`, everything again.
  const scanSchema = z.object({ force: z.boolean().optional() });

  app.post("/api/library/gallery/scene/scan", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(scanSchema, request.body ?? {});
    if (parsed.error) return reply.code(400).send({ error: "Invalid scan request", details: parsed.error });
    if (!sceneSearchEnabled()) return reply.code(409).send({ error: "Switch on search by what a photo shows before scanning." });
    const running = activeSceneScan();
    if (running) return reply.code(409).send({ error: "A scan is already in progress. Wait for it to finish before starting another.", scan: running });
    try {
      await sceneEngine().ensure();
    } catch (err) {
      if (err instanceof NoSceneEngineError) return reply.code(503).send({ error: err.message });
      throw err;
    }
    if (parsed.data.force) for (const id of sceneLibraryIds()) resetLibrarySceneMarkers(id);
    const jobs = enqueueSceneScans({ manual: true });
    void processSceneScanQueue();
    logActivity({
      event: "library.gallery.scene.scan",
      actorUserId: request.user!.id,
      targetType: "setting",
      targetId: "scene_search",
      detail: `Queued a${parsed.data.force ? " full" : ""} scan of what photos show for ${jobs.length} gallery librar${jobs.length === 1 ? "y" : "ies"}.`,
      ipAddress: request.ip
    });
    return reply.send({ jobs: jobs.length, ...(await settingsAnswer()) });
  });

  // Remove every stored vector. Photos, faces and everything else are untouched;
  // switching the feature back on describes the photos again.
  app.delete("/api/library/gallery/scene/data", { preHandler: app.requireAdmin }, async (request, reply) => {
    if (sceneSearchEnabled()) return reply.code(409).send({ error: "Switch off search by what a photo shows before deleting its data." });
    if (activeSceneScan()) return reply.code(409).send({ error: "A scan is still finishing. Try again in a moment." });
    const removed = clearSceneData();
    sceneVectorsChanged();
    clearSceneSearchCache();
    logActivity({
      event: "library.gallery.scene.cleared",
      actorUserId: request.user!.id,
      targetType: "setting",
      targetId: "scene_search",
      detail: `Deleted the stored descriptions of ${removed} photo${removed === 1 ? "" : "s"}.`,
      ipAddress: request.ip
    });
    return reply.send({ removed, ...(await settingsAnswer()) });
  });
}
