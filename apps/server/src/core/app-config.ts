import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { db, logActivity, THEME_PREFERENCES, type ThemePreference } from "../db.js";
import { parseBody } from "./shared.js";

export const DEFAULT_THEME_KEY = "default_theme";

const configSchema = z.object({ defaultTheme: z.enum(THEME_PREFERENCES) });

/** App-wide default theme used for the sign-in screen and new accounts. */
export function getDefaultTheme(): ThemePreference {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(DEFAULT_THEME_KEY) as
    | { value: string }
    | undefined;
  const value = row?.value ?? "";
  if (value === "hard-orbit") return "expanse";
  return (THEME_PREFERENCES as readonly string[]).includes(value) ? (value as ThemePreference) : "dark";
}

export async function appConfigPlugin(app: FastifyInstance) {
  app.get("/api/config", { preHandler: app.requireAdmin }, async () => ({
    config: { defaultTheme: getDefaultTheme() }
  }));

  app.patch("/api/config", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(configSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid configuration", details: parsed.error });
      return;
    }

    db.prepare(`
      INSERT INTO app_settings (key, value, updated_by, updated_at)
      VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_by = excluded.updated_by,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    `).run(DEFAULT_THEME_KEY, parsed.data.defaultTheme, request.user!.id);

    logActivity({
      event: "config.updated",
      actorUserId: request.user!.id,
      targetType: "setting",
      targetId: DEFAULT_THEME_KEY,
      detail: `Set default theme to ${parsed.data.defaultTheme}.`,
      ipAddress: request.ip
    });

    reply.send({ config: { defaultTheme: parsed.data.defaultTheme } });
  });
}
