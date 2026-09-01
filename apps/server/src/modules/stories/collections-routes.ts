// Story collection endpoints: the shelf CRUD, its timeline payload, and its
// access rows. Reads need `viewer`, adding stories needs `contributor`,
// everything else `manager` (admins always pass). The access surface mirrors
// the library members routes — one grant at a time, upsert on conflict — but
// is reachable by collection MANAGERS, not only admins, so the GET carries its
// own candidate lists rather than leaning on the admin-only /api/users.
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { db, logActivity } from "../../db.js";
import { parseBody } from "../../core/shared.js";
import { EVERYONE_GROUP_ID } from "../../core/permissions.js";
import { resolveGalleryScopeLibraryIds } from "../library/gallery/catalog.js";
import { hydrateEntities } from "../social/subjects.js";
import {
  STORY_COLLECTION_OBJECT_TYPE,
  canContributeToCollection,
  canManageCollection,
  canViewCollection
} from "./collection-access.js";
import {
  createCollection,
  deleteCollection,
  getCollection,
  listCollections,
  updateCollection,
  type CollectionRow
} from "./collections.js";
import { listStories } from "./stories.js";

const createSchema = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2000).nullable().optional()
});

const updateSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  coverItemId: z.string().trim().min(1).max(64).nullable().optional()
});

// `member` is a library nuance (downloads) with no meaning on a shelf; the
// grantable set here is the three collection roles plus deny.
const GRANT_ROLES = ["viewer", "contributor", "manager", "deny"] as const;
const grantSchema = z.object({
  subjectType: z.enum(["user", "group"]),
  subjectId: z.string().trim().min(1).max(64),
  role: z.enum(GRANT_ROLES)
});

const everyoneSchema = z.object({
  // null clears the Everyone baseline — that is what restricts the shelf.
  role: z.enum(["viewer", "contributor"]).nullable()
});

export async function storyCollectionsPlugin(app: FastifyInstance) {
  const loadViewable = (id: string, user: { id: string; role: string }, reply: FastifyReply): CollectionRow | null => {
    const collection = getCollection(id);
    if (!collection || !canViewCollection(user, collection.id)) {
      reply.code(404).send({ error: "Collection not found" });
      return null;
    }
    return collection;
  };

  const loadManageable = (id: string, user: { id: string; role: string }, reply: FastifyReply): CollectionRow | null => {
    const collection = loadViewable(id, user, reply);
    if (!collection) return null;
    if (!canManageCollection(user, collection.id)) {
      reply.code(403).send({ error: "Only this collection's manager or an admin can change it." });
      return null;
    }
    return collection;
  };

  app.get("/api/stories/collections", { preHandler: app.authenticate }, async (request) => {
    const user = request.user!;
    return { collections: listCollections(user, resolveGalleryScopeLibraryIds(user)) };
  });

  // Any member may start a shelf — they become its manager, and Everyone
  // starts as viewer, so it behaves like the flat list until restricted.
  app.post("/api/stories/collections", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(createSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid collection details", details: parsed.error });
    }
    const collection = createCollection(request.user!, parsed.data.title, parsed.data.description ?? null);
    logActivity({
      event: "story.collection.created",
      actorUserId: request.user!.id,
      targetType: "story_collection",
      targetId: collection.id,
      detail: `Created story collection "${collection.title}".`,
      ipAddress: request.ip
    });
    return reply.code(201).send({ collectionId: collection.id });
  });

  // The collection page: the shelf itself plus its member stories, in the
  // usual card shape — the client groups them into the year timeline.
  app.get("/api/stories/collections/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const collection = loadViewable((request.params as { id: string }).id, user, reply);
    if (!collection) return reply;
    const libIds = resolveGalleryScopeLibraryIds(user);
    const stories = listStories(user, libIds, undefined, undefined, collection.id);
    const cover = collection.cover_item_id
      ? hydrateEntities([{ entityType: "gallery", entityId: collection.cover_item_id }], user)
          .get(`gallery:${collection.cover_item_id}`)
      : undefined;
    // No Everyone row = the shelf is restricted to its member list. The
    // delete dialog needs this to warn honestly: deleting a restricted shelf
    // makes its published stories visible to everyone again.
    const everyone = db.prepare(
      "SELECT role FROM assignments WHERE subject_type = 'group' AND subject_id = ? AND object_type = ? AND object_id = ?"
    ).get(EVERYONE_GROUP_ID, STORY_COLLECTION_OBJECT_TYPE, collection.id) as { role: string } | undefined;
    return reply.send({
      collection: {
        id: collection.id,
        title: collection.title,
        description: collection.description,
        coverItemId: collection.cover_item_id,
        coverUrl: cover?.available ? cover.coverUrl ?? null : null,
        canContribute: canContributeToCollection(user, collection.id),
        canManage: canManageCollection(user, collection.id),
        restricted: !everyone || everyone.role === "deny",
        createdAt: collection.created_at,
        updatedAt: collection.updated_at
      },
      stories
    });
  });

  app.patch("/api/stories/collections/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const collection = loadManageable((request.params as { id: string }).id, user, reply);
    if (!collection) return reply;
    const parsed = parseBody(updateSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid collection details", details: parsed.error });
    }
    if (parsed.data.coverItemId
      && !hydrateEntities([{ entityType: "gallery", entityId: parsed.data.coverItemId }], user)
        .get(`gallery:${parsed.data.coverItemId}`)?.available) {
      return reply.code(400).send({ error: "That photo isn't available to use as a cover." });
    }
    updateCollection(collection.id, parsed.data);
    return reply.send({ updated: true });
  });

  app.delete("/api/stories/collections/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const collection = loadManageable((request.params as { id: string }).id, user, reply);
    if (!collection) return reply;
    deleteCollection(collection.id);
    logActivity({
      event: "story.collection.deleted",
      actorUserId: user.id,
      targetType: "story_collection",
      targetId: collection.id,
      detail: `Deleted story collection "${collection.title}". Its stories became standalone; none were deleted.`,
      ipAddress: request.ip
    });
    return reply.send({ deleted: true });
  });

  // ── Access ──

  app.get("/api/stories/collections/:id/access", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const collection = loadManageable((request.params as { id: string }).id, user, reply);
    if (!collection) return reply;

    const members = db.prepare(`
      SELECT
        assignments.subject_type AS subjectType,
        assignments.subject_id AS subjectId,
        assignments.role AS role,
        COALESCE(users.display_name, user_groups.name) AS name,
        users.email AS email
      FROM assignments
      LEFT JOIN users ON assignments.subject_type = 'user' AND users.id = assignments.subject_id
      LEFT JOIN user_groups ON assignments.subject_type = 'group' AND user_groups.id = assignments.subject_id
      WHERE assignments.object_type = ? AND assignments.object_id = ?
        AND NOT (assignments.subject_type = 'group' AND assignments.subject_id = ?)
      ORDER BY name COLLATE NOCASE
    `).all(STORY_COLLECTION_OBJECT_TYPE, collection.id, EVERYONE_GROUP_ID) as {
      subjectType: string; subjectId: string; role: string; name: string | null; email: string | null;
    }[];

    const everyone = db.prepare(
      "SELECT role FROM assignments WHERE subject_type = 'group' AND subject_id = ? AND object_type = ? AND object_id = ? AND role != 'deny'"
    ).get(EVERYONE_GROUP_ID, STORY_COLLECTION_OBJECT_TYPE, collection.id) as { role: string } | undefined;

    // Candidate pickers, served HERE because /api/users is admin-only and a
    // collection manager may not be one. Names only — the same disclosure the
    // send-to sheet already makes to every member.
    const users = db.prepare(
      "SELECT id, display_name AS name FROM users WHERE deleted_at IS NULL AND is_active = 1 ORDER BY display_name COLLATE NOCASE"
    ).all() as { id: string; name: string }[];
    const groups = db.prepare(
      "SELECT id, name FROM user_groups ORDER BY name COLLATE NOCASE"
    ).all() as { id: string; name: string }[];

    return reply.send({ members, everyoneRole: everyone?.role ?? null, candidates: { users, groups } });
  });

  app.post("/api/stories/collections/:id/access", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const collection = loadManageable((request.params as { id: string }).id, user, reply);
    if (!collection) return reply;
    const parsed = parseBody(grantSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid grant", details: parsed.error });
    }
    const { subjectType, subjectId, role } = parsed.data;
    const exists = subjectType === "user"
      ? db.prepare("SELECT id FROM users WHERE id = ? AND deleted_at IS NULL AND is_active = 1").get(subjectId)
      : db.prepare("SELECT id FROM user_groups WHERE id = ?").get(subjectId);
    if (!exists) {
      return reply.code(404).send({ error: subjectType === "user" ? "No such member." : "No such group." });
    }
    db.prepare(`
      INSERT INTO assignments (subject_type, subject_id, object_type, object_id, role)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (subject_type, subject_id, object_type, object_id) DO UPDATE SET role = excluded.role
    `).run(subjectType, subjectId, STORY_COLLECTION_OBJECT_TYPE, collection.id, role);
    logActivity({
      event: "story.collection.member.granted",
      actorUserId: user.id,
      targetType: "story_collection",
      targetId: collection.id,
      detail: `Set ${subjectType} ${subjectId} to ${role} on story collection "${collection.title}".`,
      ipAddress: request.ip
    });
    return reply.send({ granted: true });
  });

  app.delete("/api/stories/collections/:id/access/:subjectType/:subjectId", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const params = request.params as { id: string; subjectType: string; subjectId: string };
    const collection = loadManageable(params.id, user, reply);
    if (!collection) return reply;
    if (params.subjectType !== "user" && params.subjectType !== "group") {
      return reply.code(400).send({ error: "Invalid subject" });
    }
    const result = db.prepare(
      "DELETE FROM assignments WHERE subject_type = ? AND subject_id = ? AND object_type = ? AND object_id = ?"
    ).run(params.subjectType, params.subjectId, STORY_COLLECTION_OBJECT_TYPE, collection.id);
    if (result.changes === 0) {
      return reply.code(404).send({ error: "No such grant" });
    }
    logActivity({
      event: "story.collection.member.revoked",
      actorUserId: user.id,
      targetType: "story_collection",
      targetId: collection.id,
      detail: `Removed ${params.subjectType} ${params.subjectId} from story collection "${collection.title}".`,
      ipAddress: request.ip
    });
    return reply.send({ revoked: true });
  });

  // The Everyone baseline: viewer/contributor makes the shelf open to every
  // member at that level; null restricts it to the explicit rows above.
  app.put("/api/stories/collections/:id/access/everyone", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const collection = loadManageable((request.params as { id: string }).id, user, reply);
    if (!collection) return reply;
    const parsed = parseBody(everyoneSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid role", details: parsed.error });
    }
    if (parsed.data.role === null) {
      db.prepare("DELETE FROM assignments WHERE subject_type = 'group' AND subject_id = ? AND object_type = ? AND object_id = ?")
        .run(EVERYONE_GROUP_ID, STORY_COLLECTION_OBJECT_TYPE, collection.id);
    } else {
      db.prepare(`
        INSERT INTO assignments (subject_type, subject_id, object_type, object_id, role)
        VALUES ('group', ?, ?, ?, ?)
        ON CONFLICT (subject_type, subject_id, object_type, object_id) DO UPDATE SET role = excluded.role
      `).run(EVERYONE_GROUP_ID, STORY_COLLECTION_OBJECT_TYPE, collection.id, parsed.data.role);
    }
    logActivity({
      event: "story.collection.member.granted",
      actorUserId: user.id,
      targetType: "story_collection",
      targetId: collection.id,
      detail: parsed.data.role
        ? `Opened story collection "${collection.title}" to everyone as ${parsed.data.role}.`
        : `Restricted story collection "${collection.title}" to its listed members.`,
      ipAddress: request.ip
    });
    return reply.send({ updated: true });
  });
}
