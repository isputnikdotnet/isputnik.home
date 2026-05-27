import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { z } from "zod";
import { config } from "./config.js";
import { db, hasUsers, logActivity, publicUser, type Role, type User } from "./db.js";
import { hashPassword, sha256, verifyPassword } from "./crypto.js";
import { addDays, clearSession, currentSessionHash, currentUserPayload, issueSession, revokeCurrentSession } from "./auth.js";

const credentialsSchema = z.object({
  email: z.string().email().transform((value) => value.trim().toLowerCase()),
  password: z.string().min(8, "Password must be at least 8 characters").max(200)
});

const setupSchema = credentialsSchema.extend({
  displayName: z.string().trim().min(2).max(80)
});

const inviteSchema = z.object({
  role: z.enum(["admin", "member"]).default("member"),
  expiresInDays: z.number().int().min(1).max(30).default(config.inviteDays)
});

const profileSchema = z.object({
  displayName: z.string().trim().min(2).max(80),
  theme: z.enum(["system", "light", "dark"])
});

const roleSchema = z.object({
  role: z.enum(["admin", "member"])
});

const logQuerySchema = z.object({
  q: z.string().trim().max(100).default(""),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(100).default(25)
});

const logCleanupSchema = z.object({
  olderThanDays: z.number().int().min(1).max(3650).default(365)
});

function parseBody<T>(schema: z.ZodSchema<T>, body: unknown) {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return { error: parsed.error.flatten() };
  }

  return { data: parsed.data };
}

function getUserByEmail(email: string) {
  return db.prepare("SELECT * FROM users WHERE email = ? AND deleted_at IS NULL").get(email) as User | undefined;
}

interface InviteListRow {
  id: string;
  token: string | null;
  role: Role;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  created_by_name: string;
  used_by_name: string | null;
}

interface UserListRow extends User {
  active_sessions: number;
}

interface SessionListRow {
  id: string;
  token_hash: string;
  created_at: string;
  expires_at: string;
  last_seen: string;
  device_name: string | null;
  ip_address: string | null;
  user_id: string;
  display_name: string;
  email: string;
}

interface LogRow {
  id: string;
  event: string;
  detail: string;
  ip_address: string | null;
  created_at: string;
  actor_name: string | null;
}

function databaseSize() {
  return [config.dbPath, `${config.dbPath}-wal`, `${config.dbPath}-shm`].reduce((total, file) => (
    total + (fs.existsSync(file) ? fs.statSync(file).size : 0)
  ), 0);
}

export async function registerRoutes(app: FastifyInstance) {
  app.get("/api/setup/status", async () => ({
    requiresSetup: !hasUsers()
  }));

  app.post("/api/setup/admin", async (request, reply) => {
    if (hasUsers()) {
      reply.code(409).send({ error: "Setup has already been completed" });
      return;
    }

    const parsed = parseBody(setupSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid setup details", details: parsed.error });
      return;
    }

    const userId = nanoid(16);
    const passwordHash = await hashPassword(parsed.data.password);
    const user = db.transaction(() => {
      db.prepare(`
        INSERT INTO users (id, email, password_hash, display_name, role, protected_from_delete)
        VALUES (?, ?, ?, ?, 'admin', 1)
      `).run(userId, parsed.data.email, passwordHash, parsed.data.displayName);

      return db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as User;
    })();

    issueSession(reply, user.id, request);
    logActivity({
      event: "account.setup",
      actorUserId: user.id,
      targetType: "user",
      targetId: user.id,
      detail: "Created the setup administrator account.",
      ipAddress: request.ip
    });
    reply.code(201).send({ user: publicUser(user) });
  });

  app.post("/api/auth/login", async (request, reply) => {
    const parsed = parseBody(credentialsSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid login details", details: parsed.error });
      return;
    }

    const user = getUserByEmail(parsed.data.email);
    if (!user || !user.is_active || !(await verifyPassword(parsed.data.password, user.password_hash))) {
      logActivity({
        event: "auth.login_failed",
        detail: "A sign-in attempt failed.",
        ipAddress: request.ip
      });
      reply.code(401).send({ error: "Invalid email or password" });
      return;
    }

    issueSession(reply, user.id, request);
    logActivity({
      event: "auth.login",
      actorUserId: user.id,
      targetType: "user",
      targetId: user.id,
      detail: "Signed in.",
      ipAddress: request.ip
    });
    reply.send({ user: publicUser(user) });
  });

  app.post("/api/auth/logout", { preHandler: app.authenticate }, async (request, reply) => {
    logActivity({
      event: "auth.logout",
      actorUserId: request.user!.id,
      targetType: "user",
      targetId: request.user!.id,
      detail: "Signed out.",
      ipAddress: request.ip
    });
    revokeCurrentSession(request);
    clearSession(reply);
    reply.send({ ok: true });
  });

  app.get("/api/auth/me", { preHandler: app.authenticate }, async (request) => ({
    user: currentUserPayload(request)
  }));

  app.patch("/api/profile", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(profileSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid profile details", details: parsed.error });
      return;
    }

    db.prepare(`
      UPDATE users
      SET display_name = ?, theme = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(parsed.data.displayName, parsed.data.theme, request.user!.id);

    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(request.user!.id) as User;
    logActivity({
      event: "profile.updated",
      actorUserId: user.id,
      targetType: "user",
      targetId: user.id,
      detail: "Updated profile settings.",
      ipAddress: request.ip
    });
    reply.send({ user: publicUser(user) });
  });

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
    db.prepare(`
      INSERT INTO invites (id, token_hash, token, role, created_by, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(inviteId, sha256(token), token, parsed.data.role, request.user!.id, expiresAt);
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
        url: `${config.appUrl}/invite/${token}`
      }
    });
  });

  app.get("/api/invites", { preHandler: app.requireAdmin }, async () => {
    const invites = db.prepare(`
      SELECT
        invites.id,
        invites.token,
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
        url: invite.token ? `${config.appUrl}/invite/${invite.token}` : null,
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
        INSERT INTO users (id, email, password_hash, display_name, role)
        VALUES (?, ?, ?, ?, ?)
      `).run(userId, parsed.data.email, passwordHash, parsed.data.displayName, invite.role);
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

  app.get("/api/users", { preHandler: app.requireAdmin }, async () => {
    const users = db.prepare(`
      SELECT
        users.*,
        COUNT(sessions.id) AS active_sessions
      FROM users
      LEFT JOIN sessions ON sessions.user_id = users.id
        AND sessions.revoked_at IS NULL
        AND datetime(sessions.expires_at) > CURRENT_TIMESTAMP
      WHERE users.deleted_at IS NULL
      GROUP BY users.id
      ORDER BY datetime(users.created_at) ASC
    `).all() as UserListRow[];

    return {
      users: users.map((user) => ({
        ...publicUser(user),
        activeSessions: user.active_sessions
      }))
    };
  });

  app.patch("/api/users/:id/role", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const parsed = parseBody(roleSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid account role", details: parsed.error });
      return;
    }

    const user = db.prepare("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL").get(id) as User | undefined;
    if (!user) {
      reply.code(404).send({ error: "User not found" });
      return;
    }

    if (user.protected_from_delete || id === request.user!.id) {
      reply.code(409).send({ error: "This administrator role cannot be changed here" });
      return;
    }

    db.prepare("UPDATE users SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(parsed.data.role, id);
    logActivity({
      event: "user.role_changed",
      actorUserId: request.user!.id,
      targetType: "user",
      targetId: id,
      detail: `Changed ${user.display_name}'s role to ${parsed.data.role}.`,
      ipAddress: request.ip
    });
    const updated = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as User;
    reply.send({ user: publicUser(updated) });
  });

  app.delete("/api/users/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const user = db.prepare("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL").get(id) as User | undefined;
    if (!user) {
      reply.code(404).send({ error: "User not found" });
      return;
    }

    if (user.protected_from_delete) {
      reply.code(409).send({ error: "This protected setup admin cannot be deleted" });
      return;
    }

    if (user.id === request.user!.id) {
      reply.code(409).send({ error: "You cannot deactivate your current account" });
      return;
    }

    db.transaction(() => {
      db.prepare("UPDATE users SET deleted_at = CURRENT_TIMESTAMP, is_active = 0 WHERE id = ?").run(id);
      db.prepare("UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ?").run(id);
    })();

    logActivity({
      event: "user.deactivated",
      actorUserId: request.user!.id,
      targetType: "user",
      targetId: id,
      detail: `Deactivated ${user.display_name}'s account.`,
      ipAddress: request.ip
    });
    reply.send({ ok: true });
  });

  app.get("/api/sessions", { preHandler: app.requireAdmin }, async (request) => {
    const rows = db.prepare(`
      SELECT
        sessions.id,
        sessions.token_hash,
        sessions.created_at,
        sessions.expires_at,
        sessions.last_seen,
        sessions.device_name,
        sessions.ip_address,
        users.id AS user_id,
        users.display_name,
        users.email
      FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.revoked_at IS NULL
        AND datetime(sessions.expires_at) > CURRENT_TIMESTAMP
        AND users.deleted_at IS NULL
      ORDER BY datetime(sessions.last_seen) DESC
    `).all() as SessionListRow[];
    const tokenHash = currentSessionHash(request);

    return {
      sessions: rows.map((session) => ({
        id: session.id,
        userId: session.user_id,
        displayName: session.display_name,
        email: session.email,
        createdAt: session.created_at,
        expiresAt: session.expires_at,
        lastSeen: session.last_seen,
        deviceName: session.device_name,
        ipAddress: session.ip_address,
        current: session.token_hash === tokenHash
      }))
    };
  });

  app.delete("/api/sessions/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const session = db.prepare("SELECT id, token_hash, user_id FROM sessions WHERE id = ? AND revoked_at IS NULL").get(id) as {
      id: string;
      token_hash: string;
      user_id: string;
    } | undefined;
    if (!session) {
      reply.code(404).send({ error: "Session not found" });
      return;
    }

    if (session.token_hash === currentSessionHash(request)) {
      reply.code(409).send({ error: "Use sign out to end your current session" });
      return;
    }

    db.prepare("UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
    logActivity({
      event: "session.revoked",
      actorUserId: request.user!.id,
      targetType: "user",
      targetId: session.user_id,
      detail: "Revoked an active session.",
      ipAddress: request.ip
    });
    reply.send({ ok: true });
  });

  app.get("/api/logs", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(logQuerySchema, request.query);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid log query", details: parsed.error });
      return;
    }

    const query = parsed.data.q ?? "";
    const pageSize = parsed.data.pageSize ?? 25;
    const requestedPage = parsed.data.page ?? 1;
    const search = `%${query}%`;
    const where = query
      ? `WHERE activity_logs.event LIKE @search
          OR activity_logs.detail LIKE @search
          OR activity_logs.ip_address LIKE @search
          OR users.display_name LIKE @search`
      : "";
    const count = db.prepare(`
      SELECT COUNT(*) AS count
      FROM activity_logs
      LEFT JOIN users ON users.id = activity_logs.actor_user_id
      ${where}
    `).get({ search }) as { count: number };
    const totalPages = Math.max(1, Math.ceil(count.count / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const rows = db.prepare(`
      SELECT
        activity_logs.id,
        activity_logs.event,
        activity_logs.detail,
        activity_logs.ip_address,
        activity_logs.created_at,
        users.display_name AS actor_name
      FROM activity_logs
      LEFT JOIN users ON users.id = activity_logs.actor_user_id
      ${where}
      ORDER BY datetime(activity_logs.created_at) DESC, activity_logs.id DESC
      LIMIT @pageSize OFFSET @offset
    `).all({
      search,
      pageSize,
      offset: (page - 1) * pageSize
    }) as LogRow[];

    return {
      logs: rows.map((row) => ({
        id: row.id,
        event: row.event,
        detail: row.detail,
        ipAddress: row.ip_address,
        createdAt: row.created_at,
        actorName: row.actor_name
      })),
      page,
      pageSize,
      total: count.count,
      totalPages
    };
  });

  app.delete("/api/logs", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(logCleanupSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid log cleanup period", details: parsed.error });
      return;
    }

    const result = db.prepare(`
      DELETE FROM activity_logs
      WHERE datetime(created_at) < datetime('now', ?)
    `).run(`-${parsed.data.olderThanDays} days`);

    if (result.changes > 0) {
      logActivity({
        event: "logs.deleted",
        actorUserId: request.user!.id,
        targetType: "log",
        detail: `Deleted ${result.changes} log entries older than ${parsed.data.olderThanDays} days.`,
        ipAddress: request.ip
      });
    }

    reply.send({ deleted: result.changes, olderThanDays: parsed.data.olderThanDays });
  });

  app.get("/api/status", { preHandler: app.requireAdmin }, async () => {
    const users = db.prepare("SELECT COUNT(*) AS count FROM users WHERE deleted_at IS NULL").get() as { count: number };
    const sessions = db.prepare(`
      SELECT COUNT(*) AS count FROM sessions
      WHERE revoked_at IS NULL AND datetime(expires_at) > CURRENT_TIMESTAMP
    `).get() as { count: number };
    const activeInvites = db.prepare(`
      SELECT COUNT(*) AS count FROM invites
      WHERE revoked_at IS NULL AND used_at IS NULL AND datetime(expires_at) > CURRENT_TIMESTAMP
    `).get() as { count: number };
    const events = db.prepare("SELECT COUNT(*) AS count FROM activity_logs").get() as { count: number };

    return {
      status: {
        health: "Operational",
        databaseBytes: databaseSize(),
        users: users.count,
        activeSessions: sessions.count,
        activeInvites: activeInvites.count,
        logEntries: events.count,
        uptimeSeconds: Math.floor(process.uptime()),
        generatedAt: new Date().toISOString()
      }
    };
  });

  app.get("/api/about", { preHandler: app.authenticate }, async () => ({
    about: {
      name: "isputnik.home",
      version: config.version,
      description: config.description,
      runtime: `Node.js ${process.version}`,
      database: "SQLite (WAL mode)",
      server: "Fastify + TypeScript",
      frontend: "React + TypeScript",
      versionUpdates: [
        {
          version: config.version,
          label: "Current development version",
          changes: [
            "Added the application shell with protected routes, profile settings, and light, dark, and system themes.",
            "Added invite-only account creation with copyable invitation links, link status, and revocation.",
            "Added the control panel with status, logs, user roles, active session management, and About.",
            "Grouped control-panel navigation and made About available in the main application.",
            "Added compact log search, paging, and manual retention cleanup with a 365-day default."
          ]
        }
      ]
    }
  }));
}
