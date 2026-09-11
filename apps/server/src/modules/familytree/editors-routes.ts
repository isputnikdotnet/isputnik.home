import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, logActivity } from "../../db.js";
import { parseBody } from "../../core/shared.js";
import { FAMILY_TAG_OBJECT_TYPE } from "./access.js";
import type { TagRow } from "../../db/rows.js";

export function registerEditorRoutes(app: FastifyInstance) {
  // ── Branch access (admin) ──
  // Assignments with object_type 'family_tree_tag' grant a user or group edit
  // rights over every person carrying the tag. Same pattern as library members.

  const editorGrantSchema = z.object({
    subjectType: z.enum(["user", "group"]),
    subjectId: z.string().trim().min(1),
    role: z.enum(["contributor", "deny"])
  });

  const getTag = (tagId: string) =>
    db.prepare("SELECT id, display_name AS name FROM tags WHERE id = ?").get(tagId) as (Pick<TagRow, "id"> & { name: TagRow["display_name"] }) | undefined;

  app.get("/api/family-tree/tags/:tagId/editors", { preHandler: app.requireAdmin }, async (request, reply) => {
    const tag = getTag((request.params as { tagId: string }).tagId);
    if (!tag) {
      return reply.code(404).send({ error: "Tag not found" });
    }
    const editors = db.prepare(`
      SELECT a.subject_type AS subjectType, a.subject_id AS subjectId, a.role, a.created_at AS createdAt,
        COALESCE(u.display_name, g.name) AS name,
        u.email AS email,
        ((a.subject_type = 'user' AND u.id IS NULL) OR (a.subject_type = 'group' AND g.id IS NULL)) AS missing
      FROM assignments a
      LEFT JOIN users u ON a.subject_type = 'user' AND u.id = a.subject_id
      LEFT JOIN user_groups g ON a.subject_type = 'group' AND g.id = a.subject_id
      WHERE a.object_type = '${FAMILY_TAG_OBJECT_TYPE}' AND a.object_id = ?
      ORDER BY a.subject_type, name COLLATE NOCASE
    `).all(tag.id);
    return reply.send({ tag, editors });
  });

  app.post("/api/family-tree/tags/:tagId/editors", { preHandler: app.requireAdmin }, async (request, reply) => {
    const tag = getTag((request.params as { tagId: string }).tagId);
    if (!tag) {
      return reply.code(404).send({ error: "Tag not found" });
    }
    const parsed = parseBody(editorGrantSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid grant", details: parsed.error });
    }
    const { subjectType, subjectId, role } = parsed.data;
    const subjectTable = subjectType === "user" ? "users" : "user_groups";
    if (!db.prepare(`SELECT 1 FROM ${subjectTable} WHERE id = ?`).get(subjectId)) {
      return reply.code(404).send({ error: subjectType === "user" ? "User not found" : "Group not found" });
    }
    db.prepare(`
      INSERT INTO assignments (subject_type, subject_id, object_type, object_id, role, created_by)
      VALUES (?, ?, '${FAMILY_TAG_OBJECT_TYPE}', ?, ?, ?)
      ON CONFLICT (subject_type, subject_id, object_type, object_id) DO UPDATE SET role = excluded.role, created_by = excluded.created_by
    `).run(subjectType, subjectId, tag.id, role, request.user!.id);
    logActivity({
      event: "familytree.editor.granted",
      actorUserId: request.user!.id,
      targetType: "family_tree_tag",
      targetId: tag.id,
      detail: `Granted ${role === "deny" ? "an edit block" : "edit rights"} on family tag "${tag.name}" to a ${subjectType}.`,
      ipAddress: request.ip
    });
    return reply.code(201).send({ granted: true });
  });

  app.delete("/api/family-tree/tags/:tagId/editors/:subjectType/:subjectId", { preHandler: app.requireAdmin }, async (request, reply) => {
    const { tagId, subjectType, subjectId } = request.params as { tagId: string; subjectType: string; subjectId: string };
    const tag = getTag(tagId);
    if (!tag || (subjectType !== "user" && subjectType !== "group")) {
      return reply.code(404).send({ error: "Tag not found" });
    }
    const res = db.prepare(
      `DELETE FROM assignments WHERE object_type = '${FAMILY_TAG_OBJECT_TYPE}' AND object_id = ? AND subject_type = ? AND subject_id = ?`
    ).run(tag.id, subjectType, subjectId);
    if (res.changes === 0) {
      return reply.code(404).send({ error: "Grant not found" });
    }
    logActivity({
      event: "familytree.editor.revoked",
      actorUserId: request.user!.id,
      targetType: "family_tree_tag",
      targetId: tag.id,
      detail: `Revoked edit rights on family tag "${tag.name}" from a ${subjectType}.`,
      ipAddress: request.ip
    });
    return reply.send({ revoked: true });
  });
}
