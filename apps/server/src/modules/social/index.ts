import type { FastifyInstance } from "fastify";
import { socialPlugin as socialRoutesPlugin } from "./routes.js";

export async function socialPlugin(app: FastifyInstance) {
  await app.register(socialRoutesPlugin);
}
