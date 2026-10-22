import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { db, logActivity, THEME_PREFERENCES, type ThemePreference } from "../db.js";
import { parseBody } from "./shared.js";
import type { AppSettingRow } from "../db/rows.js";
import { anySectionOn, getSections, SECTION_KEYS, sectionsSchema, setSections } from "./sections.js";

export const DEFAULT_THEME_KEY = "default_theme";

// Either half may come alone: the theme picker and the Sections card save
// separately, each sending only what it owns.
const configSchema = z.object({
  defaultTheme: z.enum(THEME_PREFERENCES).optional(),
  sections: sectionsSchema.optional()
}).refine((data) => data.defaultTheme !== undefined || data.sections !== undefined, { message: "Nothing to save" });

/** App-wide default theme used for the sign-in screen and new accounts.
    Until an admin picks one, the site defaults to Minimalist. */
export function getDefaultTheme(): ThemePreference {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(DEFAULT_THEME_KEY) as Pick<AppSettingRow, "value"> | undefined;
  const value = row?.value ?? "";
  return (THEME_PREFERENCES as readonly string[]).includes(value) ? (value as ThemePreference) : "minimalist";
}

export async function appConfigPlugin(app: FastifyInstance) {
  app.get("/api/config", { preHandler: app.requireAdmin }, async () => ({
    config: { defaultTheme: getDefaultTheme(), sections: getSections() }
  }));

  app.patch("/api/config", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(configSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid configuration", details: parsed.error });
    }

    if (parsed.data.defaultTheme !== undefined) {
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
    }

    if (parsed.data.sections !== undefined) {
      // The menu never empties. Refused here rather than quietly kept on: a
      // request that would leave nothing is a mistake worth hearing about.
      if (!anySectionOn(parsed.data.sections)) {
        return reply.code(400).send({ error: "At least one section must stay on.", code: "config.no_sections" });
      }
      setSections(parsed.data.sections, request.user!.id);
      const off = SECTION_KEYS.filter((key) => !parsed.data.sections![key]);
      logActivity({
        event: "config.updated",
        actorUserId: request.user!.id,
        targetType: "setting",
        targetId: "sections",
        detail: off.length === 0 ? "Every section is on." : `Sections off: ${off.join(", ")}.`,
        ipAddress: request.ip
      });
    }

    return reply.send({ config: { defaultTheme: getDefaultTheme(), sections: getSections() } });
  });
}
