import type { FastifyInstance } from "fastify";
import { librarySettingsPlugin } from "./settings.js";
import { coversPlugin } from "./covers.js";
import { storagePlugin } from "./storage.js";
import { audiobookPlugin } from "./audiobook/index.js";
import { ebookPlugin } from "./ebook/index.js";
import { libraryMembersPlugin } from "./shared/members.js";
import { registerTrashRoutes } from "./shared/trash-routes.js";
import { startTrashPurgeWorker } from "./shared/trash.js";
import { registerFeedRoutes } from "./feed.js";
import { registerCategoryRoutes } from "./categories.js";
import { registerTagRoutes } from "./tags.js";
import { registerBookmarkRoutes } from "./bookmarks.js";

export async function libraryPlugin(app: FastifyInstance) {
  await app.register(librarySettingsPlugin);
  await app.register(coversPlugin);
  await app.register(storagePlugin);
  await app.register(libraryMembersPlugin);
  await app.register(audiobookPlugin);
  await app.register(ebookPlugin);

  // Cross-type routes live at the library level rather than inside one media
  // plugin: the home feeds (recent / continue across audiobooks + ebooks)…
  registerFeedRoutes(app);

  // …the global Categories browse (one taxonomy across every book-like type)…
  registerCategoryRoutes(app);

  // …the global Tags browse (polymorphic taggables, cross-type)…
  registerTagRoutes(app);

  // …the cross-type "all my bookmarks" listing (audiobook position + epub reader)…
  registerBookmarkRoutes(app);

  // …and the Recycle Bin, whose sweeper auto-purges items past the retention window.
  registerTrashRoutes(app);
  const stopPurgeWorker = startTrashPurgeWorker();
  app.addHook("onClose", async () => {
    stopPurgeWorker();
  });
}
