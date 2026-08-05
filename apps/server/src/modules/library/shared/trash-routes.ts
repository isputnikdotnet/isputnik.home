// Recycle Bin HTTP surface — type-agnostic (audiobook, ebook, …). Trashing reuses the
// library "delete" capability (manager+, managed library); restoring and purging need
// "manage". Server admins manage every item, including orphans of a deleted library.
// The actual file moves + DB teardown live in shared/trash.ts.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, logActivity } from "../../../db.js";
import { parseBody } from "../../../core/shared.js";
import { can, parsePolicy, type AuthUser } from "../../../core/permissions.js";
import { getLibraryForBook } from "./library-access.js";
import {
  trashBook,
  restoreTrashedItem,
  scanForRestored,
  purgeTrashedItem,
  emptyTrash,
  getTrashRetentionDays,
  TrashError,
  type TrashedItem
} from "./trash.js";

function isServerAdmin(user: AuthUser): boolean {
  return user.role === "admin";
}

// Manage rights over a trashed item resolve through its (still-existing) library; admins
// manage everything so orphaned items (library since deleted) can still be cleaned up.
function canManageTrashItem(user: AuthUser, item: Pick<TrashedItem, "library_id">): boolean {
  if (isServerAdmin(user)) return true;
  const lib = db.prepare("SELECT id, policy_json FROM libraries WHERE id = ?").get(item.library_id) as
    | { id: string; policy_json: string }
    | undefined;
  if (!lib) return false;
  return can(user, { objectType: "library", objectId: lib.id, policy: parsePolicy(lib.policy_json) }, "manage");
}

// Timestamps are stored as ISO-8601 UTC (see schema.sql / nowIso) → epoch ms.
function parseSqliteUtc(value: string): number {
  return Date.parse(value);
}

function serializeTrashedItem(row: TrashedItem & { trashed_by_name: string | null }, retentionDays: number) {
  const purgesAt = retentionDays > 0
    ? new Date(parseSqliteUtc(row.trashed_at) + retentionDays * 24 * 60 * 60 * 1000).toISOString()
    : null;
  return {
    id: row.id,
    libraryId: row.library_id,
    libraryType: row.library_type,
    libraryName: row.library_name,
    title: row.title,
    // Where it lived inside its library, so a bin tile can say which folder an
    // item came out of — two "IMG_1234.jpg" rows are otherwise indistinguishable.
    path: row.origin_path,
    fileCount: row.file_count,
    sizeBytes: row.size_bytes,
    // The thumbnail held for the bin's preview; null for rows trashed before 2.11
    // and for items that never had a cover.
    coverUrl: row.cover_key ? `/api/library/covers/${row.cover_key}` : null,
    trashedAt: row.trashed_at,
    trashedByName: row.trashed_by_name,
    purgesAt
  };
}

export function registerTrashRoutes(app: FastifyInstance) {

  // Move one item to the Recycle Bin (was: permanent delete).
  app.delete("/api/library/books/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const user = request.user!;

    const lib = getLibraryForBook(id);
    if (!lib) {
      reply.code(404).send({ error: "Item not found" });
      return;
    }
    if (!can(user, { objectType: "library", objectId: lib.id, policy: parsePolicy(lib.policy_json) }, "delete")) {
      reply.code(403).send({ error: "Deleting items is not allowed in this library." });
      return;
    }

    try {
      const result = trashBook(id, user.id);
      logActivity({
        event: "library.item_trashed",
        actorUserId: user.id,
        targetType: "book",
        targetId: id,
        detail: `Moved ${lib.type} "${result.title}" (${result.fileCount} file${result.fileCount === 1 ? "" : "s"}) to the Recycle Bin from library "${result.libraryName}".`,
        ipAddress: request.ip
      });
      reply.send({ trashed: true });
    } catch (err) {
      const status = err instanceof TrashError ? err.statusCode : 500;
      reply.code(status).send({ error: err instanceof Error ? err.message : "Could not move the item to the Recycle Bin." });
    }
  });

  const bulkDeleteSchema = z.object({
    bookIds: z.array(z.string().trim().min(1)).min(1).max(200)
  });

  // Bulk move to the Recycle Bin (selection mode). Permission is checked per item's
  // library; items the user can't delete are counted, not fatal.
  app.post("/api/library/books/bulk-delete", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(bulkDeleteSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid bulk delete", details: parsed.error });
      return;
    }

    const user = request.user!;
    let deleted = 0;
    let forbidden = 0;
    let missing = 0;
    let failed = 0;
    let failure = "";

    for (const bookId of parsed.data.bookIds) {
      const lib = getLibraryForBook(bookId);
      if (!lib) { missing += 1; continue; }
      if (!can(user, { objectType: "library", objectId: lib.id, policy: parsePolicy(lib.policy_json) }, "delete")) {
        forbidden += 1;
        continue;
      }
      try {
        const result = trashBook(bookId, user.id);
        deleted += 1;
        logActivity({
          event: "library.item_trashed",
          actorUserId: user.id,
          targetType: "book",
          targetId: bookId,
          detail: `Moved ${lib.type} "${result.title}" (${result.fileCount} file${result.fileCount === 1 ? "" : "s"}) to the Recycle Bin from library "${result.libraryName}".`,
          ipAddress: request.ip
        });
      } catch (err) {
        if (err instanceof TrashError && err.statusCode === 404) { missing += 1; continue; }
        failed += 1;
        if (!failure) failure = err instanceof Error ? err.message : "Could not move the item to the Recycle Bin.";
      }
    }

    if (deleted === 0 && forbidden > 0 && failed === 0) {
      reply.code(403).send({ error: "Deleting items is not allowed in the selected libraries." });
      return;
    }

    reply.send({ deleted, forbidden, missing, failed, ...(failure ? { error: failure } : {}) });
  });

  // The bin — items the caller can manage (admins see all, including orphans).
  app.get("/api/library/trash", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const rows = db.prepare(`
      SELECT trashed_items.*, users.display_name AS trashed_by_name
      FROM trashed_items
      LEFT JOIN users ON users.id = trashed_items.trashed_by
      ORDER BY datetime(trashed_items.trashed_at) DESC
    `).all() as (TrashedItem & { trashed_by_name: string | null })[];

    const retentionDays = getTrashRetentionDays();
    const visible = rows.filter((row) => canManageTrashItem(user, row));
    reply.send({
      items: visible.map((row) => serializeTrashedItem(row, retentionDays)),
      retentionDays
    });
  });

  app.post("/api/library/trash/:id/restore", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const user = request.user!;
    const item = db.prepare("SELECT * FROM trashed_items WHERE id = ?").get(id) as TrashedItem | undefined;
    if (!item) {
      reply.code(404).send({ error: "Item not found" });
      return;
    }
    if (!canManageTrashItem(user, item)) {
      reply.code(403).send({ error: "You don't have permission to restore this item." });
      return;
    }

    try {
      const result = await restoreTrashedItem(id);
      logActivity({
        event: "library.item_restored",
        actorUserId: user.id,
        targetType: "library",
        targetId: item.library_id,
        detail: `Restored ${item.library_type} "${result.title}" from the Recycle Bin to library "${result.libraryName}".`,
        ipAddress: request.ip
      });
      reply.send({ restored: true });
    } catch (err) {
      const status = err instanceof TrashError ? err.statusCode : 500;
      reply.code(status).send({ error: err instanceof Error ? err.message : "Could not restore the item." });
    }
  });

  const restoreAllSchema = z.object({ libraryId: z.string().trim().min(1).optional() });

  // Put everything back. Scoped to one library or, with no scope, the whole bin.
  //
  // Unlike emptying, this is not all-or-nothing and must not pretend to be: a single
  // item can refuse (its library is gone, a file now sits where it used to live) while
  // the rest go back perfectly well. So each is attempted on its own and the reply
  // says how many made it, how many were skipped for want of permission, and what the
  // first few failures actually said — a bare count would leave someone re-pressing a
  // button that will never clear the last three rows.
  app.post("/api/library/trash/restore-all", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(restoreAllSchema, request.body ?? {});
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid request", details: parsed.error });
      return;
    }
    const user = request.user!;
    const libraryId = parsed.data.libraryId;

    const rows = (libraryId
      ? db.prepare("SELECT * FROM trashed_items WHERE library_id = ? ORDER BY datetime(trashed_at) DESC").all(libraryId)
      : db.prepare("SELECT * FROM trashed_items ORDER BY datetime(trashed_at) DESC").all()) as TrashedItem[];

    let restored = 0;
    let forbidden = 0;
    const failures: { title: string; error: string }[] = [];
    // The re-discovery scan is per LIBRARY, not per item, and it walks the whole
    // library. Doing it per item queued one full scan for every photo restored —
    // hundreds of complete library walks, run back to back. Collected here and
    // started once each when the loop is done.
    const toScan = new Map<string, string>();
    for (const item of rows) {
      if (!canManageTrashItem(user, item)) { forbidden += 1; continue; }
      // Hand the event loop back between items. Restoring one is a burst of
      // synchronous work — file moves, a re-catalogue, a pile of better-sqlite3
      // calls — and a bin holding thousands of them would otherwise be one
      // unbroken block with nothing else served for its duration.
      await new Promise((resolve) => setImmediate(resolve));
      try {
        await restoreTrashedItem(item.id, true);
        restored += 1;
        toScan.set(item.library_id, item.library_type);
      } catch (err) {
        failures.push({
          title: item.title,
          error: err instanceof Error ? err.message : "Could not restore the item."
        });
      }
    }

    for (const [libraryId, libraryType] of toScan) scanForRestored(libraryType, libraryId);

    if (restored > 0) {
      logActivity({
        event: "library.item_restored",
        actorUserId: user.id,
        targetType: libraryId ? "library" : "setting",
        targetId: libraryId ?? "trash",
        detail: `Restored ${restored} item${restored === 1 ? "" : "s"} from the Recycle Bin${libraryId ? " for one library" : ""}.`,
        ipAddress: request.ip
      });
    }

    // 200 even with failures: the work that succeeded really did happen, and the
    // client renders the shortfall rather than treating the whole call as an error.
    reply.send({ restored, forbidden, failed: failures.length, failures: failures.slice(0, 5) });
  });

  app.delete("/api/library/trash/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const user = request.user!;
    const item = db.prepare("SELECT * FROM trashed_items WHERE id = ?").get(id) as TrashedItem | undefined;
    if (!item) {
      reply.code(404).send({ error: "Item not found" });
      return;
    }
    if (!canManageTrashItem(user, item)) {
      reply.code(403).send({ error: "You don't have permission to delete this item." });
      return;
    }

    purgeTrashedItem(id);
    logActivity({
      event: "library.item_purged",
      actorUserId: user.id,
      targetType: "library",
      targetId: item.library_id,
      detail: `Permanently deleted ${item.library_type} "${item.title}" (${item.file_count} file${item.file_count === 1 ? "" : "s"}) from the Recycle Bin, including its files on disk.`,
      ipAddress: request.ip
    });
    reply.send({ purged: true });
  });

  const emptySchema = z.object({ libraryId: z.string().trim().min(1).optional() });

  // Empty the bin. Scoped to one library (needs manage on it) or, with no scope, the whole
  // bin (server admins only).
  app.post("/api/library/trash/empty", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(emptySchema, request.body ?? {});
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid request", details: parsed.error });
      return;
    }
    const user = request.user!;
    const libraryId = parsed.data.libraryId;

    if (libraryId) {
      if (!canManageTrashItem(user, { library_id: libraryId })) {
        reply.code(403).send({ error: "You don't have permission to empty this library's items." });
        return;
      }
    } else if (!isServerAdmin(user)) {
      reply.code(403).send({ error: "Only an administrator can empty the entire Recycle Bin." });
      return;
    }

    const purged = emptyTrash(libraryId);
    logActivity({
      event: "library.item_purged",
      actorUserId: user.id,
      targetType: libraryId ? "library" : "setting",
      targetId: libraryId ?? "trash",
      detail: `Emptied the Recycle Bin${libraryId ? " for one library" : ""} — permanently deleted ${purged} item${purged === 1 ? "" : "s"} and their files on disk.`,
      ipAddress: request.ip
    });
    reply.send({ purged });
  });
}
