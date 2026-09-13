// Maps — the base map every map in the app draws on, and where it is kept
// (docs/map-approach-proposal.md, phase 1b).
//
// A product feature, so it lives in modules/, not core: it knows what a map
// style is and which provider draws it. The geoip database stays in core
// (core/geoip.ts) because security and the logs read it too.
import type { FastifyInstance } from "fastify";
import { registerMapRoutes } from "./routes.js";
import { startPlacesBuildWorker } from "./places/job.js";

export async function mapsPlugin(app: FastifyInstance) {
  registerMapRoutes(app);
  // Building the place names database runs as a task on the shared job poller;
  // one a restart interrupted is re-queued by its recovery pass.
  const stopPlacesBuildWorker = startPlacesBuildWorker();
  app.addHook("onClose", async () => stopPlacesBuildWorker());
}
