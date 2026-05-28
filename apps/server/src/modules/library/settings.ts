import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { db, logActivity } from "../../db.js";
import { config } from "../../config.js";
import { parseBody } from "../../core/shared.js";
import { thumbnailPathSettingKey, configuredThumbnailPathValue, validateThumbnailPath } from "./shared/thumbnail.js";

const librarySettingsSchema = z.object({
  thumbnailPath: z.string().trim().min(1).max(1000)
});

export async function librarySettingsPlugin(app: FastifyInstance) {
  app.get("/api/library/settings", { preHandler: app.requireAdmin }, async () => {
    const thumbnailPath = configuredThumbnailPathValue();
    let thumbnailPathReady = false;
    let thumbnailPathError = "";

    if (thumbnailPath) {
      try {
        validateThumbnailPath(thumbnailPath);
        thumbnailPathReady = true;
      } catch (err) {
        thumbnailPathError = err instanceof Error ? err.message : "Thumbnail path is not writable.";
      }
    }

    return {
      settings: {
        thumbnailPath,
        thumbnailPathReady,
        thumbnailPathError,
        fromEnvironment: Boolean(config.thumbnailPath)
      }
    };
  });

  app.patch("/api/library/settings", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(librarySettingsSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid library settings", details: parsed.error });
      return;
    }

    let thumbnailPath: string;
    try {
      thumbnailPath = validateThumbnailPath(parsed.data.thumbnailPath);
    } catch (err) {
      reply.code(400).send({ error: err instanceof Error ? err.message : "Thumbnail path is not writable." });
      return;
    }

    db.prepare(`
      INSERT INTO app_settings (key, value, updated_by, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_by = excluded.updated_by,
        updated_at = CURRENT_TIMESTAMP
    `).run(thumbnailPathSettingKey, thumbnailPath, request.user!.id);

    logActivity({
      event: "library.settings.updated",
      actorUserId: request.user!.id,
      targetType: "setting",
      targetId: thumbnailPathSettingKey,
      detail: "Updated Digital Library thumbnail storage path.",
      ipAddress: request.ip
    });

    reply.send({
      settings: {
        thumbnailPath,
        thumbnailPathReady: true,
        thumbnailPathError: "",
        fromEnvironment: Boolean(config.thumbnailPath)
      }
    });
  });
}
