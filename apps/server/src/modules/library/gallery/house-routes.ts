// The house's gallery settings (Control → Settings → Gallery) —
// docs/photo-review-plan.md, phase 0. Two things live on that page: the "Made
// in the app" library every app-made file lands in, and a one-step way to set
// up a Photo Inbox, which used to be a switch buried on a library's Access tab.
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, logActivity } from "../../../db.js";
import { parseBody } from "../../../core/shared.js";
import { createLibraryRecord } from "../shared/library-crud.js";
import type { StorageRootRow } from "../shared/storage-roots.js";
import { enqueueGalleryScan, processGalleryScanQueue } from "./scanner.js";
import { getHouseLibrary, HOUSE_FOLDERS, setHouseLibrary } from "./house-library.js";
import { listPhotoInboxes } from "./inbox.js";

function houseView() {
  const library = getHouseLibrary();
  return {
    library: library ? { id: library.id, name: library.name } : null,
    folders: HOUSE_FOLDERS
  };
}

/** The characters no filesystem takes in a name (Windows is the strict one),
 *  the backslash by char code so no escaping is involved. */
const FORBIDDEN_IN_NAMES = new Set(["<", ">", ":", '"', "/", String.fromCharCode(92), "|", "?", "*"]);

/** A folder name from what the admin typed: the characters no filesystem takes
 *  are dropped, and what is left must still say something. */
export function safeFolderName(name: string): string | null {
  const cleaned = Array.from(name)
    .filter((ch) => !FORBIDDEN_IN_NAMES.has(ch) && ch.charCodeAt(0) >= 32)
    .join("")
    .replace(/[ \t]+/g, " ")
    .trim()
    .replace(/[.]+$/, "");
  if (!cleaned || cleaned === "." || cleaned === "..") return null;
  return cleaned.slice(0, 80);
}

const setHouseSchema = z.object({ libraryId: z.string().trim().min(1).max(64).nullable() });

const createInboxSchema = z.object({
  name: z.string().trim().min(2).max(80),
  storageRootId: z.string().trim().min(1).max(64)
});

export async function galleryHouseRoutesPlugin(app: FastifyInstance) {
  app.get("/api/library/gallery/house-library", { preHandler: app.requireAdmin }, async () => houseView());

  app.put("/api/library/gallery/house-library", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(setHouseSchema, request.body);
    if (parsed.error) return reply.code(400).send({ error: "Invalid settings", details: parsed.error });
    const result = setHouseLibrary(parsed.data.libraryId, request.user!.id);
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    logActivity({
      event: "config.updated",
      actorUserId: request.user!.id,
      targetType: "setting",
      targetId: "house_library",
      detail: result.library
        ? `Set the "Made in the app" library to "${result.library.name}".`
        : "Cleared the \"Made in the app\" library.",
      ipAddress: request.ip
    });
    return reply.send(houseView());
  });

  // Set up a Photo Inbox in one step: a new folder inside a storage container,
  // a gallery library over it with the Inbox flag on, and its first scan. The
  // Access-tab switch on any library still works for a second Inbox or for
  // turning an existing library into one.
  app.post("/api/library/gallery/inbox/create", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(createInboxSchema, request.body);
    if (parsed.error) return reply.code(400).send({ error: "Invalid Inbox details", details: parsed.error });
    const root = db.prepare("SELECT * FROM storage_roots WHERE id = ?").get(parsed.data.storageRootId) as StorageRootRow | undefined;
    if (!root) return reply.code(404).send({ error: "Storage container not found." });
    const folder = safeFolderName(parsed.data.name);
    if (!folder) return reply.code(400).send({ error: "Give the Inbox a name that can also be a folder name." });

    const sourcePath = path.join(root.path, folder);
    try {
      if (fs.existsSync(sourcePath)) {
        if (!fs.statSync(sourcePath).isDirectory()) {
          return reply.code(409).send({ error: `"${folder}" already exists in that container and is not a folder.` });
        }
      } else {
        fs.mkdirSync(sourcePath, { recursive: true });
      }
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : "Could not create the Inbox folder." });
    }

    const result = createLibraryRecord({
      type: "gallery",
      data: {
        name: parsed.data.name,
        sourcePath,
        visibility: "public",
        // Everyone may look; keeping and discarding take delete, which the
        // creating admin has as manager. Reviewers are added per library.
        publicRole: "viewer",
        mode: "managed",
        inbox: true
      },
      userId: request.user!.id,
      ip: request.ip
    });
    if ("error" in result) return reply.code(result.status).send({ error: result.error });

    const jobId = enqueueGalleryScan(result.libraryId);
    void processGalleryScanQueue();
    return reply.code(201).send({
      library: { id: result.libraryId, name: parsed.data.name, sourcePath },
      job: { id: jobId },
      inboxes: listPhotoInboxes(request.user!)
    });
  });
}
