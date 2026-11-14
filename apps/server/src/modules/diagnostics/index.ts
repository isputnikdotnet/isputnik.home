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
import { recordSpeed, startTest, testsState } from "./tests.js";

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

const speedSchema = z.object({
  downloadMbps: z.number().min(0).max(100_000),
  replyMs: z.number().min(0).max(60_000),
  bytes: z.number().int().min(0).max(1024 * 1024 * 1024)
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

  // This server's tests (tests.ts): one at a time, only when asked; they change nothing.
  app.get("/api/admin/diagnostics/tests", { preHandler: app.requireAdmin }, async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return testsState();
  });

  app.post("/api/admin/diagnostics/tests/:kind", { preHandler: app.requireAdmin }, async (request, reply) => {
    const kind = (request.params as { kind: string }).kind;
    if (kind === "speed") {
      const parsed = speedSchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: "Invalid speed result" });
      recordSpeed(parsed.data);
      return testsState();
    }
    if (kind !== "folders" && kind !== "backup") return reply.code(404).send({ error: "No such test" });
    if (!startTest(kind)) return reply.code(409).send({ error: "Another test is running", ...testsState() });
    return reply.code(202).send(testsState());
  });

  app.get("/api/admin/diagnostics/overview", { preHandler: app.requireAdmin }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    return { parts: await overview(request, settings) };
  });
}
