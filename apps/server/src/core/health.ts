import type { FastifyInstance } from "fastify";
import { db } from "../db.js";

// Liveness for the container: Docker's HEALTHCHECK, the compose file and the Unraid
// template all poll this. Unauthenticated by necessity (the probe has no session),
// so it answers only "up or not" — the version and the rest stay behind sign-in on
// /api/about and /api/status. A database that no longer answers is the failure worth
// catching (a wedged or vanished volume), so the probe touches it.
//
// Polled every 30 s for the life of the container: request logging is turned down
// to warnings so it doesn't bury the log, and the global rate limit is skipped so a
// crowded minute can never mark a healthy server unhealthy.
export async function healthPlugin(app: FastifyInstance) {
  app.get("/api/health", { logLevel: "warn", config: { rateLimit: false } }, async (_request, reply) => {
    try {
      db.prepare("SELECT 1").get();
      return reply.header("Cache-Control", "no-store").send({ ok: true });
    } catch (err) {
      app.log.error({ err }, "Health check failed: the database did not answer");
      return reply.code(503).header("Cache-Control", "no-store").send({ ok: false });
    }
  });
}
