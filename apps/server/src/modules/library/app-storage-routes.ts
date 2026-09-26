// App storage routes — docs/system-data-plan.md, phase 3. The Storage page's App
// storage block: the one switch, where it lives, and its four parts.
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { parseBody, parseQuery } from "../../core/shared.js";
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
import {
  APP_FILE_FOLDER_KEYS, appFilePage, appStorageContents, AppStorageContentsError, deleteOrphanAppFile,
  type AppFileFolderKey
} from "./app-storage-contents.js";
import { logActivity } from "../../db.js";
import {
  InboxReviewersError,
  REVIEWER_LEVELS,
  inboxReviewersView,
  removeInboxReviewer,
  setInboxEveryone,
  setInboxReviewer,
  type ReviewerLevel
} from "./gallery/inbox-reviewers.js";

const choiceSchema = z.object({
  where: z.enum(["system", "custom"]),
  path: z.string().trim().max(1000).nullable().optional()
});

const levelSchema = z.enum(REVIEWER_LEVELS as unknown as [ReviewerLevel, ...ReviewerLevel[]]);
const reviewerSchema = z.object({
  subjectType: z.enum(["user", "group"]),
  subjectId: z.string().trim().min(1).max(64),
  level: levelSchema
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

  // The Photo Inbox's reviewers (gallery/inbox-reviewers.ts): who besides the
  // admins may add details, and who may keep or discard.
  app.get("/api/storage/app-storage/parts/inbox/reviewers", { preHandler: app.requireAdmin }, async () => inboxReviewersView());
  app.post("/api/storage/app-storage/parts/inbox/reviewers", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(reviewerSchema, request.body);
    if (parsed.error) return reply.code(400).send({ error: "Invalid reviewer", details: parsed.error });
    const { subjectType, subjectId, level } = parsed.data;
    try {
      setInboxReviewer(subjectType, subjectId, level, request.user!.id);
    } catch (err) {
      if (err instanceof InboxReviewersError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
    logActivity({
      event: "gallery.inbox.reviewer_set",
      actorUserId: request.user!.id,
      targetType: subjectType,
      targetId: subjectId,
      detail: `Set ${subjectType} ${subjectId} to review the Photo Inbox (${level === "keep" ? "can keep or discard" : "can add details"}).`,
      ipAddress: request.ip
    });
    return reply.send(inboxReviewersView());
  });
  app.put("/api/storage/app-storage/parts/inbox/reviewers/everyone", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(z.object({ level: levelSchema.nullable() }), request.body);
    if (parsed.error) return reply.code(400).send({ error: "Invalid level", details: parsed.error });
    setInboxEveryone(parsed.data.level, request.user!.id);
    logActivity({
      event: "gallery.inbox.reviewer_set",
      actorUserId: request.user!.id,
      targetType: "group",
      targetId: "grp-everyone",
      detail: parsed.data.level
        ? `Let everyone review the Photo Inbox (${parsed.data.level === "keep" ? "can keep or discard" : "can add details"}).`
        : "Stopped everyone reviewing the Photo Inbox.",
      ipAddress: request.ip
    });
    return reply.send(inboxReviewersView());
  });
  app.delete("/api/storage/app-storage/parts/inbox/reviewers/:subjectType/:subjectId", { preHandler: app.requireAdmin }, async (request, reply) => {
    const { subjectType, subjectId } = request.params as { subjectType: string; subjectId: string };
    if (subjectType !== "user" && subjectType !== "group") return reply.code(400).send({ error: "Invalid subject type." });
    if (!removeInboxReviewer(subjectType, subjectId)) return reply.code(404).send({ error: "Not a reviewer." });
    logActivity({
      event: "gallery.inbox.reviewer_removed",
      actorUserId: request.user!.id,
      targetType: subjectType,
      targetId: subjectId,
      detail: `Removed ${subjectType} ${subjectId} from the Photo Inbox reviewers.`,
      ipAddress: request.ip
    });
    return reply.send(inboxReviewersView());
  });

  // The Contents page (app-storage-contents.ts): what each part holds, and the
  // App files library file by file with what owns each file; orphans can go.
  app.get("/api/storage/app-storage/contents", { preHandler: app.requireAdmin }, async () => await appStorageContents());
  // One folder's files, a page at a time: the page chooses a folder and pages
  // through it rather than receiving every file of every folder at once.
  const filesQuery = z.object({
    folder: z.enum(APP_FILE_FOLDER_KEYS as [AppFileFolderKey, ...AppFileFolderKey[]]),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().default(50)
  });
  app.get("/api/storage/app-storage/contents/files", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseQuery(filesQuery, request.query);
    if (parsed.error) return reply.code(400).send({ error: "Invalid query", details: parsed.error });
    const page = appFilePage(parsed.data.folder, parsed.data.page, parsed.data.pageSize);
    if (!page) return reply.code(404).send({ error: "There is no App files library." });
    return reply.send(page);
  });
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
      return reply.send({ deleted: true, contents: await appStorageContents() });
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
