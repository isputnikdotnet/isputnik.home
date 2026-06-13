import type { FastifyInstance } from "fastify";
import { librarySettingsPlugin } from "./settings.js";
import { coversPlugin } from "./covers.js";
import { storagePlugin } from "./storage.js";
import { audiobookPlugin } from "./audiobook/index.js";
import { ebookPlugin } from "./ebook/index.js";
import { libraryMembersPlugin } from "./shared/members.js";
import { registerTrashRoutes } from "./shared/trash-routes.js";
import { startTrashPurgeWorker } from "./shared/trash.js";

export async function libraryPlugin(app: FastifyInstance) {
  await app.register(librarySettingsPlugin);
  await app.register(coversPlugin);
  await app.register(storagePlugin);
  await app.register(libraryMembersPlugin);
  await app.register(audiobookPlugin);
  await app.register(ebookPlugin);

  // Recycle Bin is cross-type, so its routes live at the library level rather than inside
  // one media plugin. The sweeper auto-purges items past the retention window.
  registerTrashRoutes(app);
  const stopPurgeWorker = startTrashPurgeWorker();
  app.addHook("onClose", async () => {
    stopPurgeWorker();
  });
}
