import type { FastifyInstance } from "fastify";
import { librarySettingsPlugin } from "./settings.js";
import { coversPlugin } from "./covers.js";
import { storagePlugin } from "./storage.js";
import { audiobookPlugin } from "./audiobook/index.js";
import { ebookPlugin } from "./ebook/index.js";
import { galleryPlugin } from "./gallery/index.js";
import { libraryMembersPlugin } from "./shared/members.js";
import { scanRulesPlugin } from "./shared/scan-rules-routes.js";
import { registerTrashRoutes } from "./shared/trash-routes.js";
import { startTrashPurgeWorker } from "./shared/trash.js";
import { registerFeedRoutes } from "./feed.js";
import { registerCategoryRoutes } from "./categories.js";
import { registerTagRoutes } from "./tags.js";
import { registerWorkRoutes } from "./works.js";
import { registerBookmarkRoutes } from "./bookmarks.js";
import { registerQuoteRoutes } from "./quotes.js";
import { librarySharesPlugin } from "./shared/shares.js";

export async function libraryPlugin(app: FastifyInstance) {
  await app.register(librarySettingsPlugin);
  await app.register(coversPlugin);
  await app.register(storagePlugin);
  await app.register(libraryMembersPlugin);
  await app.register(audiobookPlugin);
  await app.register(ebookPlugin);
  await app.register(galleryPlugin);

  // Custom scan rules (cross-type; preview dispatches to the media scanner).
  await app.register(scanRulesPlugin);

  // Cross-type routes live at the library level rather than inside one media
  // plugin: the home feeds (recent / continue across audiobooks + ebooks)…
  registerFeedRoutes(app);

  // …the global Categories browse (one taxonomy across every book-like type)…
  registerCategoryRoutes(app);

  // …the global Tags browse (polymorphic taggables, cross-type)…
  registerTagRoutes(app);

  // …grouping items into works (editions of the same title, cross-type)…
  registerWorkRoutes(app);

  // …the cross-type "all my bookmarks" listing (audiobook position + epub reader)…
  registerBookmarkRoutes(app);

  // …quotes / highlights (cross-type; in-reader captures + externally-typed quotes)…
  registerQuoteRoutes(app);

  // …item-level sharing (guest links + user shares) for every book type, with
  // public guest routes that dispatch by the share's module…
  await app.register(librarySharesPlugin);

  // …and the Recycle Bin, whose sweeper auto-purges items past the retention window.
  registerTrashRoutes(app);
  const stopPurgeWorker = startTrashPurgeWorker();
  app.addHook("onClose", async () => {
    stopPurgeWorker();
  });
}
