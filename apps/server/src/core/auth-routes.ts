import type { FastifyInstance } from "fastify";
import { db, logActivity, publicUser, type User } from "../db.js";
import { verifyPassword } from "../crypto.js";
import { clearSession, currentUserPayload, issueSession, revokeCurrentSession } from "../auth.js";
import { parseBody, credentialsSchema, getUserByEmail } from "./shared.js";

export async function authPlugin(app: FastifyInstance) {
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
}
