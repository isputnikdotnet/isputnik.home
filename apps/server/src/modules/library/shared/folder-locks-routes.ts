import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, logActivity } from "../../../db.js";
import { parseBody } from "../../../core/shared.js";
import { listFolderLocks, normaliseLockPath, setFolderLock } from "./folder-locks.js";

// Folder locks are a library-config action, gated to admins like scan rules and
// rescan. Cross-type: the routes take any library id. The PUT is deliberately
// not marked destructive — locking is protective, and both directions are
// reversible no-ops on data.
const lockBodySchema = z.object({
  folderPath: z.string().trim().min(1).max(1024),
  locked: z.boolean()
});

export async function folderLocksPlugin(app: FastifyInstance) {
  const findLibrary = (id: string) =>
    db.prepare("SELECT id, name FROM libraries WHERE id = ?").get(id) as { id: string; name: string } | undefined;

  app.get("/api/library/libraries/:id/folder-locks", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!findLibrary(id)) { return reply.code(404).send({ error: "Library not found" }); }
    return reply.send({ locks: listFolderLocks(id) });
  });

  app.put("/api/library/libraries/:id/folder-locks", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const library = findLibrary(id);
    if (!library) { return reply.code(404).send({ error: "Library not found" }); }
    const parsed = parseBody(lockBodySchema, request.body);
    if (parsed.error) { return reply.code(400).send({ error: "Invalid folder lock", details: parsed.error }); }
    const folderPath = normaliseLockPath(parsed.data.folderPath);
    if (folderPath === null) {
      return reply.code(400).send({ error: "That isn't a folder path a lock can name." });
    }
    const changed = setFolderLock(id, folderPath, parsed.data.locked, request.user!.id);
    if (changed) {
      logActivity({
        event: "library.folder_lock_changed",
        actorUserId: request.user!.id,
        targetType: "library",
        targetId: id,
        detail: `${parsed.data.locked ? "Locked" : "Unlocked"} folder "${folderPath}" in library "${library.name}".`,
        ipAddress: request.ip
      });
    }
    return reply.send({ folderPath, locked: parsed.data.locked });
  });
}
