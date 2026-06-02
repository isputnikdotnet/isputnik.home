import type { FastifyInstance } from "fastify";
import { setupPlugin } from "./setup.js";
import { authPlugin } from "./auth-routes.js";
import { profilePlugin } from "./profile.js";
import { usersPlugin } from "./users.js";
import { sessionsPlugin } from "./sessions.js";
import { invitesPlugin } from "./invites.js";
import { logsPlugin } from "./logs.js";
import { statusPlugin } from "./status.js";
import { groupsPlugin } from "./groups.js";
import { backupsPlugin } from "./backups.js";

export async function corePlugin(app: FastifyInstance) {
  await app.register(setupPlugin);
  await app.register(authPlugin);
  await app.register(profilePlugin);
  await app.register(usersPlugin);
  await app.register(sessionsPlugin);
  await app.register(invitesPlugin);
  await app.register(logsPlugin);
  await app.register(statusPlugin);
  await app.register(groupsPlugin);
  await app.register(backupsPlugin);
}
