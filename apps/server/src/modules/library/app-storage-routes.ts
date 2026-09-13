// App storage routes — docs/system-data-plan.md, phase 3. The Storage page's App
// storage block: the one switch, where it lives, and its four parts.
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { parseBody } from "../../core/shared.js";
import { APP_ROOMS, type AppRoom } from "../../core/app-storage.js";
import {
  appStorageView,
  cancelPartMove,
  changeAppStorage,
  movePartIn,
  renameAppFilesFolder,
  retryPartMove,
  turnOffAppStorage,
  turnOffRefusal,
  turnOnAppStorage
} from "./app-storage-service.js";
import { statusOf } from "./app-storage.js";
import { cancelTrashMove, resetTrashMoveFailures, startTrashMove, trashMoveStatus } from "./shared/trash-move.js";
import { cancelFolderMove, folderMoveStatus } from "./shared/folder-move.js";
import { appStorageContents, AppStorageContentsError, deleteOrphanAppFile } from "./app-storage-contents.js";
import { logActivity } from "../../db.js";

const choiceSchema = z.object({
  where: z.enum(["system", "custom"]),
  path: z.string().trim().max(1000).nullable().optional()
});

function partOf(params: unknown): AppRoom | null {
  const part = (params as { part: string }).part;
  return (APP_ROOMS as readonly string[]).includes(part) ? part as AppRoom : null;
}

export async function appStorageRoutesPlugin(app: FastifyInstance) {
  app.get("/api/storage/app-storage", { preHandler: app.requireAdmin }, async () => ({
    ...appStorageView(),
    // Asked while the page is read, so the switch can say why it won't go off
    // before anyone presses it. The server checks again when it is pressed.
    offRefusal: turnOffRefusal()
  }));

  // While off: remember where it will live. While on: move it there.
  app.put("/api/storage/app-storage", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(choiceSchema, request.body);
    if (parsed.error) return reply.code(400).send({ error: "Invalid App storage folder", details: parsed.error });
    try {
      return reply.send(changeAppStorage(parsed.data, request.user!.id, request.ip));
    } catch (err) {
      return reply.code(statusOf(err)).send({ error: err instanceof Error ? err.message : "Unable to change App storage" });
    }
  });

  app.post("/api/storage/app-storage/on", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(choiceSchema, request.body);
    if (parsed.error) return reply.code(400).send({ error: "Invalid App storage folder", details: parsed.error });
    try {
      return reply.send(turnOnAppStorage(parsed.data, request.user!.id, request.ip));
    } catch (err) {
      return reply.code(statusOf(err)).send({ error: err instanceof Error ? err.message : "Unable to switch App storage on" });
    }
  });

  app.post("/api/storage/app-storage/off", { preHandler: app.requireAdmin, config: { destructive: true } }, async (request, reply) => {
    try {
      return reply.send(turnOffAppStorage(request.user!.id, request.ip));
    } catch (err) {
      return reply.code(statusOf(err)).send({ error: err instanceof Error ? err.message : "Unable to switch App storage off" });
    }
  });

  // A part outside App storage moves in (or, a missing system library, is made).
  app.post("/api/storage/app-storage/parts/:part/move-in", { preHandler: app.requireAdmin }, async (request, reply) => {
    const part = partOf(request.params);
    if (!part) return reply.code(404).send({ error: "No such part." });
    try {
      return reply.send(movePartIn(part, request.user!.id, request.ip));
    } catch (err) {
      return reply.code(statusOf(err)).send({ error: err instanceof Error ? err.message : "Unable to move it into App storage" });
    }
  });

  // App files' folder from its former name to the current one.
  app.post("/api/storage/app-storage/parts/house/rename", { preHandler: app.requireAdmin }, async (request, reply) => {
    try {
      return reply.send(renameAppFilesFolder(request.user!.id, request.ip));
    } catch (err) {
      return reply.code(statusOf(err)).send({ error: err instanceof Error ? err.message : "Unable to rename the folder" });
    }
  });

  // A part's storage move: queue the last one again to retry what failed, or stop it.
  app.post("/api/storage/app-storage/parts/:part/move", { preHandler: app.requireAdmin }, async (request, reply) => {
    const part = partOf(request.params);
    if (!part) return reply.code(404).send({ error: "No such part." });
    return reply.send(retryPartMove(part, request.user!.id));
  });
  app.delete("/api/storage/app-storage/parts/:part/move", { preHandler: app.requireAdmin }, async (request, reply) => {
    const part = partOf(request.params);
    if (!part) return reply.code(404).send({ error: "No such part." });
    return reply.send(cancelPartMove(part));
  });

  // The Contents page (app-storage-contents.ts): what each part holds, and the
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

  // The bin move, in the shape the Recycle Bin page reads.
  app.get("/api/storage/trash-root/move", { preHandler: app.requireAdmin }, async () => trashMoveStatus());
  app.post("/api/storage/trash-root/move", { preHandler: app.requireAdmin }, async (request) => {
    resetTrashMoveFailures();
    return startTrashMove(request.user!.id);
  });
  app.delete("/api/storage/trash-root/move", { preHandler: app.requireAdmin }, async () => cancelTrashMove());

  // The thumbnail move: what it is doing, and stop.
  app.get("/api/storage/app-storage/thumbnail-move", { preHandler: app.requireAdmin }, async () => folderMoveStatus());
  app.delete("/api/storage/app-storage/thumbnail-move", { preHandler: app.requireAdmin }, async () => cancelFolderMove());
}
