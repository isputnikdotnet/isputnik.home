// Dashboard — the admin Activity dashboard: sign-ins, the activity charts, the
// locations map and what is in progress. It is product logic (it decides which
// activity events count as uploads, plays and reads, and reads playback
// progress), so it is a module rather than part of core/. The GeoIP database it
// draws the map with stays in core/geoip.ts: security and the logs use it too.
import type { FastifyInstance } from "fastify";
import { dashboardRoutesPlugin } from "./routes.js";

export async function dashboardPlugin(app: FastifyInstance) {
  await app.register(dashboardRoutesPlugin);
}
