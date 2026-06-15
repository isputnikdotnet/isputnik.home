import type { FastifyInstance } from "fastify";
import { ebookRoutesPlugin } from "./routes.js";
import { ebookBookmarksPlugin } from "./bookmarks.js";
import { startEbookScanWorker } from "./scanner.js";

export async function ebookPlugin(app: FastifyInstance) {
  await app.register(ebookRoutesPlugin);
  await app.register(ebookBookmarksPlugin);

  const stopWorker = startEbookScanWorker();
  app.addHook("onClose", async () => {
    stopWorker();
  });
}
