// Family tree module: family members, their unions and children, and gallery
// integration (attached photos + face-cluster links). Independent of the gallery
// module — it reads gallery tables for photo surfacing but the gallery never
// depends on it. See docs/architecture.md.
import type { FastifyInstance } from "fastify";
import { familyTreeRoutesPlugin } from "./routes.js";

export async function familyTreePlugin(app: FastifyInstance) {
  await app.register(familyTreeRoutesPlugin);
}
