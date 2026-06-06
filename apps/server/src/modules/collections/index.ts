import type { FastifyInstance } from "fastify";
import { collectionsPlugin as collectionsRoutesPlugin } from "./routes.js";

export async function collectionsPlugin(app: FastifyInstance) {
  await app.register(collectionsRoutesPlugin);
}
