import type { FastifyInstance } from "fastify";
import { profilePlugin } from "./profile.js";
import { usersPlugin as accountsPlugin } from "./users.js";
import { invitesPlugin } from "./invites.js";
import { groupsPlugin } from "./groups.js";

export async function usersPlugin(app: FastifyInstance) {
  await app.register(profilePlugin);
  await app.register(accountsPlugin);
  await app.register(invitesPlugin);
  await app.register(groupsPlugin);
}
