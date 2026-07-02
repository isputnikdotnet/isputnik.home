import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, logActivity } from "../../../db.js";
import { parseBody } from "../../../core/shared.js";
import { canUserWriteLibrary, getLibraryForBook } from "../shared/library-access.js";
import type { LibraryListRow } from "../shared/library-serializer.js";
import { resolveGalleryScopeLibraryIds, getGalleryAsset } from "./catalog.js";
import {
  listGalleryPeople,
  getGalleryPersonPhotos,
  createGalleryPerson,
  findGalleryPersonByName,
  renameGalleryPerson,
  setGalleryPersonHidden,
  deleteGalleryPerson,
  mergeGalleryPeople,
  tagAssetPerson,
  untagAssetPerson,
  getGalleryPersonRow
} from "./people.js";
import {
  faceRecognitionEnabledForLibrary, setFaceRecognitionEnabledForLibrary, enabledFaceLibraryIds,
  faceThreshold, setFaceThreshold, faceGroupingK, setFaceGroupingK
} from "./faces/settings.js";
import { enqueueFaceScan, enqueueFaceScanBatches, enqueueFaceRecompute, processFaceScanQueue, activeFaceScan } from "./faces/scanner.js";
import { clearLibraryFaceData } from "./faces/clear.js";
import { FACE_EMBEDDING_MODEL } from "./faces/model-id.js";

// People are global, so person management (create/rename/hide/delete) is gated on the
// user being able to write SOME gallery library — anyone who curates photos can curate
// the people in them. Tagging a specific photo is additionally gated on write access
// to that photo's library (checked per-request).
function canWriteAnyGallery(user: { id: string; role: string }): boolean {
  if (user.role === "admin") return true;
  const rows = db.prepare("SELECT * FROM libraries WHERE type = 'gallery'").all() as LibraryListRow[];
  return rows.some((row) => canUserWriteLibrary(row, user.id, user.role));
}

export async function galleryPeopleRoutesPlugin(app: FastifyInstance) {
  // ── Browse people ──

  app.get("/api/library/gallery/people", { preHandler: app.authenticate }, async (request) => {
    const qp = request.query as { scope?: string; libraryId?: string; includeHidden?: string };
    const scope = qp.scope === "library" ? qp.scope : "all";
    const libIds = resolveGalleryScopeLibraryIds(request.user!, scope, qp.libraryId);
    const includeHidden = qp.includeHidden === "1" && request.user!.role === "admin";
    return { people: listGalleryPeople(libIds, includeHidden) };
  });

  app.get("/api/library/gallery/people/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const personId = (request.params as { id: string }).id;
    const qp = request.query as { limit?: string; offset?: string };
    const limit = Math.min(Math.max(Number.parseInt(qp.limit ?? "80", 10) || 80, 1), 200);
    const offset = Math.max(Number.parseInt(qp.offset ?? "0", 10) || 0, 0);
    const libIds = resolveGalleryScopeLibraryIds(request.user!, "all");
    const result = getGalleryPersonPhotos(request.user!.id, libIds, personId, limit, offset);
    if (!result) {
      reply.code(404).send({ error: "Person not found" });
      return;
    }
    reply.send(result);
  });

  // ── Manage people ──

  const createSchema = z.object({ name: z.string().trim().min(1).max(120) });

  app.post("/api/library/gallery/people", { preHandler: app.authenticate }, async (request, reply) => {
    if (!canWriteAnyGallery(request.user!)) {
      reply.code(403).send({ error: "Write access to a gallery library is required." });
      return;
    }
    const parsed = parseBody(createSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid person name", details: parsed.error });
      return;
    }
    const person = createGalleryPerson(parsed.data.name);
    logActivity({
      event: "library.gallery.person.created",
      actorUserId: request.user!.id,
      targetType: "gallery_person",
      targetId: person.id,
      detail: `Created person "${person.name}".`,
      ipAddress: request.ip
    });
    reply.code(201).send({ person });
  });

  const updateSchema = z.object({
    name: z.string().trim().min(1).max(120).optional(),
    hidden: z.boolean().optional()
  });

  app.patch("/api/library/gallery/people/:id", { preHandler: app.authenticate }, async (request, reply) => {
    if (!canWriteAnyGallery(request.user!)) {
      reply.code(403).send({ error: "Write access to a gallery library is required." });
      return;
    }
    const personId = (request.params as { id: string }).id;
    const parsed = parseBody(updateSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid changes", details: parsed.error });
      return;
    }
    if (!getGalleryPersonRow(personId)) {
      reply.code(404).send({ error: "Person not found" });
      return;
    }
    if (parsed.data.name != null) renameGalleryPerson(personId, parsed.data.name);
    if (parsed.data.hidden != null) setGalleryPersonHidden(personId, parsed.data.hidden);
    reply.send({ person: getGalleryPersonRow(personId) });
  });

  app.delete("/api/library/gallery/people/:id", { preHandler: app.authenticate }, async (request, reply) => {
    if (!canWriteAnyGallery(request.user!)) {
      reply.code(403).send({ error: "Write access to a gallery library is required." });
      return;
    }
    const personId = (request.params as { id: string }).id;
    const person = getGalleryPersonRow(personId);
    if (!person) {
      reply.code(404).send({ error: "Person not found" });
      return;
    }
    deleteGalleryPerson(personId);
    logActivity({
      event: "library.gallery.person.deleted",
      actorUserId: request.user!.id,
      targetType: "gallery_person",
      targetId: personId,
      detail: `Deleted person "${person.name}". Tagged photos were kept (untagged).`,
      ipAddress: request.ip
    });
    reply.send({ deleted: true });
  });

  // ── Tag / untag a photo ──

  // Tag accepts an existing personId OR a new name (create-then-tag), so the lightbox
  // can offer "pick a person or type a new one" in a single call.
  const tagSchema = z.object({
    personId: z.string().trim().min(1).optional(),
    name: z.string().trim().min(1).max(120).optional()
  }).refine((v) => v.personId || v.name, { message: "Provide a personId or a name." });

  function requireAssetWrite(request: { user?: { id: string; role: string } }, assetId: string) {
    const lib = getLibraryForBook(assetId);
    if (!lib || lib.type !== "gallery") return null;
    if (!canUserWriteLibrary(lib, request.user!.id, request.user!.role)) return null;
    return lib;
  }

  app.post("/api/library/gallery/assets/:id/people", { preHandler: app.authenticate }, async (request, reply) => {
    const assetId = (request.params as { id: string }).id;
    const lib = requireAssetWrite(request, assetId);
    if (!lib) {
      reply.code(403).send({ error: "Write access required to tag people in this item." });
      return;
    }
    const parsed = parseBody(tagSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid tag", details: parsed.error });
      return;
    }

    // Tagging by name links to an existing same-named person (case-insensitive) and
    // only creates one when none exists, so the same name never spawns duplicates.
    let personId = parsed.data.personId ?? null;
    let createdName: string | null = null;
    if (!personId && parsed.data.name) {
      const existing = findGalleryPersonByName(parsed.data.name);
      if (existing) {
        personId = existing.id;
      } else {
        const person = createGalleryPerson(parsed.data.name);
        personId = person.id;
        createdName = person.name;
      }
    }
    if (!personId || !tagAssetPerson(assetId, personId)) {
      reply.code(404).send({ error: "Person not found" });
      return;
    }

    logActivity({
      event: "library.gallery.person.tagged",
      actorUserId: request.user!.id,
      targetType: "library_item",
      targetId: assetId,
      detail: createdName ? `Tagged new person "${createdName}".` : "Tagged a person.",
      ipAddress: request.ip
    });

    const libIds = resolveGalleryScopeLibraryIds(request.user!, "all");
    reply.send({ asset: getGalleryAsset(request.user!.id, libIds, assetId) });
  });

  app.delete("/api/library/gallery/assets/:id/people/:personId", { preHandler: app.authenticate }, async (request, reply) => {
    const { id: assetId, personId } = request.params as { id: string; personId: string };
    const lib = requireAssetWrite(request, assetId);
    if (!lib) {
      reply.code(403).send({ error: "Write access required to tag people in this item." });
      return;
    }
    untagAssetPerson(assetId, personId);
    const libIds = resolveGalleryScopeLibraryIds(request.user!, "all");
    reply.send({ asset: getGalleryAsset(request.user!.id, libIds, assetId) });
  });

  // Merge person :id into :intoId (move faces, delete the source). Used to fold two
  // clusters of the same person together.
  const mergeSchema = z.object({ intoId: z.string().trim().min(1) });

  app.post("/api/library/gallery/people/:id/merge", { preHandler: app.authenticate }, async (request, reply) => {
    if (!canWriteAnyGallery(request.user!)) {
      reply.code(403).send({ error: "Write access to a gallery library is required." });
      return;
    }
    const sourceId = (request.params as { id: string }).id;
    const parsed = parseBody(mergeSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid merge", details: parsed.error });
      return;
    }
    if (!mergeGalleryPeople(sourceId, parsed.data.intoId)) {
      reply.code(404).send({ error: "Person not found" });
      return;
    }
    reply.send({ merged: true });
  });

  // ── Face recognition (admin): per-library enablement + the detection pass ──

  // One row per gallery library: its on/off state plus how much has been scanned, so
  // the settings popup can show "scanned X of Y photos". `scanned` counts only photos
  // scanned with the CURRENT embedding model, so after a model change it correctly drops
  // to "0 of Y" and climbs as the rescan re-embeds — real progress, not a stale total.
  interface FaceLibraryRow { id: string; name: string; photos: number; scanned: number }

  function faceLibraryStatus() {
    const rows = db.prepare(`
      SELECT
        libraries.id AS id,
        libraries.name AS name,
        COUNT(CASE WHEN gallery_details.kind = 'photo' THEN 1 END) AS photos,
        COUNT(DISTINCT gallery_face_scans.item_id) AS scanned
      FROM libraries
      LEFT JOIN library_items ON library_items.library_id = libraries.id AND library_items.deleted_at IS NULL
      LEFT JOIN gallery_details ON gallery_details.item_id = library_items.id
      LEFT JOIN gallery_face_scans ON gallery_face_scans.item_id = library_items.id AND gallery_face_scans.model = ?
      WHERE libraries.type = 'gallery'
      GROUP BY libraries.id, libraries.name
      ORDER BY libraries.name COLLATE NOCASE
    `).all(FACE_EMBEDDING_MODEL) as FaceLibraryRow[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      enabled: faceRecognitionEnabledForLibrary(r.id),
      photos: r.photos,
      scanned: r.scanned
    }));
  }

  app.get("/api/library/gallery/faces/settings", { preHandler: app.requireAdmin }, async () => ({
    threshold: faceThreshold(),
    groupingStrength: faceGroupingK(),
    libraries: faceLibraryStatus(),
    scan: activeFaceScan()
  }));

  const faceSettingsSchema = z.object({
    libraryId: z.string().trim().min(1).optional(),
    enabled: z.boolean().optional(),
    threshold: z.number().min(0.2).max(0.95).optional(),
    groupingStrength: z.number().int().min(2).max(8).optional()
  }).refine((v) => v.threshold != null || v.groupingStrength != null || (v.libraryId != null && v.enabled != null), {
    message: "Provide { libraryId, enabled }, { threshold } and/or { groupingStrength }."
  });

  app.patch("/api/library/gallery/faces/settings", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(faceSettingsSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid settings", details: parsed.error });
      return;
    }
    if (parsed.data.threshold != null) setFaceThreshold(parsed.data.threshold, request.user!.id);
    if (parsed.data.groupingStrength != null) setFaceGroupingK(parsed.data.groupingStrength, request.user!.id);

    if (parsed.data.libraryId != null && parsed.data.enabled != null) {
      const lib = db.prepare("SELECT id, name FROM libraries WHERE id = ? AND type = 'gallery'")
        .get(parsed.data.libraryId) as { id: string; name: string } | undefined;
      if (!lib) {
        reply.code(404).send({ error: "Gallery library not found" });
        return;
      }
      setFaceRecognitionEnabledForLibrary(lib.id, parsed.data.enabled, request.user!.id);
      // Turning a library on kicks off an initial scan of its not-yet-processed photos,
      // pre-queued as numbered batches so the Tasks page shows the whole backlog.
      if (parsed.data.enabled) {
        enqueueFaceScanBatches(lib.id);
        void processFaceScanQueue();
      }
      logActivity({
        event: "library.gallery.faces.settings",
        actorUserId: request.user!.id,
        targetType: "library",
        targetId: lib.id,
        detail: `Face recognition ${parsed.data.enabled ? "enabled" : "disabled"} for "${lib.name}".`,
        ipAddress: request.ip
      });
    }

    reply.send({ threshold: faceThreshold(), groupingStrength: faceGroupingK(), libraries: faceLibraryStatus() });
  });

  // Re-cluster existing faces with the current grouping settings — no re-detection.
  // This is the fast "apply my tuning" action; it does not re-read any photos.
  app.post("/api/library/gallery/faces/recompute", { preHandler: app.requireAdmin }, async (request, reply) => {
    const jobId = enqueueFaceRecompute();
    void processFaceScanQueue();
    logActivity({
      event: "library.gallery.faces.recompute",
      actorUserId: request.user!.id,
      targetType: "setting",
      targetId: "face_recognition",
      detail: "Queued a face re-clustering.",
      ipAddress: request.ip
    });
    reply.send({ job: jobId });
  });

  // Queue a face scan. With a libraryId, scans just that library (must be enabled);
  // without one, scans every enabled gallery library. `force` reprocesses every photo
  // from scratch — the "completely rescan" action.
  const scanSchema = z.object({
    libraryId: z.string().trim().min(1).optional(),
    force: z.boolean().optional()
  });

  app.post("/api/library/gallery/faces/scan", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(scanSchema, request.body ?? {});
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid scan request", details: parsed.error });
      return;
    }
    if (parsed.data.libraryId) {
      if (!faceRecognitionEnabledForLibrary(parsed.data.libraryId)) {
        reply.code(409).send({ error: "Enable face recognition for this library before scanning." });
        return;
      }
    } else if (enabledFaceLibraryIds().length === 0) {
      reply.code(409).send({ error: "Enable face recognition for a library before scanning." });
      return;
    }
    const ids = parsed.data.libraryId ? [parsed.data.libraryId] : enabledFaceLibraryIds();
    // Forced rescans run as a single uncapped job; incremental scans pre-queue batches.
    const jobs = ids.flatMap((id) => (parsed.data.force ? [enqueueFaceScan(id, true)] : enqueueFaceScanBatches(id)));
    void processFaceScanQueue();
    logActivity({
      event: "library.gallery.faces.scan",
      actorUserId: request.user!.id,
      targetType: "library",
      targetId: parsed.data.libraryId ?? "all",
      detail: `Queued a${parsed.data.force ? " full" : "n incremental"} face scan for ${ids.length} gallery librar${ids.length === 1 ? "y" : "ies"}.`,
      ipAddress: request.ip
    });
    reply.send({ jobs: jobs.length, scan: activeFaceScan() });
  });

  // Wipe all face-recognition data for one gallery library (faces, scan markers,
  // exclusions). Leaves the library's photos and any named global people intact.
  const clearSchema = z.object({ libraryId: z.string().trim().min(1) });

  app.delete("/api/library/gallery/faces/data", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(clearSchema, request.body ?? {});
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid request", details: parsed.error });
      return;
    }
    const lib = db.prepare("SELECT id, name FROM libraries WHERE id = ? AND type = 'gallery'")
      .get(parsed.data.libraryId) as { id: string; name: string } | undefined;
    if (!lib) {
      reply.code(404).send({ error: "Gallery library not found" });
      return;
    }
    const removed = clearLibraryFaceData(lib.id);
    logActivity({
      event: "library.gallery.faces.cleared",
      actorUserId: request.user!.id,
      targetType: "library",
      targetId: lib.id,
      detail: `Removed face data for "${lib.name}" (${removed.faces} faces across ${removed.photos} photos).`,
      ipAddress: request.ip
    });
    reply.send({ ...removed, threshold: faceThreshold(), groupingStrength: faceGroupingK(), libraries: faceLibraryStatus() });
  });
}
