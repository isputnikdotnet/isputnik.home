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
import { faceRecognitionEnabled, faceThreshold, setFaceRecognitionEnabled, setFaceThreshold } from "./faces/settings.js";
import { enqueueFaceScan, processFaceScanQueue } from "./faces/scanner.js";

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

  // ── Face recognition (admin): enable + trigger the detection pass ──

  app.get("/api/library/gallery/faces/settings", { preHandler: app.requireAdmin }, async () => ({
    settings: { enabled: faceRecognitionEnabled(), threshold: faceThreshold() }
  }));

  const faceSettingsSchema = z.object({
    enabled: z.boolean().optional(),
    threshold: z.number().min(0.2).max(0.95).optional()
  });

  app.patch("/api/library/gallery/faces/settings", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(faceSettingsSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid settings", details: parsed.error });
      return;
    }
    if (parsed.data.enabled != null) setFaceRecognitionEnabled(parsed.data.enabled, request.user!.id);
    if (parsed.data.threshold != null) setFaceThreshold(parsed.data.threshold, request.user!.id);
    logActivity({
      event: "library.gallery.faces.settings",
      actorUserId: request.user!.id,
      targetType: "setting",
      targetId: "face_recognition",
      detail: `Face recognition ${faceRecognitionEnabled() ? "enabled" : "disabled"}.`,
      ipAddress: request.ip
    });
    reply.send({ settings: { enabled: faceRecognitionEnabled(), threshold: faceThreshold() } });
  });

  // Queue a face scan for one gallery library, or every gallery library when no id is
  // given. `force` reprocesses items already scanned.
  const scanSchema = z.object({
    libraryId: z.string().trim().min(1).optional(),
    force: z.boolean().optional()
  });

  app.post("/api/library/gallery/faces/scan", { preHandler: app.requireAdmin }, async (request, reply) => {
    if (!faceRecognitionEnabled()) {
      reply.code(409).send({ error: "Enable face recognition before scanning." });
      return;
    }
    const parsed = parseBody(scanSchema, request.body ?? {});
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid scan request", details: parsed.error });
      return;
    }
    const ids = parsed.data.libraryId
      ? [parsed.data.libraryId]
      : (db.prepare("SELECT id FROM libraries WHERE type = 'gallery'").all() as { id: string }[]).map((r) => r.id);
    const jobs = ids.map((id) => enqueueFaceScan(id, parsed.data.force ?? false));
    void processFaceScanQueue();
    logActivity({
      event: "library.gallery.faces.scan",
      actorUserId: request.user!.id,
      targetType: "library",
      targetId: parsed.data.libraryId ?? "all",
      detail: `Queued a face scan for ${ids.length} gallery librar${ids.length === 1 ? "y" : "ies"}.`,
      ipAddress: request.ip
    });
    reply.send({ jobs: jobs.length });
  });
}
