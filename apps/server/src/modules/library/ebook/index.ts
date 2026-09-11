import type { FastifyInstance } from "fastify";
import { ebookRoutesPlugin } from "./routes.js";
import { ebookBookmarksPlugin } from "./bookmarks.js";
import { opdsPlugin } from "./opds.js";
import { startEbookScanWorker } from "./scanner.js";
import { registerEbookStats } from "./stats.js";
import { registerEbookMediaType } from "./media-type.js";

export async function ebookPlugin(app: FastifyInstance) {
  registerEbookStats();
  registerEbookMediaType();

  await app.register(ebookRoutesPlugin);
  await app.register(ebookBookmarksPlugin);
  await app.register(opdsPlugin);

  const stopWorker = startEbookScanWorker();
  app.addHook("onClose", async () => {
    stopWorker();
  });
}
