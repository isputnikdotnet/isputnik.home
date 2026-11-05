// Personal libraries — the member's Profile › My library, and the admin's card on
// Library › Storage (docs/photo-sync-plan.md, phase 1; open question 6).
//
// Deleting an orphaned one goes through the ordinary confirmed library delete
// (DELETE /api/library/gallery-libraries/:id), which the route guard lets an admin
// reach for an orphaned personal library only.
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { db, logActivity } from "../../../../db.js";
import { parseBody } from "../../../../core/shared.js";
import { pathIsInside } from "../../shared/storage-roots.js";
import {
  getPersonalSettings, normalisePersonalFolder, personalParentFolder, personalSettingsSchema, savePersonalSettings
} from "./settings.js";
import {
  adoptPersonalLibrary, handOverPersonalLibrary, myLibraryView, personalLibrariesForAdmin,
  PersonalLibraryError, turnOnPersonalLibrary
} from "./service.js";
import type { LibraryRow, StorageRootRow } from "../../../../db/rows.js";

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof PersonalLibraryError) return reply.code(err.statusCode).send({ error: err.message, code: err.code });
  throw err;
}

function adminView() {
  const settings = getPersonalSettings();
  return { settings, parentFolder: personalParentFolder(settings), libraries: personalLibrariesForAdmin() };
}

const turnOnSchema = z.object({ name: z.string().trim().max(120).optional() });
const adoptSchema = z.object({ libraryId: z.string().trim().min(1).max(64), userId: z.string().trim().min(1).max(64) });
const handOverSchema = z.object({ userId: z.string().trim().min(1).max(64) });

export async function personalLibraryRoutesPlugin(app: FastifyInstance) {
  // ── The member ──
  app.get("/api/profile/personal-library", { preHandler: app.authenticate }, async (request) => myLibraryView(request.user!));

  app.post("/api/profile/personal-library", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(turnOnSchema, request.body ?? {});
    if (parsed.error) return reply.code(400).send({ error: "Invalid request", details: parsed.error });
    try {
      turnOnPersonalLibrary(request.user!, parsed.data.name, request.ip);
    } catch (err) {
      return sendError(reply, err);
    }
    return reply.code(201).send(myLibraryView(request.user!));
  });

  // ── The admin ──
  app.get("/api/storage/personal-libraries", { preHandler: app.requireAdmin }, async () => adminView());

  app.put("/api/storage/personal-libraries/settings", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(personalSettingsSchema, request.body);
    if (parsed.error) return reply.code(400).send({ error: "Invalid settings", details: parsed.error });
    const folder = normalisePersonalFolder(parsed.data.folder);
    if (!folder) return reply.code(400).send({ error: "Use a folder name inside the storage container, without '..'.", code: "bad_folder" });
    const settings = { ...parsed.data, folder };

    if (settings.storageRootId) {
      const root = db.prepare("SELECT id, path FROM storage_roots WHERE id = ?").get(settings.storageRootId) as Pick<StorageRootRow, "id" | "path"> | undefined;
      if (!root) return reply.code(400).send({ error: "Storage container not found.", code: "no_root" });
      // A personal library may not sit inside another library's folder: the other
      // library's scan would catalogue its photos for whoever can open that one.
      const parent = path.join(root.path, ...folder.split("/"));
      const libraries = db.prepare("SELECT name, source_path FROM libraries WHERE personal_user_id IS NULL").all() as Pick<LibraryRow, "name" | "source_path">[];
      const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
      const inside = libraries.find((library) => pathIsInside(norm(parent), norm(library.source_path)));
      if (inside) {
        return reply.code(409).send({ error: `That folder is inside the library "${inside.name}". Choose a folder no library uses.`, code: "inside_library" });
      }
    }
    if (settings.enabled && !settings.storageRootId) {
      return reply.code(400).send({ error: "Choose the storage container personal libraries are created in.", code: "no_root" });
    }

    savePersonalSettings(settings, request.user!.id);
    logActivity({
      event: "library.personal.settings",
      actorUserId: request.user!.id,
      targetType: "setting",
      targetId: "personal_libraries",
      detail: `Personal libraries ${settings.enabled ? "allowed" : "not allowed"}${settings.enabled && settings.who === "chosen" ? ` for ${settings.subjects.length} member(s) or group(s)` : ""}.`,
      ipAddress: request.ip
    });
    return reply.send(adminView());
  });

  app.post("/api/storage/personal-libraries/adopt", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(adoptSchema, request.body);
    if (parsed.error) return reply.code(400).send({ error: "Invalid request", details: parsed.error });
    try {
      adoptPersonalLibrary(parsed.data.libraryId, parsed.data.userId, request.user!.id, request.ip);
    } catch (err) {
      return sendError(reply, err);
    }
    return reply.send(adminView());
  });

  app.post("/api/storage/personal-libraries/:id/hand-over", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const parsed = parseBody(handOverSchema, request.body);
    if (parsed.error) return reply.code(400).send({ error: "Invalid request", details: parsed.error });
    try {
      handOverPersonalLibrary(id, parsed.data.userId, request.user!.id, request.ip);
    } catch (err) {
      return sendError(reply, err);
    }
    return reply.send(adminView());
  });
}
