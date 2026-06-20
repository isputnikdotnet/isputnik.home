// Works (editions). A "work" groups library_items that are the same book in
// different editions — two ebook printings, two narrator recordings, or the
// audiobook + ebook of one title. Cross-type, so it lives at the library level
// beside Tags / Categories / Bookmarks rather than inside one media plugin.
import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db, logActivity } from "../../db.js";
import { parseBody } from "../../core/shared.js";
import { getLibraryForBook, canUserWriteLibrary, accessibleLibraryIds } from "./shared/library-access.js";
import { splitGroupConcat } from "./audiobook/book-helpers.js";

interface EditionRow {
  id: string;
  library_id: string;
  type: string;
  is_primary: number;
  title: string | null;
  year_published: number | null;
  publisher: string | null;
  cover_storage_key: string | null;
  author_names: string | null;
  narrator_names: string | null;
  format: string | null;
  document_count: number;
  duration_seconds: number | null;
  percent_complete: number | null;
  completed_at: string | null;
}

// A work and its member editions, each with display fields + the caller's progress,
// ordered primary-first. Editions in libraries the user can't access are dropped;
// returns null for an unknown work or one with nothing visible. Powers the detail-
// page editions switcher (and is unit-tested directly, like the catalog engine).
export function getWorkEditions(workId: string, user: { id: string; role: string }) {
  if (!db.prepare("SELECT id FROM works WHERE id = ?").get(workId)) return null;

  const rows = db.prepare(`
    SELECT
      li.id, li.library_id, li.type, wi.is_primary,
      im.title, im.year_published, im.publisher, im.cover_storage_key,
      GROUP_CONCAT(DISTINCT authors.name) AS author_names,
      GROUP_CONCAT(DISTINCT narrators.name) AS narrator_names,
      (SELECT df.format FROM document_files df WHERE df.item_id = li.id AND df.status = 'available' LIMIT 1) AS format,
      (SELECT COUNT(*) FROM document_files df WHERE df.item_id = li.id AND df.status = 'available') AS document_count,
      ad.duration_seconds,
      COALESCE(
        (SELECT pp.percent_complete FROM playback_progress pp WHERE pp.item_id = li.id AND pp.user_id = ?),
        (SELECT rp.percent_complete FROM reading_progress rp WHERE rp.item_id = li.id AND rp.user_id = ? ORDER BY datetime(rp.updated_at) DESC LIMIT 1)
      ) AS percent_complete,
      COALESCE(
        (SELECT pp.completed_at FROM playback_progress pp WHERE pp.item_id = li.id AND pp.user_id = ?),
        (SELECT rp.completed_at FROM reading_progress rp WHERE rp.item_id = li.id AND rp.user_id = ? ORDER BY datetime(rp.updated_at) DESC LIMIT 1)
      ) AS completed_at
    FROM work_items wi
    JOIN library_items li ON li.id = wi.item_id AND li.deleted_at IS NULL
    LEFT JOIN item_metadata im ON im.item_id = li.id
    LEFT JOIN audiobook_details ad ON ad.item_id = li.id
    LEFT JOIN item_people ON item_people.item_id = li.id AND item_people.role = 'author'
    LEFT JOIN people AS authors ON authors.id = item_people.person_id
    LEFT JOIN item_people AS np ON np.item_id = li.id AND np.role = 'narrator'
    LEFT JOIN people AS narrators ON narrators.id = np.person_id
    WHERE wi.work_id = ?
    GROUP BY li.id
    ORDER BY wi.is_primary DESC, li.type, COALESCE(im.sort_title, im.title, li.folder_path) COLLATE NOCASE
  `).all(user.id, user.id, user.id, user.id, workId) as EditionRow[];

  const accessible = accessibleLibraryIds(user.id, user.role);
  const editions = rows
    .filter((row) => accessible.has(row.library_id))
    .map((row) => ({
      id: row.id,
      libraryId: row.library_id,
      type: row.type,
      isPrimary: row.is_primary === 1,
      title: row.title,
      authors: splitGroupConcat(row.author_names),
      narrators: splitGroupConcat(row.narrator_names),
      yearPublished: row.year_published,
      publisher: row.publisher,
      format: row.format,
      documentCount: row.document_count,
      durationSeconds: row.duration_seconds,
      coverUrl: row.cover_storage_key ? `/api/library/covers/${row.cover_storage_key}` : null,
      progress: { percentComplete: row.percent_complete, completedAt: row.completed_at }
    }));

  return editions.length > 0 ? { id: workId, editions } : null;
}

const groupSchema = z.object({
  itemIds: z.array(z.string().trim().min(1)).min(2).max(20),
  primaryItemId: z.string().trim().min(1)
});

const setPrimarySchema = z.object({
  primaryItemId: z.string().trim().min(1)
});

// Guarantee each media type in a work still has exactly one primary preference.
// Called after a removal: if a type lost its primary, promote its lowest-id member.
// (Browse derives the representative regardless, so this only keeps is_primary tidy.)
function ensurePrimaries(workId: string): void {
  const types = db.prepare(
    "SELECT DISTINCT li.type AS type FROM work_items wi JOIN library_items li ON li.id = wi.item_id WHERE wi.work_id = ?"
  ).all(workId) as { type: string }[];
  for (const { type } of types) {
    const hasPrimary = db.prepare(
      "SELECT 1 FROM work_items wi JOIN library_items li ON li.id = wi.item_id WHERE wi.work_id = ? AND li.type = ? AND wi.is_primary = 1 LIMIT 1"
    ).get(workId, type);
    if (hasPrimary) continue;
    const first = db.prepare(
      "SELECT wi.item_id FROM work_items wi JOIN library_items li ON li.id = wi.item_id WHERE wi.work_id = ? AND li.type = ? ORDER BY wi.item_id ASC LIMIT 1"
    ).get(workId, type) as { item_id: string } | undefined;
    if (first) db.prepare("UPDATE work_items SET is_primary = 1 WHERE work_id = ? AND item_id = ?").run(workId, first.item_id);
  }
}

// Make `itemId` the primary edition for its media type within the work (clears any
// other primary of that type first). Callers enforce access; this is pure data.
export function setPrimaryEdition(workId: string, itemId: string, type: string): void {
  db.transaction(() => {
    db.prepare("UPDATE work_items SET is_primary = 0 WHERE work_id = ? AND item_id IN (SELECT id FROM library_items WHERE type = ?)").run(workId, type);
    db.prepare("UPDATE work_items SET is_primary = 1 WHERE work_id = ? AND item_id = ?").run(workId, itemId);
  })();
}

// Remove one edition. A work needs >= 2 members, so the second-to-last removal
// dissolves the whole work (its last membership cascades away with it). Otherwise
// the remaining members keep a tidy primary per type.
export function removeEdition(workId: string, itemId: string): { remaining: number; dissolved: boolean } {
  return db.transaction(() => {
    db.prepare("DELETE FROM work_items WHERE work_id = ? AND item_id = ?").run(workId, itemId);
    const remaining = (db.prepare("SELECT COUNT(*) AS n FROM work_items WHERE work_id = ?").get(workId) as { n: number }).n;
    if (remaining < 2) {
      db.prepare("DELETE FROM works WHERE id = ?").run(workId);
      return { remaining: 0, dissolved: true };
    }
    ensurePrimaries(workId);
    return { remaining, dissolved: false };
  })();
}

export function registerWorkRoutes(app: FastifyInstance) {
  // Group selected books into one work (= editions of the same title). Requires
  // write access on every selected book's library, the same gate as bulk metadata.
  app.post("/api/library/works", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(groupSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid edition group", details: parsed.error });
      return;
    }

    const user = request.user!;
    const itemIds = Array.from(new Set(parsed.data.itemIds));
    if (itemIds.length < 2) {
      reply.code(400).send({ error: "Select at least two editions to group." });
      return;
    }
    if (!itemIds.includes(parsed.data.primaryItemId)) {
      reply.code(400).send({ error: "The primary edition must be one of the selected books." });
      return;
    }

    // Resolve each item's library + type, enforcing write access on every one.
    const items: { id: string; type: string }[] = [];
    for (const id of itemIds) {
      const lib = getLibraryForBook(id);
      if (!lib) {
        reply.code(404).send({ error: "One of the selected books was not found." });
        return;
      }
      if (!canUserWriteLibrary(lib, user.id, user.role)) {
        reply.code(403).send({ error: "Write access is required on every selected book's library." });
        return;
      }
      items.push({ id, type: lib.type });
    }

    // An item may belong to only one work; refuse if any is already grouped.
    const taken = db.prepare(
      `SELECT item_id FROM work_items WHERE item_id IN (${itemIds.map(() => "?").join(", ")})`
    ).all(...itemIds) as { item_id: string }[];
    if (taken.length > 0) {
      reply.code(409).send({ error: "One or more of these books is already part of an edition group." });
      return;
    }

    // One primary per media type: the chosen item leads its own type; any other
    // type present takes its first selected item as that type's representative.
    const primaryByType = new Map<string, string>();
    primaryByType.set(items.find((it) => it.id === parsed.data.primaryItemId)!.type, parsed.data.primaryItemId);
    for (const it of items) {
      if (!primaryByType.has(it.type)) primaryByType.set(it.type, it.id);
    }

    const workId = nanoid(16);
    db.transaction(() => {
      db.prepare("INSERT INTO works (id, created_by) VALUES (?, ?)").run(workId, user.id);
      const insert = db.prepare("INSERT INTO work_items (work_id, item_id, is_primary) VALUES (?, ?, ?)");
      for (const it of items) {
        insert.run(workId, it.id, primaryByType.get(it.type) === it.id ? 1 : 0);
      }
    })();

    logActivity({
      event: "library.work.created",
      actorUserId: user.id,
      targetType: "work",
      targetId: workId,
      detail: `Grouped ${items.length} editions into one book.`,
      ipAddress: request.ip
    });

    reply.code(201).send({ work: { id: workId }, count: items.length });
  });

  // A work with its member editions — feeds the detail-page editions switcher.
  app.get("/api/library/works/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const work = getWorkEditions((request.params as { id: string }).id, request.user!);
    if (!work) {
      reply.code(404).send({ error: "Work not found" });
      return;
    }
    reply.send({ work });
  });

  // Set which edition leads the group (per media type). Write access on the chosen
  // edition's library is required.
  app.patch("/api/library/works/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const workId = (request.params as { id: string }).id;
    const parsed = parseBody(setPrimarySchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid request", details: parsed.error });
      return;
    }
    const user = request.user!;
    const itemId = parsed.data.primaryItemId;

    const member = db.prepare("SELECT item_id FROM work_items WHERE work_id = ? AND item_id = ?").get(workId, itemId);
    if (!member) {
      reply.code(404).send({ error: "That edition is not part of this group." });
      return;
    }
    const lib = getLibraryForBook(itemId);
    if (!lib || !canUserWriteLibrary(lib, user.id, user.role)) {
      reply.code(403).send({ error: "Write access is required to change the primary edition." });
      return;
    }

    setPrimaryEdition(workId, itemId, lib.type);
    reply.send({ updated: true });
  });

  // Remove one edition from a work. A work needs >= 2 editions, so the last
  // removal dissolves it (the remaining book becomes standalone again).
  app.delete("/api/library/works/:id/items/:itemId", { preHandler: app.authenticate }, async (request, reply) => {
    const { id: workId, itemId } = request.params as { id: string; itemId: string };
    const user = request.user!;

    const member = db.prepare("SELECT item_id FROM work_items WHERE work_id = ? AND item_id = ?").get(workId, itemId);
    if (!member) {
      reply.code(404).send({ error: "That edition is not part of this group." });
      return;
    }
    const lib = getLibraryForBook(itemId);
    if (!lib || !canUserWriteLibrary(lib, user.id, user.role)) {
      reply.code(403).send({ error: "Write access is required to ungroup editions." });
      return;
    }

    reply.send({ removed: true, ...removeEdition(workId, itemId) });
  });
}
