// App storage routes — docs/app-storage-plan.md, phase 1. The Storage page's
// first block: the folder, and one row per room with a switch each.
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { parseBody } from "../../core/shared.js";
import { APP_ROOMS } from "../../core/app-storage.js";
import { appStorageView, setAppStoragePath, statusOf, switchRoom } from "./app-storage.js";
import { cancelTrashMove, resetTrashMoveFailures, startTrashMove, trashMoveStatus } from "./shared/trash-move.js";

const pathSchema = z.object({
  // null (or "") clears App storage.
  path: z.string().trim().max(1000).nullable()
});

const roomSchema = z.object({
  mode: z.enum(["app", "own", "off"]),
  /** The folder for "own", on the rooms that take one. */
  path: z.string().trim().max(1000).nullable().optional()
});

export async function appStorageRoutesPlugin(app: FastifyInstance) {
  app.get("/api/storage/app-storage", { preHandler: app.requireAdmin }, async () => appStorageView());

  app.put("/api/storage/app-storage", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(pathSchema, request.body);
    if (parsed.error) return reply.code(400).send({ error: "Invalid App storage folder", details: parsed.error });
    try {
      return reply.send(setAppStoragePath(parsed.data.path, request.user!.id));
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
      const view = switchRoom(room as (typeof APP_ROOMS)[number], parsed.data.mode, parsed.data.path ?? null, request.user!.id, request.ip);
      return reply.send({ room: view, storage: appStorageView() });
    } catch (err) {
      return reply.code(statusOf(err)).send({ error: err instanceof Error ? err.message : "Unable to change the room" });
    }
  });

  // The bin move (plan decision 10): what it is doing, retry what failed, stop.
  app.get("/api/storage/trash-root/move", { preHandler: app.requireAdmin }, async () => trashMoveStatus());
  app.post("/api/storage/trash-root/move", { preHandler: app.requireAdmin }, async () => {
    resetTrashMoveFailures();
    return startTrashMove();
  });
  app.delete("/api/storage/trash-root/move", { preHandler: app.requireAdmin }, async () => cancelTrashMove());
}
