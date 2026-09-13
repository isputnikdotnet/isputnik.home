// One photo or video at a time (and the bulk versions of the same edits): read,
// edit, review, rotate, replace — and the replaced originals Replace file sets aside.
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { nanoid } from "nanoid";
import { db, logActivity, logActivityOnce } from "../../../db.js";
import { parseBody, parseQuery } from "../../../core/shared.js";
import { can, parsePolicy } from "../../../core/permissions.js";
import { canUserAccessBook, canUserWriteAsset, canUserWriteLibrary, getLibraryForBook } from "../shared/library-access.js";
import { resolveUploadMaxBytes } from "../shared/library-crud.js";
import { validateLibrarySource } from "../shared/library-source.js";
import { normalizeLibrarySettings, uploadAcceptExtensions } from "../shared/library-settings.js";
import { receiveUpload, UploadError } from "../../uploads/index.js";
import { resolveGalleryScopeLibraryIds } from "./catalog-scope.js";
import { getGalleryAsset, getGalleryAssetUnscoped } from "./catalog-asset.js";
import { placeLanguage } from "./places.js";
import { changeGalleryTags, markGalleryAssetReviewed, setGalleryPlaceAndTime, updateGalleryAsset } from "./edit.js";
import { TAKEN_PRECISIONS } from "./taken-precision.js";
import { replaceGalleryAssetFile } from "./replace.js";
import { deleteAllReplacedOriginals, deleteReplacedOriginal, listReplacedOriginals } from "./replaced.js";
import { searchPlaces } from "./geocode.js";
import { rotateGalleryAsset } from "./rotate.js";
import { friendlyStorageError } from "./files.js";
import type { LibraryRow } from "../../../db/rows.js";

const geocodeQuerySchema = z.object({ q: z.string().optional() });

export function registerGalleryAssetRoutes(app: FastifyInstance) {
  // Replaced originals (replaced.ts): the files Replace file set aside, listed
  // from disk for the Recycle Bin page, let go one at a time or all at once.
  app.get("/api/library/trash/replaced", { preHandler: app.requireAdmin }, async () => {
    const originals = listReplacedOriginals();
    return { originals, bytes: originals.reduce((sum, original) => sum + original.size, 0) };
  });

  // The key names a file path, encoded, and is longer than a path parameter may
  // be (Fastify caps those at 100 characters), so it travels in the body.
  const replacedKeySchema = z.object({ key: z.string().min(1).max(2000) });
  app.post("/api/library/trash/replaced/delete", { preHandler: app.requireAdmin, config: { destructive: true } }, async (request, reply) => {
    const parsed = parseBody(replacedKeySchema, request.body ?? {});
    if (parsed.error) return reply.code(400).send({ error: "Invalid request", details: parsed.error });
    const removed = deleteReplacedOriginal(parsed.data.key);
    if (!removed) return reply.code(404).send({ error: "That replaced original is no longer there." });
    logActivity({
      event: "library.replaced_original_purged",
      actorUserId: request.user!.id,
      targetType: "setting",
      targetId: "trash",
      detail: `Permanently deleted the replaced original "${removed.fileName}" (${removed.size} bytes).`,
      ipAddress: request.ip
    });
    return reply.send({ deleted: true });
  });

  app.post("/api/library/trash/replaced/empty", { preHandler: app.requireAdmin, config: { destructive: true } }, async (request, reply) => {
    const removed = deleteAllReplacedOriginals();
    logActivity({
      event: "library.replaced_original_purged",
      actorUserId: request.user!.id,
      targetType: "setting",
      targetId: "trash",
      detail: `Permanently deleted every replaced original — ${removed.files} file${removed.files === 1 ? "" : "s"}, ${removed.bytes} bytes.`,
      ipAddress: request.ip
    });
    return reply.send(removed);
  });

  app.get("/api/library/gallery/assets/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const user = request.user!;
    const libIds = resolveGalleryScopeLibraryIds(user);
    let asset = getGalleryAsset(user.id, libIds, id, placeLanguage(request));
    if (!asset) {
      // Not in a library the viewer can browse — allow it only if the photo was
      // shared directly with them (the "Shared with me" path opens this route).
      const library = getLibraryForBook(id);
      if (library && library.type === "gallery" && canUserAccessBook(id, library, user.id, user.role, "gallery")) {
        asset = getGalleryAssetUnscoped(user.id, id, placeLanguage(request));
      }
    }
    if (!asset) {
      return reply.code(404).send({ error: "Asset not found" });
    }
    return reply.send({ asset });
  });

  // Lightweight view ping fired by the lightbox as the visitor browses — logged at
  // most once per user+asset per dedup window (see logActivityOnce), so paging back
  // and forth through a set doesn't flood activity_logs.
  app.post("/api/library/gallery/assets/:id/viewed", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const user = request.user!;
    const libIds = resolveGalleryScopeLibraryIds(user);
    let asset = getGalleryAsset(user.id, libIds, id, placeLanguage(request));
    if (!asset) {
      const library = getLibraryForBook(id);
      if (library && library.type === "gallery" && canUserAccessBook(id, library, user.id, user.role, "gallery")) {
        asset = getGalleryAssetUnscoped(user.id, id, placeLanguage(request));
      }
    }
    if (!asset) {
      return reply.code(404).send({ error: "Asset not found" });
    }
    logActivityOnce({
      event: "library.gallery.viewed",
      actorUserId: user.id,
      targetType: "gallery",
      targetId: id,
      detail: `Viewed ${asset.kind} "${asset.title}".`,
      ipAddress: request.ip
    });
    return reply.send({ ok: true });
  });

  // Manual metadata edit: title/caption, description, date taken, tags, location.
  // Requires write access to the asset's library; protects the fields from future
  // rescans. `gps` omitted = leave the location untouched, null = remove it.
  // `takenPrecision`/`takenApprox` say how much of `takenAt` is known (a reviewed
  // print: "about 1962"); `placeText` is the place as a person wrote it; `reviewed`
  // stamps the photo as gone through in Review mode. docs/photo-review-plan.md.
  const editSchema = z.object({
    title: z.string().trim().min(1).max(300),
    description: z.string().trim().max(5000).nullable().optional(),
    takenAt: z.iso.datetime().nullable().optional(),
    takenPrecision: z.enum(TAKEN_PRECISIONS).optional(),
    takenApprox: z.boolean().optional(),
    placeText: z.string().trim().max(300).nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(80)).max(50).default([]),
    gps: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).nullable().optional(),
    reviewed: z.boolean().optional()
  });

  app.patch("/api/library/gallery/assets/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const user = request.user!;
    const lib = getLibraryForBook(id);
    // The library's edit right, or an album sent to this person with "Ask for
    // notes" (docs/photo-review-plan.md, phase 3).
    if (!lib || lib.type !== "gallery" || !canUserWriteAsset(id, lib, user.id, user.role)) {
      return reply.code(403).send({ error: "Write access required to edit this item." });
    }

    const parsed = parseBody(editSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid details", details: parsed.error });
    }

    const ok = updateGalleryAsset(id, {
      title: parsed.data.title,
      description: parsed.data.description ?? null,
      takenAt: parsed.data.takenAt ?? null,
      takenPrecision: parsed.data.takenPrecision,
      takenApprox: parsed.data.takenApprox,
      placeText: parsed.data.placeText,
      tags: parsed.data.tags ?? [],
      gps: parsed.data.gps,
      reviewedBy: parsed.data.reviewed ? user.id : undefined
    });
    if (!ok) {
      return reply.code(404).send({ error: "Asset not found" });
    }

    logActivity({
      event: parsed.data.reviewed ? "library.gallery.reviewed" : "library.gallery.edited",
      actorUserId: user.id,
      targetType: "library_item",
      targetId: id,
      detail: parsed.data.reviewed ? `Went through "${parsed.data.title}" in Review mode.` : `Edited gallery item "${parsed.data.title}".`,
      ipAddress: request.ip
    });

    return reply.send({ updated: true, asset: getGalleryAsset(user.id, [lib.id], id, placeLanguage(request)) });
  });

  // "I don't know": the photo was looked at in Review mode and nothing on it
  // changed. Same write right as an edit — a reviewed mark is a fact about the
  // photo, not about the Inbox — so a contributor can leave one without being
  // able to Keep. docs/photo-review-plan.md, phase 2.
  app.post("/api/library/gallery/assets/:id/reviewed", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const user = request.user!;
    const lib = getLibraryForBook(id);
    if (!lib || lib.type !== "gallery" || !canUserWriteAsset(id, lib, user.id, user.role)) {
      return reply.code(403).send({ error: "Write access required to review this item." });
    }
    if (!markGalleryAssetReviewed(id, user.id)) {
      return reply.code(404).send({ error: "Asset not found" });
    }
    const asset = getGalleryAsset(user.id, [lib.id], id, placeLanguage(request));
    logActivity({
      event: "library.gallery.reviewed",
      actorUserId: user.id,
      targetType: "library_item",
      targetId: id,
      detail: `Went through "${asset?.title ?? id}" in Review mode.`,
      ipAddress: request.ip
    });
    return reply.send({ reviewed: true, asset });
  });

  // Place lookup behind the location picker's search box. Rate-limited well below
  // the global ceiling: every hit is an outbound request to a free community
  // service, and their policy is one request a second.
  app.get(
    "/api/library/gallery/geocode",
    { preHandler: app.authenticate, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsed = parseQuery(geocodeQuerySchema, request.query);
      if (parsed.error) {
        return reply.code(400).send({ error: "Invalid query", details: parsed.error });
      }
      const q = (parsed.data.q ?? "").trim();
      if (q.length < 2 || q.length > 200) {
        return reply.code(400).send({ error: "Type at least two characters to search for a place." });
      }
      try {
        return reply.send({ results: await searchPlaces(q) });
      } catch (err) {
        return reply.code(502).send({ error: err instanceof Error ? err.message : "The place lookup failed." });
      }
    }
  );

  // Bulk "set date taken / location" from the multi-select bar — one request for
  // the whole selection, mirroring bulk-save/bulk-delete. Permission is checked
  // per item's library; items the user can't write are counted, not fatal. Each
  // field is optional but at least one must be sent (an empty edit is a mistake,
  // not a no-op worth 200 writes).
  // `takenAt` sets one instant on everything; `shiftMinutes` moves each item's own
  // date instead (bounded to ±10 years, enough for any timezone/clock slip).
  const bulkPlaceTimeSchema = z
    .object({
      ids: z.array(z.string().trim().min(1).max(64)).min(1).max(200),
      takenAt: z.iso.datetime().optional(),
      takenPrecision: z.enum(TAKEN_PRECISIONS).optional(),
      takenApprox: z.boolean().optional(),
      shiftMinutes: z.number().int().min(-5_256_000).max(5_256_000).refine((v) => v !== 0).optional(),
      gps: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).optional(),
      placeText: z.string().trim().max(300).nullable().optional()
    })
    .refine((body) => body.takenAt === undefined || body.shiftMinutes === undefined, {
      message: "Set a date or shift by an offset, not both."
    })
    .refine((body) => body.takenAt !== undefined || body.shiftMinutes !== undefined || body.gps !== undefined || body.placeText !== undefined, {
      message: "Send a date, an offset, a location, a place, or a combination."
    });

  app.post("/api/library/gallery/assets/bulk-place-time", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(bulkPlaceTimeSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid details", details: parsed.error });
    }

    const user = request.user!;
    const allowed: string[] = [];
    let forbidden = 0;
    for (const id of parsed.data.ids) {
      const lib = getLibraryForBook(id);
      if (!lib || lib.type !== "gallery" || !canUserWriteLibrary(lib, user.id, user.role)) {
        forbidden += 1;
        continue;
      }
      allowed.push(id);
    }

    const { updated, noDate } = setGalleryPlaceAndTime(allowed, {
      takenAt: parsed.data.takenAt,
      takenPrecision: parsed.data.takenPrecision,
      takenApprox: parsed.data.takenApprox,
      shiftMinutes: parsed.data.shiftMinutes,
      gps: parsed.data.gps,
      placeText: parsed.data.placeText
    });

    if (updated > 0) {
      const fields = [
        parsed.data.takenAt ? "date taken" : null,
        parsed.data.shiftMinutes ? `date taken (shifted ${parsed.data.shiftMinutes} min)` : null,
        parsed.data.gps ? "location" : null,
        parsed.data.placeText !== undefined ? "place" : null
      ].filter(Boolean).join(" and ");
      logActivity({
        event: "library.gallery.edited",
        actorUserId: user.id,
        targetType: "library_item",
        targetId: allowed[0],
        detail: `Set the ${fields} on ${updated} gallery item${updated === 1 ? "" : "s"}.`,
        ipAddress: request.ip
      });
    }

    return reply.send({ updated, forbidden, noDate });
  });

  // Bulk tagging from the multi-select bar — label a whole holiday in one go.
  // Add and remove rather than replace, so a photo keeps the tags it already
  // carries; both may travel in one request. Permission is checked per item's
  // library and items the user can't write are counted, not fatal.
  const bulkTagsSchema = z
    .object({
      ids: z.array(z.string().trim().min(1).max(64)).min(1).max(200),
      add: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
      remove: z.array(z.string().trim().min(1).max(80)).max(20).optional()
    })
    .refine((body) => (body.add?.length ?? 0) > 0 || (body.remove?.length ?? 0) > 0, {
      message: "Send at least one tag to add or remove."
    });

  app.post("/api/library/gallery/assets/bulk-tags", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(bulkTagsSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid tags", details: parsed.error });
    }

    const user = request.user!;
    const allowed: string[] = [];
    let forbidden = 0;
    for (const id of parsed.data.ids) {
      const lib = getLibraryForBook(id);
      if (!lib || lib.type !== "gallery" || !canUserWriteLibrary(lib, user.id, user.role)) {
        forbidden += 1;
        continue;
      }
      allowed.push(id);
    }

    const { updated } = changeGalleryTags(allowed, { add: parsed.data.add, remove: parsed.data.remove });

    if (updated > 0) {
      const what = [
        parsed.data.add?.length ? `added ${parsed.data.add.join(", ")}` : null,
        parsed.data.remove?.length ? `removed ${parsed.data.remove.join(", ")}` : null
      ].filter(Boolean).join(" and ");
      logActivity({
        event: "library.gallery.edited",
        actorUserId: user.id,
        targetType: "library_item",
        targetId: allowed[0],
        detail: `Tagged ${updated} gallery item${updated === 1 ? "" : "s"} (${what}).`,
        ipAddress: request.ip
      });
    }

    return reply.send({ updated, forbidden });
  });

  // Rotate a photo or video 90° clockwise/counter-clockwise. Stores the angle and
  // bakes it into the regenerated thumbnails (a video's poster frame included);
  // the original file is untouched — the client rotates video playback via CSS.
  const rotateSchema = z.object({ direction: z.enum(["cw", "ccw"]) });

  app.post("/api/library/gallery/assets/:id/rotate", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const user = request.user!;
    const lib = getLibraryForBook(id);
    if (!lib || lib.type !== "gallery" || !canUserWriteLibrary(lib, user.id, user.role)) {
      return reply.code(403).send({ error: "Write access required to edit this item." });
    }

    const parsed = parseBody(rotateSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid rotation", details: parsed.error });
    }

    const result = await rotateGalleryAsset(id, parsed.data.direction);
    if (!result.ok) {
      return reply.code(result.status).send({ error: result.error });
    }

    logActivity({
      event: "library.gallery.rotated",
      actorUserId: user.id,
      targetType: "library_item",
      targetId: id,
      detail: `Rotated gallery ${result.kind} ${parsed.data.direction === "cw" ? "right" : "left"} (now ${result.rotation}°).`,
      ipAddress: request.ip
    });

    return reply.send({ updated: true, asset: getGalleryAsset(user.id, [lib.id], id, placeLanguage(request)) });
  });

  // Replace the file behind one photo or video, keeping the item — the
  // high-resolution scan over the low-resolution one. Everything pointing at the
  // item (stories, albums, tags, faces, favourites) comes along, which is the
  // whole reason this exists rather than "delete and upload again".
  app.post("/api/library/gallery/assets/:id/replace", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const user = request.user!;
    const lib = getLibraryForBook(id);
    if (!lib || lib.type !== "gallery" || !canUserWriteLibrary(lib, user.id, user.role)) {
      return reply.code(403).send({ error: "Write access required to edit this item." });
    }

    // Writing a file into the library is the upload permission, not merely write
    // access to the catalogue — a library that refuses uploads refuses this too.
    const library = db.prepare("SELECT id, source_path, settings_json, policy_json FROM libraries WHERE id = ?")
      .get(lib.id) as Pick<LibraryRow, "id" | "source_path" | "settings_json" | "policy_json"> | undefined;
    if (!library) return reply.code(404).send({ error: "Gallery library not found" });
    const policy = parsePolicy(library.policy_json);
    if (!can(user, { objectType: "library", objectId: library.id, policy }, "upload")) {
      return reply.code(403).send({ error: "Uploading is not allowed in this library." });
    }

    let root: string;
    try {
      root = validateLibrarySource(library.source_path);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : "Library source folder is unavailable." });
    }

    const settings = normalizeLibrarySettings("gallery", library.settings_json);
    const stagingDir = path.join(root, `.upload-${nanoid(10)}`);
    let received;
    try {
      received = await receiveUpload(
        request,
        { accept: uploadAcceptExtensions(settings), maxBytes: resolveUploadMaxBytes(policy.maxUploadMB) },
        stagingDir
      );
    } catch (err) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      const status = err instanceof UploadError ? err.statusCode : 400;
      return reply.code(status).send({ error: friendlyStorageError(err, "Upload failed") });
    }

    try {
      const result = await replaceGalleryAssetFile(id, { tmpPath: received.tmpPath, filename: received.filename });
      if (!result.ok) {
        return reply.code(result.status).send({ error: result.error });
      }

      logActivity({
        event: "library.gallery.replaced",
        actorUserId: user.id,
        targetType: "library_item",
        targetId: id,
        detail: `Replaced the file for a gallery item with "${received.filename}" (${received.sizeBytes} bytes). The previous file was kept.`,
        ipAddress: request.ip
      });

      return reply.send({ replaced: true, asset: getGalleryAsset(user.id, [lib.id], id, placeLanguage(request)) });
    } finally {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
  });
}
