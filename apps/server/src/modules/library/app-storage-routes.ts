// App storage routes — docs/app-storage-plan.md, phase 1. The Storage page's
// first block: the folder, and one row per room with a switch each.
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { parseBody } from "../../core/shared.js";
import { APP_ROOMS } from "../../core/app-storage.js";
import { appStorageView, renameRoomFolder, setAppStoragePath, statusOf, switchRoom, type CarryRooms } from "./app-storage.js";
import { cancelTrashMove, resetTrashMoveFailures, startTrashMove, trashMoveStatus } from "./shared/trash-move.js";
import { cancelFolderMove, folderMoveStatus } from "./shared/folder-move.js";
import { cancelStorageMove, retryStorageMove } from "./shared/storage-move.js";
import { appStorageContents, AppStorageContentsError, deleteOrphanAppFile } from "./app-storage-contents.js";
import { logActivity } from "../../db.js";

const pathSchema = z.object({
  // null (or "") clears App storage.
  path: z.string().trim().max(1000).nullable(),
  /** Per room that uses the current folder: true carries it to the new folder
   *  (the default), false leaves it where it is. Ignored when clearing. */
  carry: z.object(Object.fromEntries(APP_ROOMS.map((room) => [room, z.boolean().optional()]))).optional()
});

const roomSchema = z.object({
  mode: z.enum(["app", "own", "off"]),
  /** The folder for "own", on the rooms that take one. */
  path: z.string().trim().max(1000).nullable().optional(),
  /** The gallery library for "own", on the Inbox and App files rooms. */
  libraryId: z.string().trim().min(1).max(64).nullable().optional()
});

export async function appStorageRoutesPlugin(app: FastifyInstance) {
  app.get("/api/storage/app-storage", { preHandler: app.requireAdmin }, async () => appStorageView());

  // The Contents page (app-storage-contents.ts): what each room holds, and the
  // App files library file by file with what owns each file; orphans can go.
  app.get("/api/storage/app-storage/contents", { preHandler: app.requireAdmin }, async () => appStorageContents());
  app.post("/api/storage/app-storage/contents/delete", { preHandler: app.requireAdmin, config: { destructive: true } }, async (request, reply) => {
    const parsed = parseBody(z.object({ itemId: z.string().trim().min(1).max(64) }), request.body ?? {});
    if (parsed.error) return reply.code(400).send({ error: "Invalid request", details: parsed.error });
    try {
      const removed = deleteOrphanAppFile(parsed.data.itemId, request.user!.id);
      logActivity({
        event: "library.item_trashed",
        actorUserId: request.user!.id,
        targetType: "library_item",
        targetId: parsed.data.itemId,
        detail: `Moved the orphaned App files entry "${removed.relativePath}" to the Recycle Bin from the App storage contents page.`,
        ipAddress: request.ip
      });
      return reply.send({ deleted: true, contents: appStorageContents() });
    } catch (err) {
      if (err instanceof AppStorageContentsError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  app.put("/api/storage/app-storage", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(pathSchema, request.body);
    if (parsed.error) return reply.code(400).send({ error: "Invalid App storage folder", details: parsed.error });
    try {
      return reply.send(setAppStoragePath(parsed.data.path, request.user!.id, (parsed.data.carry ?? {}) as CarryRooms));
    } catch (err) {
      return reply.code(statusOf(err)).send({ error: err instanceof Error ? err.message : "Unable to set App storage" });
    }
  });

  app.put("/api/storage/app-storage/rooms/:room", { preHandler: app.requireAdmin }, async (request, reply) => {
    const room = (request.params as { room: string }).room;
    if (!(APP_ROOMS as readonly string[]).includes(room)) return reply.code(404).send({ error: "No such room." });
    const parsed = parseBody(roomSchema, request.body);
    if (parsed.error) return reply.code(400).send({ error: "Invalid room setting", details: parsed.error });
    try {
      const own = parsed.data.libraryId ?? parsed.data.path ?? null;
      const view = switchRoom(room as (typeof APP_ROOMS)[number], parsed.data.mode, own, request.user!.id, request.ip);
      return reply.send({ room: view, storage: appStorageView() });
    } catch (err) {
      return reply.code(statusOf(err)).send({ error: err instanceof Error ? err.message : "Unable to change the room" });
    }
  });

  // Rename a room's folder from its former name to the current one (App files
  // was "Made in the app"): a library move task, the library following its folder.
  app.post("/api/storage/app-storage/rooms/:room/rename", { preHandler: app.requireAdmin }, async (request, reply) => {
    const room = (request.params as { room: string }).room;
    if (!(APP_ROOMS as readonly string[]).includes(room)) return reply.code(404).send({ error: "No such room." });
    try {
      const view = renameRoomFolder(room as (typeof APP_ROOMS)[number], request.user!.id, request.ip);
      return reply.send({ room: view, storage: appStorageView() });
    } catch (err) {
      return reply.code(statusOf(err)).send({ error: err instanceof Error ? err.message : "Unable to rename the folder" });
    }
  });

  // A room's storage move (storage-move.ts): queue the last one again to retry
  // what failed, or stop the one running after the unit in hand.
  app.post("/api/storage/app-storage/rooms/:room/move", { preHandler: app.requireAdmin }, async (request, reply) => {
    const room = (request.params as { room: string }).room;
    if (!(APP_ROOMS as readonly string[]).includes(room)) return reply.code(404).send({ error: "No such room." });
    retryStorageMove(room as (typeof APP_ROOMS)[number], request.user!.id);
    return reply.send({ storage: appStorageView() });
  });
  app.delete("/api/storage/app-storage/rooms/:room/move", { preHandler: app.requireAdmin }, async (request, reply) => {
    const room = (request.params as { room: string }).room;
    if (!(APP_ROOMS as readonly string[]).includes(room)) return reply.code(404).send({ error: "No such room." });
    cancelStorageMove(room as (typeof APP_ROOMS)[number]);
    return reply.send({ storage: appStorageView() });
  });

  // The bin move (plan decision 10), in the shape the Recycle Bin page reads.
  app.get("/api/storage/trash-root/move", { preHandler: app.requireAdmin }, async () => trashMoveStatus());
  app.post("/api/storage/trash-root/move", { preHandler: app.requireAdmin }, async (request) => {
    resetTrashMoveFailures();
    return startTrashMove(request.user!.id);
  });
  app.delete("/api/storage/trash-root/move", { preHandler: app.requireAdmin }, async () => cancelTrashMove());

  // The thumbnail move (phase 3): what it is doing, and stop.
  app.get("/api/storage/app-storage/thumbnail-move", { preHandler: app.requireAdmin }, async () => folderMoveStatus());
  app.delete("/api/storage/app-storage/thumbnail-move", { preHandler: app.requireAdmin }, async () => cancelFolderMove());
}
