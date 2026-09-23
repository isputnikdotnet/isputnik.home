// Family tree module: family members, their unions and children, and gallery
// integration (attached photos + face-cluster links). Independent of the gallery
// module — it reads gallery tables for photo surfacing but the gallery never
// depends on it. See docs/architecture.md.
import type { FastifyInstance } from "fastify";
import { familyTreeRoutesPlugin } from "./routes.js";
import { renderPendingPortraits } from "./portraits.js";

export async function familyTreePlugin(app: FastifyInstance) {
  await app.register(familyTreeRoutesPlugin);

  // Gallery portraits chosen before 4.21 get an image of their own, so they show
  // for members who cannot open the photo's library (portraits.ts). In the
  // background, one render at a time; a no-op once they are all done.
  app.addHook("onReady", async () => {
    void renderPendingPortraits()
      .then((count) => { if (count > 0) app.log.info(`Rendered ${count} family-tree portrait${count === 1 ? "" : "s"}.`); })
      .catch((err) => app.log.warn({ err }, "Rendering family-tree portraits failed; they show as before."));
  });
}
