import type { FastifyInstance } from "fastify";
import { audiobookRoutesPlugin } from "./routes.js";
import { audiobookBooksPlugin } from "./books.js";
import { audiobookStreamPlugin } from "./stream.js";
import { audiobookPeoplePlugin } from "./people.js";
import { audiobookBookmarksPlugin } from "./bookmarks.js";
import { audiobookSavesPlugin } from "./saves.js";
import { categoriesAdminPlugin } from "./categories-routes.js";
import { startAudiobookScanWorker } from "./scanner.js";
import { registerAudiobookStats } from "./stats.js";

export async function audiobookPlugin(app: FastifyInstance) {
  // Hand the admin Statistics page this type's numbers. core/ drains the
  // registry per request and never learns what an audiobook is.
  registerAudiobookStats();

  await app.register(audiobookRoutesPlugin);
  await app.register(audiobookBooksPlugin);
  await app.register(audiobookStreamPlugin);
  await app.register(audiobookPeoplePlugin);
  await app.register(audiobookBookmarksPlugin);
  await app.register(audiobookSavesPlugin);
  await app.register(categoriesAdminPlugin);

  const stopWorker = startAudiobookScanWorker();
  app.addHook("onClose", async () => {
    stopWorker();
  });
}
