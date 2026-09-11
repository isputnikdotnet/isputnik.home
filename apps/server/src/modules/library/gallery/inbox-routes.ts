// Photo Inbox routes — the review page's reads and its two verbs. See inbox.ts for
// what an Inbox is and docs/photo-inbox-proposal.md for why.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { logActivity } from "../../../db.js";
import { parseBody, parseQuery } from "../../../core/shared.js";
import {
  discardPhotoInboxItems, keepPhotoInboxItems, listPhotoInboxItems, listPhotoInboxes
} from "./inbox.js";
import { inboxCheckView, queueInboxCheck } from "./duplicates/inbox-check.js";

// Same ceiling as bulk delete: a selection is sent in batches of this size.
const MAX_REVIEW_ITEMS = 200;

const itemIdsSchema = z.array(z.string().trim().min(1).max(64)).min(1).max(MAX_REVIEW_ITEMS);

const keepSchema = z.object({
  itemIds: itemIdsSchema,
  libraryId: z.string().trim().min(1).max(64),
  folder: z.string().trim().max(1024).nullable().optional(),
  dated: z.boolean().optional()
});

const discardSchema = z.object({ itemIds: itemIdsSchema });

// `folder` present-but-empty means the root, absent means everything — so it
// stays a plain optional string. limit/offset stay strings so junk falls back to
// the defaults in the handler.
const itemsQuerySchema = z.object({
  folder: z.string().optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
  order: z.string().optional()
});

export async function galleryInboxRoutesPlugin(app: FastifyInstance) {
  // Every Inbox this user can open, with its deliveries — the review page's
  // header and the Home tile both read this.
  app.get("/api/library/gallery/inbox", { preHandler: app.authenticate }, async (request) => {
    return { inboxes: listPhotoInboxes(request.user!) };
  });

  // What is waiting in one Inbox, newest arrival first. `folder` narrows to one
  // delivery ("" = the root); absent = everything.
  app.get("/api/library/gallery/inbox/:id/items", { preHandler: app.authenticate }, async (request, reply) => {
    const libraryId = (request.params as { id: string }).id;
    const parsed = parseQuery(itemsQuerySchema, request.query);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid query", details: parsed.error });
    }
    const qp = parsed.data;
    const limit = Math.min(Math.max(Number.parseInt(qp.limit ?? "80", 10) || 80, 1), 200);
    const offset = Math.max(Number.parseInt(qp.offset ?? "0", 10) || 0, 0);
    const result = listPhotoInboxItems(request.user!, libraryId, {
      folder: qp.folder == null ? null : qp.folder.slice(0, 1024),
      limit,
      offset,
      // `order=review` is Review mode's walk (unreviewed first, file order).
      order: qp.order === "review" ? "review" : "arrival"
    });
    if (!result) return reply.code(404).send({ error: "Photo Inbox not found" });
    return result;
  });

  // The Inbox's duplicate check (docs/photo-inbox-proposal.md, phase 2): what the
  // review page says about copies. Reading it takes the same access as the Inbox;
  // starting one is the cleanup page's business, so admin-only, like every route
  // there.
  app.get("/api/library/gallery/inbox/:id/check", { preHandler: app.authenticate }, async (request, reply) => {
    const libraryId = (request.params as { id: string }).id;
    const user = request.user!;
    if (!listPhotoInboxes(user).some((inbox) => inbox.id === libraryId)) {
      return reply.code(404).send({ error: "Photo Inbox not found" });
    }
    return inboxCheckView(libraryId, user.id);
  });

  app.post("/api/library/gallery/inbox/:id/check", { preHandler: app.requireAdmin }, async (request, reply) => {
    const libraryId = (request.params as { id: string }).id;
    const user = request.user!;
    const start = queueInboxCheck(libraryId, user.id);
    if (!start.queued && start.reason === "not_inbox") return reply.code(404).send({ error: "Photo Inbox not found" });
    return { start, ...inboxCheckView(libraryId, user.id) };
  });

  // Keep: move the selected photos into a real library. The destination is one
  // library and is refused whole; each photo is then counted on its own, the way
  // bulk delete does, so a locked or vanished one does not stop the rest.
  app.post("/api/library/gallery/inbox/keep", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(keepSchema, request.body);
    if (parsed.error) return reply.code(400).send({ error: "Invalid keep request", details: parsed.error });
    const user = request.user!;
    const outcome = keepPhotoInboxItems(user, parsed.data.itemIds, {
      libraryId: parsed.data.libraryId,
      folder: parsed.data.folder ?? null,
      dated: parsed.data.dated === true
    });
    if (!outcome.ok) return reply.code(outcome.status).send({ error: outcome.error });

    const { counts } = outcome;
    if (counts.done > 0) {
      logActivity({
        event: "library.gallery.inbox_kept",
        actorUserId: user.id,
        targetType: "library",
        targetId: parsed.data.libraryId,
        detail: `Kept ${counts.done} photo${counts.done === 1 ? "" : "s"} from a Photo Inbox into "${outcome.destinationName}".`,
        ipAddress: request.ip
      });
    }
    if (counts.done === 0 && counts.forbidden > 0 && counts.failed === 0 && counts.locked === 0) {
      return reply.code(403).send({ error: "You can't review the selected photos." });
    }
    return reply.send(counts);
  });

  // Discard: to the Recycle Bin on the cleanup clock. destructive, like every
  // other path that removes files — refused from untrusted networks under the
  // deletions-only policy.
  app.post("/api/library/gallery/inbox/discard", { preHandler: app.authenticate, config: { destructive: true } }, async (request, reply) => {
    const parsed = parseBody(discardSchema, request.body);
    if (parsed.error) return reply.code(400).send({ error: "Invalid discard request", details: parsed.error });
    const user = request.user!;
    const counts = discardPhotoInboxItems(user, parsed.data.itemIds);
    if (counts.done > 0) {
      logActivity({
        event: "library.gallery.inbox_discarded",
        actorUserId: user.id,
        targetType: "library",
        targetId: "photo-inbox",
        detail: `Discarded ${counts.done} photo${counts.done === 1 ? "" : "s"} from a Photo Inbox to the Recycle Bin.`,
        ipAddress: request.ip
      });
    }
    if (counts.done === 0 && counts.forbidden > 0 && counts.failed === 0 && counts.locked === 0) {
      return reply.code(403).send({ error: "You can't review the selected photos." });
    }
    if (counts.done === 0 && counts.locked > 0 && counts.failed === 0) {
      return reply.code(423).send({ error: "The selected photos are in locked folders and can't be discarded." });
    }
    return reply.send(counts);
  });
}
