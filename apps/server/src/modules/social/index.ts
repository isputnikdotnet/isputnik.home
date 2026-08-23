import type { FastifyInstance } from "fastify";
import { socialPlugin as socialRoutesPlugin } from "./routes.js";
import { notesPlugin } from "./notes.js";
import { activityPlugin } from "./activity.js";

export async function socialPlugin(app: FastifyInstance) {
  await app.register(socialRoutesPlugin);
  await app.register(notesPlugin);
  await app.register(activityPlugin);
}
