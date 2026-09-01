import type { FastifyInstance } from "fastify";
import { storiesPlugin as storiesRoutesPlugin } from "./routes.js";
import { storyCollectionsPlugin } from "./collections-routes.js";

export async function storiesPlugin(app: FastifyInstance) {
  // Collections first: /api/stories/collections/... must not be swallowed by
  // /api/stories/:id (find-my-way prefers static segments, but explicit order
  // costs nothing and reads as the intent).
  await app.register(storyCollectionsPlugin);
  await app.register(storiesRoutesPlugin);
}
