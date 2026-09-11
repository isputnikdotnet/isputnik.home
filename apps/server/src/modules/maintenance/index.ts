// Maintenance — the Scheduled jobs page (recurring jobs: jobs-catalog.ts says which,
// scheduler.ts says when) and the Tasks page over the shared jobs queue (tasks-view.ts).
import type { FastifyInstance } from "fastify";
import { registerMaintenanceRoutes } from "./routes.js";
import { seedScheduledJobDefaults, startScheduledJobsWorker } from "./scheduler.js";

export async function maintenancePlugin(app: FastifyInstance) {
  registerMaintenanceRoutes(app);
  seedScheduledJobDefaults();
  const stopWorker = startScheduledJobsWorker();
  app.addHook("onClose", async () => { stopWorker(); });
}
