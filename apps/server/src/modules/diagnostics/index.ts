// Diagnostics — a report an admin attaches to a bug report (report.ts), with the
// household's names and addresses hidden unless they ask (redact.ts). A product
// module, not core: it reads the libraries and asks the containers.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { appSettingsResolver, type AppsPluginOptions } from "../apps/index.js";
import { buildReport } from "./report.js";

const querySchema = z.object({
  // Anything but "true" keeps them hidden.
  private: z.enum(["true", "false"]).default("false")
});

export async function diagnosticsPlugin(app: FastifyInstance, opts: AppsPluginOptions = {}) {
  const settings = appSettingsResolver(opts.settings);

  app.get("/api/admin/diagnostics", { preHandler: app.requireAdmin }, async (request, reply) => {
    const query = querySchema.safeParse(request.query ?? {});
    const includePrivate = query.success && query.data.private === "true";
    reply.header("Cache-Control", "no-store");
    return { report: await buildReport(request, settings, includePrivate) };
  });
}
