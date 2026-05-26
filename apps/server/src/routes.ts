import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { z } from "zod";
import { config } from "./config.js";
import { db, hasUsers, publicUser, type Role, type User } from "./db.js";
import { hashPassword, sha256, verifyPassword } from "./crypto.js";
import { addDays, clearSession, currentUserPayload, issueSession, revokeCurrentSession } from "./auth.js";

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
      reply.code(401).send({ error: "Invalid email or password" });
      return;
    }

    issueSession(reply, user.id, request);
    reply.send({ user: publicUser(user) });
  });

  app.post("/api/auth/logout", { preHandler: app.authenticate }, async (request, reply) => {
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
      INSERT INTO invites (id, token_hash, role, created_by, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(inviteId, sha256(token), parsed.data.role, request.user!.id, expiresAt);

    reply.code(201).send({
      invite: {
        id: inviteId,
        role: parsed.data.role,
        expiresAt,
        url: `${config.appUrl}/invite/${token}`
      }
    });
  });

  app.get("/api/invites/:token", async (request, reply) => {
    const token = (request.params as { token: string }).token;
    const invite = db.prepare(`
      SELECT id, role, expires_at
      FROM invites
      WHERE token_hash = ?
        AND used_at IS NULL
        AND revoked_at IS NULL
        AND expires_at > CURRENT_TIMESTAMP
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
        AND expires_at > CURRENT_TIMESTAMP
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
    reply.code(201).send({ user: publicUser(user) });
  });

  app.get("/api/users", { preHandler: app.requireAdmin }, async () => {
    const users = db.prepare(`
      SELECT * FROM users
      WHERE deleted_at IS NULL
      ORDER BY created_at ASC
    `).all() as User[];

    return { users: users.map(publicUser) };
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

    db.transaction(() => {
      db.prepare("UPDATE users SET deleted_at = CURRENT_TIMESTAMP, is_active = 0 WHERE id = ?").run(id);
      db.prepare("UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ?").run(id);
    })();

    reply.send({ ok: true });
  });
}
