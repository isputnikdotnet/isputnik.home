// Family tree module: family members, their unions and children, and gallery
// integration (attached photos + face-cluster links). Independent of the gallery
// module — it reads gallery tables for photo surfacing but the gallery never
// depends on it. See docs/architecture.md.
import type { FastifyInstance } from "fastify";
import { familyTreeRoutesPlugin } from "./routes.js";
import { keepUploadedPortraitsAsPhotos, renderPendingPortraits } from "./portraits.js";
import { sweepPendingImports } from "./package/pending.js";

export async function familyTreePlugin(app: FastifyInstance) {
  await app.register(familyTreeRoutesPlugin);

  // A package upload waiting for its confirmation does not survive a restart
  // (package/pending.ts); its files go with it.
  app.addHook("onReady", async () => {
    try { sweepPendingImports(); } catch (err) { app.log.warn({ err }, "Could not clear pending family-tree imports."); }
  });

  // Gallery portraits chosen before 4.21 get an image of their own, so they show
  // for members who cannot open the photo's library; portraits uploaded straight
  // to the tree get a photo in App files, so the Gallery and pickers show them
  // (portraits.ts). In the background, one at a time; a no-op once all are done.
  app.addHook("onReady", async () => {
    void (async () => {
      const rendered = await renderPendingPortraits();
      if (rendered > 0) app.log.info(`Rendered ${rendered} family-tree portrait${rendered === 1 ? "" : "s"}.`);
      const kept = await keepUploadedPortraitsAsPhotos();
      if (kept > 0) app.log.info(`Kept ${kept} uploaded family-tree portrait${kept === 1 ? "" : "s"} as photos in App files.`);
    })().catch((err) => app.log.warn({ err }, "Preparing family-tree portraits failed; they show as before."));
  });
}
