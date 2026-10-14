// The back side of a photo, by hand (docs/back-sides-proposal.md): add or
// replace it, remove it, turn it, split it off, read its file — and the Scanning
// tab's dry run of a library's pairing rule. The rule itself is saved with the
// library's other settings (library-crud.ts, `backSides`).
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { nanoid } from "nanoid";
import { db, logActivity } from "../../../db.js";
import { parseBody } from "../../../core/shared.js";
import { can, parsePolicy } from "../../../core/permissions.js";
import { canUserAccessBook, canUserWriteLibrary, getLibraryForBook } from "../shared/library-access.js";
import { resolveUploadMaxBytes } from "../shared/library-crud.js";
import { validateLibrarySource } from "../shared/library-source.js";
import { normalizeLibrarySettings, normalizeBackSides, uploadAcceptExtensions } from "../shared/library-settings.js";
import { pipeFileToReply } from "../shared/document-stream.js";
import { receiveUpload, UploadError } from "../../uploads/index.js";
import { getGalleryAsset } from "./catalog-asset.js";
import { placeLanguage } from "./places.js";
import { friendlyStorageError } from "./files.js";
import { backRuleOf } from "./back-sides.js";
import { checkBackSides } from "./scanner.js";
import { addBackSide, backFileOf, removeBackSide, rotateBackSide, splitBackSide } from "./back-side-files.js";
import type { LibraryRow } from "../../../db/rows.js";

const rotateSchema = z.object({ direction: z.enum(["cw", "ccw"]) });
const checkSchema = z.object({
  backSides: z.object({
    sources: z.array(z.object({ id: z.string(), enabled: z.boolean() })).max(10),
    patterns: z.array(z.string()).max(20)
  }).optional()
});

export async function galleryBackSideRoutesPlugin(app: FastifyInstance) {
  // Every write here needs write access to the item's library; adding a file
  // needs the upload permission too, as Replace does.
  const writable = (id: string, userId: string, role: string) => {
    const lib = getLibraryForBook(id);
    if (!lib || lib.type !== "gallery" || !canUserWriteLibrary(lib, userId, role)) return null;
    return lib;
  };

  app.get("/api/library/gallery/assets/:id/back/file", { preHandler: app.authenticate }, (request, reply) => {
    const { id } = request.params as { id: string };
    const row = db.prepare(`
      SELECT libraries.id AS id, libraries.source_path FROM library_items
      JOIN libraries ON libraries.id = library_items.library_id
      WHERE library_items.id = ? AND library_items.deleted_at IS NULL
    `).get(id) as Pick<LibraryRow, "id" | "source_path"> | undefined;
    const user = request.user!;
    if (!row || !canUserAccessBook(id, row, user.id, user.role, "gallery")) {
      reply.code(404).send({ error: "Asset not found" });
      return;
    }
    const file = backFileOf(id);
    if (!file) { reply.code(404).send({ error: "This photo has no back side." }); return; }
    const wantsDownload = typeof (request.query as { download?: string }).download === "string";
    const stat = fs.statSync(file.path);
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": file.mime,
      "Content-Length": stat.size,
      "Content-Disposition": `${wantsDownload ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
      "Cache-Control": "private, no-cache"
    });
    pipeFileToReply(reply, file.path);
  });

  app.post("/api/library/gallery/assets/:id/back", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = request.user!;
    const lib = writable(id, user.id, user.role);
    if (!lib) return reply.code(403).send({ error: "Write access required to edit this item." });
    const library = db.prepare("SELECT id, source_path, settings_json, policy_json FROM libraries WHERE id = ?")
      .get(lib.id) as Pick<LibraryRow, "id" | "source_path" | "settings_json" | "policy_json"> | undefined;
    if (!library) return reply.code(404).send({ error: "Gallery library not found" });
    const policy = parsePolicy(library.policy_json);
    if (!can(user, { objectType: "library", objectId: library.id, policy }, "upload")) {
      return reply.code(403).send({ error: "Uploading is not allowed in this library." });
    }
    let root: string;
    try { root = validateLibrarySource(library.source_path); } catch (err) {
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
      const result = await addBackSide(id, { tmpPath: received.tmpPath, filename: received.filename });
      if (!result.ok) return reply.code(result.status).send({ error: result.error });
      logActivity({
        event: "library.gallery.back_added",
        actorUserId: user.id,
        targetType: "library_item",
        targetId: id,
        detail: `Added the back side of a photo from "${received.filename}" (${received.sizeBytes} bytes).`,
        ipAddress: request.ip
      });
      return reply.send({ updated: true, asset: getGalleryAsset(user.id, [lib.id], id, placeLanguage(request)) });
    } finally {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
  });

  app.delete("/api/library/gallery/assets/:id/back", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = request.user!;
    const lib = writable(id, user.id, user.role);
    if (!lib) return reply.code(403).send({ error: "Write access required to edit this item." });
    const result = await removeBackSide(id);
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    logActivity({
      event: "library.gallery.back_removed",
      actorUserId: user.id,
      targetType: "library_item",
      targetId: id,
      detail: "Removed the back side of a photo. The file was set aside with the replaced originals.",
      ipAddress: request.ip
    });
    return reply.send({ updated: true, asset: getGalleryAsset(user.id, [lib.id], id, placeLanguage(request)) });
  });

  app.post("/api/library/gallery/assets/:id/back/rotate", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = request.user!;
    const lib = writable(id, user.id, user.role);
    if (!lib) return reply.code(403).send({ error: "Write access required to edit this item." });
    const parsed = parseBody(rotateSchema, request.body);
    if (parsed.error) return reply.code(400).send({ error: "Invalid rotation", details: parsed.error });
    const result = await rotateBackSide(id, parsed.data.direction);
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    return reply.send({ updated: true, asset: getGalleryAsset(user.id, [lib.id], id, placeLanguage(request)) });
  });

  app.post("/api/library/gallery/assets/:id/back/split", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = request.user!;
    const lib = writable(id, user.id, user.role);
    if (!lib) return reply.code(403).send({ error: "Write access required to edit this item." });
    const result = await splitBackSide(id);
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    logActivity({
      event: "library.gallery.back_split",
      actorUserId: user.id,
      targetType: "library_item",
      targetId: id,
      detail: "Split the back side off a photo into a photo of its own.",
      ipAddress: request.ip
    });
    return reply.send({
      updated: true,
      itemId: result.itemId,
      asset: getGalleryAsset(user.id, [lib.id], id, placeLanguage(request))
    });
  });

  // Dry run of a back-sides rule over a library, from file names alone — what
  // the Scanning tab's "Check this library" shows. The rule in the body is the
  // one being edited; absent, the saved one.
  app.post("/api/library/gallery-libraries/:id/back-sides/check", { preHandler: app.requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = parseBody(checkSchema, request.body ?? {});
    if (parsed.error) return reply.code(400).send({ error: "Invalid rule", details: parsed.error });
    const library = db.prepare("SELECT id, settings_json FROM libraries WHERE id = ? AND type = 'gallery'")
      .get(id) as Pick<LibraryRow, "id" | "settings_json"> | undefined;
    if (!library) return reply.code(404).send({ error: "Gallery library not found" });
    const settings = parsed.data.backSides
      ? normalizeBackSides(parsed.data.backSides)
      : normalizeLibrarySettings("gallery", library.settings_json).back_sides;
    try {
      return reply.send(checkBackSides(id, backRuleOf(settings)));
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : "Could not check this library." });
    }
  });
}
