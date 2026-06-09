import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { db, logActivity } from "../db.js";
import { parseBody } from "./shared.js";
import { deleteLibraryMembersForSubject } from "../modules/library/shared/library-access.js";

const groupSchema = z.object({
  name: z.string().trim().min(2).max(80)
});

const memberSchema = z.object({
  userId: z.string().trim().min(1),
  role: z.enum(["member", "manager"]).default("member")
});

const roleSchema = z.object({
  role: z.enum(["member", "manager"])
});

interface GroupRow {
  id: string;
  name: string;
  created_at: string;
  member_count: number;
  library_count: number;
}

interface MemberRow {
  user_id: string;
  display_name: string;
  email: string;
  role: "member" | "manager";
  joined_at: string;
}

export async function groupsPlugin(app: FastifyInstance) {
  app.get("/api/groups", { preHandler: app.requireAdmin }, async () => {
    const groups = db.prepare(`
      SELECT
        ug.id,
        ug.name,
        ug.created_at,
        COUNT(DISTINCT gm.user_id) AS member_count,
        COUNT(DISTINCT l.id) AS library_count
      FROM user_groups ug
      LEFT JOIN group_members gm ON gm.group_id = ug.id
      LEFT JOIN libraries l ON l.owner_id = ug.id AND l.owner_type = 'group'
      GROUP BY ug.id
      ORDER BY ug.name COLLATE NOCASE
    `).all() as GroupRow[];

    return {
      groups: groups.map((g) => ({
        id: g.id,
        name: g.name,
        createdAt: g.created_at,
        memberCount: g.member_count,
        libraryCount: g.library_count
      }))
    };
  });

  app.post("/api/groups", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(groupSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid group details", details: parsed.error });
      return;
    }

    const id = nanoid(16);
    try {
      db.prepare("INSERT INTO user_groups (id, name, created_by) VALUES (?, ?, ?)")
        .run(id, parsed.data.name, request.user!.id);
    } catch {
      reply.code(409).send({ error: "A group with that name already exists." });
      return;
    }

    logActivity({
      event: "groups.created",
      actorUserId: request.user!.id,
      targetType: "group",
      targetId: id,
      detail: `Created group "${parsed.data.name}".`,
      ipAddress: request.ip
    });

    reply.code(201).send({ group: { id, name: parsed.data.name, createdAt: new Date().toISOString(), memberCount: 0, libraryCount: 0 } });
  });

  app.delete("/api/groups/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const group = db.prepare("SELECT id, name FROM user_groups WHERE id = ?").get(id) as { id: string; name: string } | undefined;
    if (!group) {
      reply.code(404).send({ error: "Group not found" });
      return;
    }

    const inUse = db.prepare("SELECT COUNT(*) AS count FROM libraries WHERE owner_id = ? AND owner_type = 'group'")
      .get(id) as { count: number };
    if (inUse.count > 0) {
      reply.code(409).send({ error: "This group owns one or more libraries. Reassign them before deleting the group." });
      return;
    }

    db.transaction(() => {
      // Grants reference the group by id with no FK, so clear them before the group row goes.
      deleteLibraryMembersForSubject("group", id);
      db.prepare("DELETE FROM user_groups WHERE id = ?").run(id);
    })();
    logActivity({
      event: "groups.deleted",
      actorUserId: request.user!.id,
      targetType: "group",
      targetId: id,
      detail: `Deleted group "${group.name}".`,
      ipAddress: request.ip
    });
    reply.send({ ok: true });
  });

  app.get("/api/groups/:id/members", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const group = db.prepare("SELECT id, name FROM user_groups WHERE id = ?").get(id) as { id: string; name: string } | undefined;
    if (!group) {
      reply.code(404).send({ error: "Group not found" });
      return;
    }

    const members = db.prepare(`
      SELECT gm.user_id, u.display_name, u.email, gm.role, gm.joined_at
      FROM group_members gm
      JOIN users u ON u.id = gm.user_id
      WHERE gm.group_id = ?
      ORDER BY u.display_name COLLATE NOCASE
    `).all(id) as MemberRow[];

    return {
      group: { id: group.id, name: group.name },
      members: members.map((m) => ({
        userId: m.user_id,
        displayName: m.display_name,
        email: m.email,
        role: m.role,
        joinedAt: m.joined_at
      }))
    };
  });

  app.post("/api/groups/:id/members", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const parsed = parseBody(memberSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid member details", details: parsed.error });
      return;
    }

    const group = db.prepare("SELECT id FROM user_groups WHERE id = ?").get(id);
    if (!group) {
      reply.code(404).send({ error: "Group not found" });
      return;
    }

    const user = db.prepare("SELECT id FROM users WHERE id = ? AND deleted_at IS NULL AND is_active = 1").get(parsed.data.userId);
    if (!user) {
      reply.code(404).send({ error: "User not found" });
      return;
    }

    try {
      db.prepare("INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)")
        .run(id, parsed.data.userId, parsed.data.role);
    } catch {
      reply.code(409).send({ error: "User is already a member of this group." });
      return;
    }

    reply.code(201).send({ ok: true });
  });

  app.patch("/api/groups/:id/members/:userId", { preHandler: app.requireAdmin }, async (request, reply) => {
    const { id, userId } = request.params as { id: string; userId: string };
    const parsed = parseBody(roleSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid role", details: parsed.error });
      return;
    }

    const updated = db.prepare("UPDATE group_members SET role = ? WHERE group_id = ? AND user_id = ?")
      .run(parsed.data.role, id, userId);
    if (updated.changes === 0) {
      reply.code(404).send({ error: "Member not found" });
      return;
    }

    reply.send({ ok: true });
  });

  app.delete("/api/groups/:id/members/:userId", { preHandler: app.requireAdmin }, async (request, reply) => {
    const { id, userId } = request.params as { id: string; userId: string };
    const deleted = db.prepare("DELETE FROM group_members WHERE group_id = ? AND user_id = ?").run(id, userId);
    if (deleted.changes === 0) {
      reply.code(404).send({ error: "Member not found" });
      return;
    }
    reply.send({ ok: true });
  });
}
