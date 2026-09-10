import type { FastifyInstance } from "fastify";
import { storiesPlugin as storiesRoutesPlugin } from "./routes.js";
import { storyCollectionsPlugin } from "./collections-routes.js";
import { migrateLegacyNarrations, pendingLegacyNarrations } from "./recordings.js";
import { getRecordingsLibrary } from "./settings.js";

/** Narration recorded before recordings lived in the gallery (pre-3.x clips in
 *  the app's own bucket) moves itself into the App files library once
 *  one is set — docs/app-storage-plan.md, decision 7. It used to wait for a
 *  button on Settings → Stories. Runs shortly after boot and every six hours
 *  after that, so a library nominated while the server is up is caught by the
 *  next tick; the import is safe to re-run (a clip that fails stays counted). */
/** One pass of the importer: null when there is nothing to move or nowhere to
 *  move it to. Exported for the timers below and for tests. */
export async function importLegacyNarrationsIfDue(): Promise<{ moved: number; failed: number } | null> {
  if (pendingLegacyNarrations() === 0 || !getRecordingsLibrary()) return null;
  const result = await migrateLegacyNarrations(null);
  return { moved: result.moved, failed: result.failed };
}

export function startLegacyNarrationImporter(app: FastifyInstance): () => void {
  const tick = async () => {
    try {
      const result = await importLegacyNarrationsIfDue();
      if (result && (result.moved > 0 || result.failed > 0)) {
        app.log.info(`Moved ${result.moved} older narration recording${result.moved === 1 ? "" : "s"} into the App files library${result.failed > 0 ? `; ${result.failed} could not be moved` : ""}.`);
      }
    } catch (err) {
      app.log.warn({ err }, "Could not move older narration recordings; will try again later.");
    }
  };
  const kickoff = setTimeout(() => { void tick(); }, 45 * 1000);
  kickoff.unref?.();
  const timer = setInterval(() => { void tick(); }, 6 * 60 * 60 * 1000);
  timer.unref?.();
  return () => { clearTimeout(kickoff); clearInterval(timer); };
}

export async function storiesPlugin(app: FastifyInstance) {
  // Collections first: /api/stories/collections/... must not be swallowed by
  // /api/stories/:id (find-my-way prefers static segments, but explicit order
  // costs nothing and reads as the intent).
  await app.register(storyCollectionsPlugin);
  await app.register(storiesRoutesPlugin);

  const stopImporter = startLegacyNarrationImporter(app);
  app.addHook("onClose", async () => { stopImporter(); });
}
