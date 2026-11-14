// Diagnostics — a report an admin attaches to a bug report (report.ts), with the
// household's names and addresses hidden unless they ask (redact.ts), and the
// page's cards, one per part of iSputnik (overview.ts). A product module, not
// core: it reads the libraries and asks the containers.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { appSettingsResolver, type AppsPluginOptions } from "../apps/index.js";
import { overview } from "./overview.js";
import { HIDE_ALL, HIDE_KINDS, HIDE_NOTHING, type HideChoice } from "./redact.js";
import { buildReport, REPORT_PARTS, type SectionKey } from "./report.js";

const list = z.string().max(500).optional();
const querySchema = z.object({
  // 4.89's one switch: "true" hides nothing. Kept for a page opened before an update.
  private: z.enum(["true", "false"]).optional(),
  // Which kinds to hide, comma-separated; "" hides nothing. Absent: all of them.
  hide: list,
  // Which parts, comma-separated (REPORT_PARTS). Absent: all of them.
  parts: list,
  // How far back dated lines go: hour, day (today, the default) or week.
  since: z.enum(["hour", "day", "week"]).optional()
});

const csv = (value: string) => value.split(",").map((entry) => entry.trim()).filter(Boolean);

/** What the query asks to hide. Anything it doesn't name is shown; no query hides all. */
export function hideChoiceOf(query: { private?: string; hide?: string }): HideChoice {
  if (query.hide !== undefined) {
    const named = new Set(csv(query.hide));
    return Object.fromEntries(HIDE_KINDS.map((kind) => [kind, named.has(kind)])) as unknown as HideChoice;
  }
  return query.private === "true" ? HIDE_NOTHING : HIDE_ALL;
}

export async function diagnosticsPlugin(app: FastifyInstance, opts: AppsPluginOptions = {}) {
  const settings = appSettingsResolver(opts.settings);

  app.get("/api/admin/diagnostics", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = querySchema.safeParse(request.query ?? {});
    // A query that can't be read hides everything: the safe way to be wrong.
    const query = parsed.success ? parsed.data : {};
    const parts = query.parts === undefined
      ? null
      : new Set(csv(query.parts).filter((key): key is SectionKey => (REPORT_PARTS as string[]).includes(key)));
    reply.header("Cache-Control", "no-store");
    const span = parsed.success ? parsed.data.since ?? "day" : "day";
    return { report: await buildReport(request, settings, parsed.success ? hideChoiceOf(query) : HIDE_ALL, parts, span) };
  });

  app.get("/api/admin/diagnostics/overview", { preHandler: app.requireAdmin }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    return { parts: await overview(request, settings) };
  });
}
