import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { nanoid } from "nanoid";
import { db, logActivity } from "../../../db.js";
import { parseQuery } from "../../../core/shared.js";
import { can, parsePolicy } from "../../../core/permissions.js";
import { canUserAccessLibrary } from "../shared/library-access.js";
import { resolveUploadMaxBytes } from "../shared/library-crud.js";
import { validateLibrarySource } from "../shared/library-source.js";
import { normaliseRelativePath } from "../shared/storage-roots.js";
import { normalizeLibrarySettings, uploadAcceptExtensions } from "../shared/library-settings.js";
import { receiveUploadBatch, UploadError } from "../../uploads/index.js";
import { scanSingleGalleryFile } from "./scanner.js";
import { kindForExtension, readAssetMetadata } from "./media.js";
import { dateFolderForCapture } from "./date-folder.js";
import { friendlyStorageError, uniqueGalleryFileName } from "./files.js";

// Each uploaded file becomes its own asset (one photo/video = one item), so this
// also bounds assets-per-upload — galleries are dropped in large batches.
const MAX_GALLERY_UPLOAD_FILES = 200;

const uploadQuerySchema = z.object({ folder: z.string().optional() });

// Probe a staged upload for its capture date (EXIF for photos, container metadata for
// videos) and turn it into its dated subfolder. Falls back to the upload time when the
// file has no embedded date — the multipart stream doesn't carry the original's mtime.
async function uploadDateFolder(tmpPath: string, extension: string): Promise<string> {
  const kind = kindForExtension(`.${extension}`);
  let takenAt: string | null = null;
  if (kind) {
    try { takenAt = (await readAssetMetadata(kind, tmpPath)).takenAt; } catch { /* no date → fallback */ }
  }
  return dateFolderForCapture(takenAt, new Date());
}

export function registerGalleryUploadRoutes(app: FastifyInstance) {
  // Upload photos/videos: every file in the multipart request becomes its OWN asset
  // (one file = one item). Files stream into a hidden ".upload-*" staging folder under
  // the library root, then each is moved into the root under a safe, unique name and
  // cataloged immediately via scanSingleGalleryFile (reads EXIF + builds thumbnails).
  app.post("/api/library/gallery-libraries/:id/assets/upload", { preHandler: app.authenticate }, async (request, reply) => {
    const libraryId = (request.params as { id: string }).id;
    const user = request.user!;

    const library = db.prepare(
      "SELECT id, name, source_path, settings_json, policy_json FROM libraries WHERE id = ? AND type = 'gallery'"
    ).get(libraryId) as { id: string; name: string; source_path: string; settings_json: string; policy_json: string } | undefined;
    if (!library || !canUserAccessLibrary(library, user.id, user.role)) {
      return reply.code(404).send({ error: "Gallery library not found" });
    }

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

    // An optional folder the dated layout files under — the family tree sends
    // its house-library folder ("Family tree/2024/2024-05-01"). A plain relative
    // path: no absolute, no `..`, no hidden segment.
    const uploadQuery = parseQuery(uploadQuerySchema, request.query);
    if (uploadQuery.error) {
      return reply.code(400).send({ error: "Invalid upload folder.", details: uploadQuery.error });
    }
    const folderParam = (uploadQuery.data.folder ?? "").trim();
    const uploadFolder = folderParam ? normaliseRelativePath(folderParam) : "";
    if (folderParam && (!uploadFolder || uploadFolder.length > 300 || uploadFolder.split("/").some((seg) => seg === ".." || seg.startsWith(".")))) {
      return reply.code(400).send({ error: "Invalid upload folder." });
    }

    const settings = normalizeLibrarySettings("gallery", library.settings_json);
    const maxBytes = resolveUploadMaxBytes(policy.maxUploadMB);
    const stagingDir = path.join(root, `.upload-${nanoid(10)}`);

    let received;
    try {
      received = await receiveUploadBatch(
        request,
        { accept: uploadAcceptExtensions(settings), maxBytes },
        stagingDir,
        MAX_GALLERY_UPLOAD_FILES
      );
    } catch (err) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      const status = err instanceof UploadError ? err.statusCode : 400;
      return reply.code(status).send({ error: friendlyStorageError(err, "Upload failed") });
    }

    // Each file moves into a dated subfolder (YYYY/YYYY-MM-DD by capture date) under the
    // library root, then is cataloged on its own. Files already in place stay even if a
    // later one fails.
    const createdIds: string[] = [];
    let totalBytes = 0;
    try {
      for (const file of received) {
        const dated = await uploadDateFolder(file.tmpPath, file.extension);
        const targetDir = path.join(root, ...(uploadFolder ? `${uploadFolder}/${dated}` : dated).split("/"));
        fs.mkdirSync(targetDir, { recursive: true });
        const finalName = uniqueGalleryFileName(targetDir, file.filename);
        if (!finalName) { fs.rmSync(file.tmpPath, { force: true }); continue; }
        const finalPath = path.join(targetDir, finalName);
        fs.renameSync(file.tmpPath, finalPath);
        const relativePath = normaliseRelativePath(path.relative(root, finalPath));
        const assetId = await scanSingleGalleryFile(library.id, relativePath);
        if (assetId) { createdIds.push(assetId); totalBytes += file.sizeBytes; }
      }
    } catch (err) {
      return reply.code(500).send({ error: friendlyStorageError(err, "Could not store the uploaded files.") });
    } finally {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }

    if (createdIds.length === 0) {
      return reply.code(400).send({ error: "No photos or videos were added from the upload." });
    }

    logActivity({
      event: "library.gallery.uploaded",
      actorUserId: user.id,
      targetType: "library",
      targetId: library.id,
      detail: `Uploaded ${createdIds.length} item${createdIds.length === 1 ? "" : "s"} (${totalBytes} bytes) to gallery "${library.name}".`,
      ipAddress: request.ip
    });

    // A delivery into a Photo Inbox queues its duplicate check (proposal, decision
    // 9); an admin's upload owns the check, anyone else's falls to the library's
    // creator. Lazy import, as in the scanner: the duplicates module imports back.
    if (policy.inbox === true) {
      void import("./duplicates/inbox-check.js")
        .then((mod) => mod.queueInboxCheck(library.id, user.role === "admin" ? user.id : undefined))
        .catch(() => { /* started by hand from the Inbox page */ });
    }

    // `itemIds` lets a caller act on what it just uploaded — the family tree
    // attaches them to a person or event straight after the upload.
    return reply.code(201).send({ uploaded: createdIds.length, itemIds: createdIds });
  });
}
