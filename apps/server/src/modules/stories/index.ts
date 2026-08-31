import type { FastifyInstance } from "fastify";
import { storiesPlugin as storiesRoutesPlugin } from "./routes.js";

export async function storiesPlugin(app: FastifyInstance) {
  await app.register(storiesRoutesPlugin);
}
