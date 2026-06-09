import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, logActivity } from "../../../db.js";
import { parseBody } from "../../../core/shared.js";
import {
  LIBRARY_ROLES,
  canUserManageLibraryMembers,
  type LibraryRole
} from "./library-access.js";

interface LibraryRow {
  id: string;
  name: string;
  owner_id: string | null;
  owner_type: "user" | "group" | null;
  visibility: "private" | "public";
}

const grantSchema = z.object({
  subjectType: z.enum(["user", "group"]),
  subjectId: z.string().trim().min(1).max(64),
  role: z.enum(LIBRARY_ROLES as unknown as [LibraryRole, ...LibraryRole[]])
});

// Per-library role grants. The library owner and app-admins are implicit Library
// Admins (resolved in code), so they never appear here — this manages the
// *additional* users/groups granted a role. See Documents/library-sharing.md.
export async function libraryMembersPlugin(app: FastifyInstance) {
  // Load the library and verify the caller may manage its members.
  function loadManageable(libraryId: string, userId: string, userRole: string): LibraryRow | null {
    const library = db.prepare(
      "SELECT id, name, owner_id, owner_type, visibility FROM libraries WHERE id = ?"
    ).get(libraryId) as LibraryRow | undefined;
    if (!library) return null;
    if (!canUserManageLibraryMembers(library, userId, userRole)) return null;
    return library;
  }

  app.get("/api/library/libraries/:id/members", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const user = request.user!;
    const library = loadManageable(id, user.id, user.role);
    if (!library) {
      reply.code(403).send({ error: "You don't have permission to manage this library's members." });
      return;
    }

    const rows = db.prepare(`
      SELECT
        lm.subject_type,
        lm.subject_id,
        lm.role,
        lm.created_at,
        CASE lm.subject_type WHEN 'user' THEN u.display_name ELSE g.name END AS name,
        CASE lm.subject_type WHEN 'user' THEN u.email ELSE NULL END AS email,
        CASE
          WHEN lm.subject_type = 'user' AND u.id IS NULL THEN 1
          WHEN lm.subject_type = 'group' AND g.id IS NULL THEN 1
          ELSE 0
        END AS missing
      FROM library_members lm
      LEFT JOIN users u ON lm.subject_type = 'user' AND u.id = lm.subject_id
      LEFT JOIN user_groups g ON lm.subject_type = 'group' AND g.id = lm.subject_id
      WHERE lm.library_id = ?
      ORDER BY lm.subject_type, name COLLATE NOCASE
    `).all(id) as {
      subject_type: "user" | "group";
      subject_id: string;
      role: LibraryRole;
      created_at: string;
      name: string | null;
      email: string | null;
      missing: number;
    }[];

    reply.send({
      members: rows.map((row) => ({
        subjectType: row.subject_type,
        subjectId: row.subject_id,
        role: row.role,
        name: row.name ?? "(deleted)",
        email: row.email,
        missing: Boolean(row.missing),
        createdAt: row.created_at
      }))
    });
  });

  app.post("/api/library/libraries/:id/members", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const user = request.user!;
    const library = loadManageable(id, user.id, user.role);
    if (!library) {
      reply.code(403).send({ error: "You don't have permission to manage this library's members." });
      return;
    }

    const parsed = parseBody(grantSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid role grant", details: parsed.error });
      return;
    }
    const { subjectType, subjectId, role } = parsed.data;

    if (subjectType === "user") {
      const exists = db.prepare("SELECT id FROM users WHERE id = ? AND deleted_at IS NULL AND is_active = 1").get(subjectId);
      if (!exists) {
        reply.code(404).send({ error: "User not found." });
        return;
      }
    } else {
      const exists = db.prepare("SELECT id FROM user_groups WHERE id = ?").get(subjectId);
      if (!exists) {
        reply.code(404).send({ error: "Group not found." });
        return;
      }
    }

    db.prepare(`
      INSERT INTO library_members (library_id, subject_type, subject_id, role, created_by)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (library_id, subject_type, subject_id)
      DO UPDATE SET role = excluded.role, created_by = excluded.created_by
    `).run(id, subjectType, subjectId, role, user.id);

    logActivity({
      event: "library.member.granted",
      actorUserId: user.id,
      targetType: "library",
      targetId: id,
      detail: `Granted ${subjectType} ${subjectId} the "${role}" role on library "${library.name}".`,
      ipAddress: request.ip
    });

    reply.code(201).send({ granted: true });
  });

  app.delete("/api/library/libraries/:id/members/:subjectType/:subjectId", { preHandler: app.authenticate }, async (request, reply) => {
    const { id, subjectType, subjectId } = request.params as { id: string; subjectType: string; subjectId: string };
    const user = request.user!;
    const library = loadManageable(id, user.id, user.role);
    if (!library) {
      reply.code(403).send({ error: "You don't have permission to manage this library's members." });
      return;
    }
    if (subjectType !== "user" && subjectType !== "group") {
      reply.code(400).send({ error: "Invalid subject type." });
      return;
    }

    const result = db.prepare(
      "DELETE FROM library_members WHERE library_id = ? AND subject_type = ? AND subject_id = ?"
    ).run(id, subjectType, subjectId);
    if (result.changes === 0) {
      reply.code(404).send({ error: "Grant not found." });
      return;
    }

    logActivity({
      event: "library.member.revoked",
      actorUserId: user.id,
      targetType: "library",
      targetId: id,
      detail: `Revoked ${subjectType} ${subjectId}'s role on library "${library.name}".`,
      ipAddress: request.ip
    });

    reply.send({ revoked: true });
  });
}
