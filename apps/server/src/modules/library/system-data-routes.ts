// System data routes — docs/system-data-plan.md, phase 2. The Storage page's
// System data block and the setup guide's System data step read and change it here.
import path from "node:path";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { parseBody } from "../../core/shared.js";
import { diskSpace } from "../../core/system-data.js";
import {
  cancelSystemDataMove,
  retrySystemDataMove,
  setBackupFolder,
  setSystemDataPath,
  setThumbnailFolder,
  SystemDataError,
  systemDataView,
  type SystemDataMoveRoom
} from "./system-data.js";

const pathSchema = z.object({ path: z.string().trim().min(1).max(1000) });
const ownFolderSchema = z.object({
  // null (or "") sends the folder back to system data.
  path: z.string().trim().max(1000).nullable()
});
const spaceQuerySchema = z.object({ path: z.string().trim().min(1).max(1000) });

const MOVE_ROOMS: readonly SystemDataMoveRoom[] = ["thumbnails", "backups", "metadata"];

function statusOf(err: unknown): number {
  return err instanceof SystemDataError ? err.statusCode : 400;
}

export async function systemDataRoutesPlugin(app: FastifyInstance) {
  app.get("/api/storage/system-data", { preHandler: app.requireAdmin }, async () => systemDataView());

  app.put("/api/storage/system-data", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(pathSchema, request.body);
    if (parsed.error) return reply.code(400).send({ error: "Invalid system data folder", details: parsed.error });
    try {
      return reply.send(setSystemDataPath(parsed.data.path, request.user!.id, request.ip));
    } catch (err) {
      return reply.code(statusOf(err)).send({ error: err instanceof Error ? err.message : "Unable to set system data" });
    }
  });

  app.put("/api/storage/system-data/thumbnails", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(ownFolderSchema, request.body);
    if (parsed.error) return reply.code(400).send({ error: "Invalid thumbnail folder", details: parsed.error });
    try {
      return reply.send(setThumbnailFolder(parsed.data.path || null, request.user!.id, request.ip));
    } catch (err) {
      return reply.code(statusOf(err)).send({ error: err instanceof Error ? err.message : "Unable to change the thumbnail folder" });
    }
  });

  app.put("/api/storage/system-data/backups", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(ownFolderSchema, request.body);
    if (parsed.error) return reply.code(400).send({ error: "Invalid backup folder", details: parsed.error });
    try {
      return reply.send(setBackupFolder(parsed.data.path || null, request.user!.id, request.ip));
    } catch (err) {
      return reply.code(statusOf(err)).send({ error: err instanceof Error ? err.message : "Unable to change the backup folder" });
    }
  });

  // A folder's move: queue the last one again to retry what failed, or stop it.
  app.post("/api/storage/system-data/moves/:room", { preHandler: app.requireAdmin }, async (request, reply) => {
    const room = (request.params as { room: string }).room as SystemDataMoveRoom;
    if (!MOVE_ROOMS.includes(room)) return reply.code(404).send({ error: "No such folder." });
    return reply.send(retrySystemDataMove(room, request.user!.id));
  });
  app.delete("/api/storage/system-data/moves/:room", { preHandler: app.requireAdmin }, async (request, reply) => {
    const room = (request.params as { room: string }).room as SystemDataMoveRoom;
    if (!MOVE_ROOMS.includes(room)) return reply.code(404).send({ error: "No such folder." });
    return reply.send(cancelSystemDataMove(room));
  });

  // Free space for a folder someone is typing: the meter under every folder field.
  // Numbers only, and only for an absolute path; a folder that does not exist yet
  // answers for the nearest one above it.
  app.get("/api/storage/disk-space", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(spaceQuerySchema, request.query);
    if (parsed.error || !path.isAbsolute(parsed.data.path)) return reply.code(400).send({ error: "Use an absolute server path." });
    return reply.send({ space: diskSpace(parsed.data.path) });
  });
}
