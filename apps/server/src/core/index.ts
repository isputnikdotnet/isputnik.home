import type { FastifyInstance } from "fastify";
import { setupPlugin } from "./setup.js";
import { authPlugin } from "./auth-routes.js";
import { mfaRoutes } from "./mfa-routes.js";
import { webauthnRoutes } from "./webauthn-routes.js";
import { deviceLinkRoutes } from "./device-link-routes.js";
import { sessionsPlugin } from "./sessions.js";
import { apiTokensPlugin } from "./api-tokens.js";
import { logsPlugin } from "./logs.js";
import { statusPlugin } from "./status.js";
import { dashboardPlugin } from "./dashboard.js";
import { appConfigPlugin } from "./app-config.js";
import { mailPlugin } from "./mail-routes.js";
import { routingPlugin } from "./routing-routes.js";
import { notificationsPlugin } from "./notification-routes.js";
import { securityRoutes } from "./security-routes.js";
import { securityTxtPlugin } from "./security-txt.js";

export async function corePlugin(app: FastifyInstance) {
  await app.register(setupPlugin);
  await app.register(appConfigPlugin);
  await app.register(mailPlugin);
  await app.register(routingPlugin);
  await app.register(notificationsPlugin);
  await app.register(authPlugin);
  await app.register(mfaRoutes);
  await app.register(webauthnRoutes);
  await app.register(deviceLinkRoutes);
  await app.register(sessionsPlugin);
  await app.register(apiTokensPlugin);
  await app.register(logsPlugin);
  await app.register(statusPlugin);
  await app.register(dashboardPlugin);
  await app.register(securityRoutes);
  await app.register(securityTxtPlugin);
}
