import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, logActivity } from "../../../db.js";
import { parseBody } from "../../../core/shared.js";
import { canUserManageLibraryMembers } from "./library-access.js";
import { EVERYONE_GROUP_ID } from "../../../core/permissions.js";

// Roles grantable to a specific user/group on a library. `deny` is an explicit block;
// `member` = view+download. The Everyone baseline (public access) is managed via the
// library's public setting, not here. See Documents/permissions.md.
const GRANTABLE_ROLES = ["viewer", "member", "contributor", "manager", "deny"] as const;
type GrantRole = (typeof GRANTABLE_ROLES)[number];

interface LibraryRow {
  id: string;
  name: string;
}

const grantSchema = z.object({
  subjectType: z.enum(["user", "group"]),
  subjectId: z.string().trim().min(1).max(64),
  role: z.enum(GRANTABLE_ROLES as unknown as [GrantRole, ...GrantRole[]])
});

// Per-library role assignments. The Everyone baseline and the owner's implicit manager
// grant are managed elsewhere; this manages the *additional* users/groups.
export async function libraryMembersPlugin(app: FastifyInstance) {
  function loadManageable(libraryId: string, userId: string, userRole: string): LibraryRow | null {
    const library = db.prepare("SELECT id, name FROM libraries WHERE id = ?").get(libraryId) as LibraryRow | undefined;
    if (!library) return null;
    if (!canUserManageLibraryMembers({ id: library.id }, userId, userRole)) return null;
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

    // Exclude the Everyone grant — that's the library's public baseline, shown/managed
    // through the library's public-access setting, not the members list.
    const rows = db.prepare(`
      SELECT
        a.subject_type,
        a.subject_id,
        a.role,
        a.created_at,
        CASE a.subject_type WHEN 'user' THEN u.display_name ELSE g.name END AS name,
        CASE a.subject_type WHEN 'user' THEN u.email ELSE NULL END AS email,
        CASE
          WHEN a.subject_type = 'user' AND u.id IS NULL THEN 1
          WHEN a.subject_type = 'group' AND g.id IS NULL THEN 1
          ELSE 0
        END AS missing
      FROM assignments a
      LEFT JOIN users u ON a.subject_type = 'user' AND u.id = a.subject_id
      LEFT JOIN user_groups g ON a.subject_type = 'group' AND g.id = a.subject_id
      WHERE a.object_type = 'library' AND a.object_id = ?
        AND NOT (a.subject_type = 'group' AND a.subject_id = ?)
      ORDER BY a.subject_type, name COLLATE NOCASE
    `).all(id, EVERYONE_GROUP_ID) as {
      subject_type: "user" | "group";
      subject_id: string;
      role: GrantRole;
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
      INSERT INTO assignments (subject_type, subject_id, object_type, object_id, role, created_by)
      VALUES (?, ?, 'library', ?, ?, ?)
      ON CONFLICT (subject_type, subject_id, object_type, object_id)
      DO UPDATE SET role = excluded.role, created_by = excluded.created_by
    `).run(subjectType, subjectId, id, role, user.id);

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
      "DELETE FROM assignments WHERE object_type = 'library' AND object_id = ? AND subject_type = ? AND subject_id = ?"
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

  // Take ownership — admin-only escape hatch for a private library the admin can't
  // otherwise reach. Adds a manager grant for the admin and logs it, so access to a
  // private library is always a visible, deliberate act. See Documents/permissions.md.
  app.post("/api/library/libraries/:id/take-ownership", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const user = request.user!;
    const library = db.prepare("SELECT id, name FROM libraries WHERE id = ?").get(id) as LibraryRow | undefined;
    if (!library) {
      reply.code(404).send({ error: "Library not found" });
      return;
    }

    db.prepare(`
      INSERT INTO assignments (subject_type, subject_id, object_type, object_id, role, created_by)
      VALUES ('user', ?, 'library', ?, 'manager', ?)
      ON CONFLICT (subject_type, subject_id, object_type, object_id) DO UPDATE SET role = 'manager'
    `).run(user.id, id, user.id);

    logActivity({
      event: "library.ownership.taken",
      actorUserId: user.id,
      targetType: "library",
      targetId: id,
      detail: `Took ownership (manager) of library "${library.name}".`,
      ipAddress: request.ip
    });

    reply.send({ ok: true });
  });
}
