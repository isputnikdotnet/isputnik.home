import type { FastifyInstance } from "fastify";
import { setupPlugin } from "./setup.js";
import { authPlugin } from "./auth-routes.js";
import { sessionsPlugin } from "./sessions.js";
import { logsPlugin } from "./logs.js";
import { statusPlugin } from "./status.js";
import { appConfigPlugin } from "./app-config.js";

export async function corePlugin(app: FastifyInstance) {
  await app.register(setupPlugin);
  await app.register(appConfigPlugin);
  await app.register(authPlugin);
  await app.register(sessionsPlugin);
  await app.register(logsPlugin);
  await app.register(statusPlugin);
}
