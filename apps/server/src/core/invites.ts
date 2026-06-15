import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { nanoid } from "nanoid";
import { db, logActivity, publicUser, type Role, type User } from "../db.js";
import { sha256, hashPassword } from "../crypto.js";
import { addDays, issueSession } from "../auth.js";
import { config } from "../config.js";
import { parseBody, setupSchema, getUserByEmail } from "./shared.js";
import { getDefaultTheme } from "./app-config.js";

const inviteSchema = z.object({
  role: z.enum(["admin", "member"]).default("member"),
  expiresInDays: z.number().int().min(1).max(30).default(config.inviteDays)
});

// Prefer the origin of the page the admin is actually using (sent by the browser
// on the fetch), so invite links match the real URL — a LAN address or public
// domain — instead of the configured default. Fall back to config.appUrl.
// Trim trailing slashes without a backtracking-prone regex: the Origin header is
// attacker-controlled and /\/+$/ is quadratic on a long run of slashes.
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47 /* "/" */) end -= 1;
  return value.slice(0, end);
}

function inviteOrigin(request: FastifyRequest): string {
  const origin = request.headers.origin;
  if (typeof origin === "string" && /^https?:\/\/.+/i.test(origin)) {
    return stripTrailingSlashes(origin);
  }
  return stripTrailingSlashes(config.appUrl);
}

interface InviteListRow {
  id: string;
  role: Role;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  created_by_name: string;
  used_by_name: string | null;
}

export async function invitesPlugin(app: FastifyInstance) {
  app.post("/api/invites", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(inviteSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid invite details", details: parsed.error });
      return;
    }

    const token = nanoid(36);
    const inviteId = nanoid(16);
    const expiresInDays = parsed.data.expiresInDays ?? config.inviteDays;
    const expiresAt = addDays(expiresInDays).toISOString();
    // Only the hash is stored; the raw token is shown once below and never persisted.
    db.prepare(`
      INSERT INTO invites (id, token_hash, role, created_by, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(inviteId, sha256(token), parsed.data.role, request.user!.id, expiresAt);
    logActivity({
      event: "invite.created",
      actorUserId: request.user!.id,
      targetType: "invite",
      targetId: inviteId,
      detail: `Created a ${parsed.data.role} invite link.`,
      ipAddress: request.ip
    });

    reply.code(201).send({
      invite: {
        id: inviteId,
        role: parsed.data.role,
        expiresAt,
        url: `${inviteOrigin(request)}/invite/${token}`
      }
    });
  });

  app.get("/api/invites", { preHandler: app.requireAdmin }, async () => {
    const invites = db.prepare(`
      SELECT
        invites.id,
        invites.role,
        invites.created_at,
        invites.expires_at,
        invites.used_at,
        creator.display_name AS created_by_name,
        used.display_name AS used_by_name
      FROM invites
      JOIN users AS creator ON creator.id = invites.created_by
      LEFT JOIN users AS used ON used.id = invites.used_by
      WHERE invites.revoked_at IS NULL
      ORDER BY datetime(invites.created_at) DESC
    `).all() as InviteListRow[];
    const now = Date.now();

    return {
      invites: invites.map((invite) => ({
        id: invite.id,
        role: invite.role,
        // The raw token is never stored, so the link can't be rebuilt later —
        // it's shown only once when the invite is created.
        url: null,
        createdAt: invite.created_at,
        expiresAt: invite.expires_at,
        usedAt: invite.used_at,
        createdByName: invite.created_by_name,
        usedByName: invite.used_by_name,
        status: invite.used_at ? "used" : new Date(invite.expires_at).getTime() <= now ? "expired" : "active"
      }))
    };
  });

  app.delete("/api/invites/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const result = db.prepare(`
      UPDATE invites
      SET revoked_at = CURRENT_TIMESTAMP
      WHERE id = ? AND revoked_at IS NULL
    `).run(id);

    if (result.changes === 0) {
      reply.code(404).send({ error: "Invite link not found" });
      return;
    }

    logActivity({
      event: "invite.revoked",
      actorUserId: request.user!.id,
      targetType: "invite",
      targetId: id,
      detail: "Revoked an invite link.",
      ipAddress: request.ip
    });
    reply.send({ ok: true });
  });

  app.get("/api/invites/:token", async (request, reply) => {
    const token = (request.params as { token: string }).token;
    const invite = db.prepare(`
      SELECT id, role, expires_at
      FROM invites
      WHERE token_hash = ?
        AND used_at IS NULL
        AND revoked_at IS NULL
        AND datetime(expires_at) > CURRENT_TIMESTAMP
    `).get(sha256(token)) as { id: string; role: Role; expires_at: string } | undefined;

    if (!invite) {
      reply.code(404).send({ error: "Invite is invalid or expired" });
      return;
    }

    reply.send({ invite: { id: invite.id, role: invite.role, expiresAt: invite.expires_at } });
  });

  app.post("/api/invites/:token/accept", async (request, reply) => {
    const token = (request.params as { token: string }).token;
    const parsed = parseBody(setupSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid account details", details: parsed.error });
      return;
    }

    const invite = db.prepare(`
      SELECT id, role
      FROM invites
      WHERE token_hash = ?
        AND used_at IS NULL
        AND revoked_at IS NULL
        AND datetime(expires_at) > CURRENT_TIMESTAMP
    `).get(sha256(token)) as { id: string; role: Role } | undefined;

    if (!invite) {
      reply.code(404).send({ error: "Invite is invalid or expired" });
      return;
    }

    if (getUserByEmail(parsed.data.email)) {
      reply.code(409).send({ error: "An account with this email already exists" });
      return;
    }

    const userId = nanoid(16);
    const passwordHash = await hashPassword(parsed.data.password);
    const user = db.transaction(() => {
      db.prepare(`
        INSERT INTO users (id, email, password_hash, display_name, role, theme)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(userId, parsed.data.email, passwordHash, parsed.data.displayName, invite.role, getDefaultTheme());
      db.prepare("UPDATE invites SET used_at = CURRENT_TIMESTAMP, used_by = ? WHERE id = ?").run(userId, invite.id);
      return db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as User;
    })();

    issueSession(reply, user.id, request);
    logActivity({
      event: "invite.accepted",
      actorUserId: user.id,
      targetType: "invite",
      targetId: invite.id,
      detail: "Accepted an invite and created an account.",
      ipAddress: request.ip
    });
    reply.code(201).send({ user: publicUser(user) });
  });
}
