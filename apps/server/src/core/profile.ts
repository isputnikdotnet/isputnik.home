import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { db, logActivity, publicUser, type User } from "../db.js";
import { parseBody } from "./shared.js";

const profileSchema = z.object({
  displayName: z.string().trim().min(2).max(80),
  theme: z.enum(["system", "light", "dark"])
});

export async function profilePlugin(app: FastifyInstance) {
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
}
