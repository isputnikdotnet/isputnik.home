import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { db, hasUsers, logActivity, publicUser, type User } from "../db.js";
import { hashPassword } from "../crypto.js";
import { issueSession } from "../auth.js";
import { parseBody, setupSchema } from "./shared.js";

export async function setupPlugin(app: FastifyInstance) {
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
}
