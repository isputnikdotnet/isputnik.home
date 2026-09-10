import type { FastifyInstance } from "fastify";
import { galleryRoutesPlugin } from "./routes.js";
import { galleryPeopleRoutesPlugin } from "./people-routes.js";
import { galleryAlbumRoutesPlugin } from "./album-routes.js";
import { gallerySlideshowRoutesPlugin } from "./slideshow-routes.js";
import { galleryMusicRoutesPlugin } from "./music-routes.js";
import { galleryInboxRoutesPlugin } from "./inbox-routes.js";
import { galleryDropRoutesPlugin } from "./drop-routes.js";
import { galleryReviewRoutesPlugin } from "./review-routes.js";
import { galleryVoiceNoteRoutesPlugin } from "./voice-note-routes.js";
import {
  galleryDuplicateJobRoutesPlugin,
  startDuplicateScanWorker
} from "./duplicates/index.js";
import { importBucketMusicIfDue, removeBuiltinMusic } from "./music.js";
import { startSlideshowRenderWorker } from "./slideshow-render.js";
import { startTranscodeWorker } from "./transcode.js";
import { galleryStreamPlugin } from "./stream.js";
import { startGalleryScanWorker } from "./scanner.js";
import { startFaceScanWorker } from "./faces/scanner.js";
import { registerGalleryStats } from "./stats.js";

export async function galleryPlugin(app: FastifyInstance) {
  registerGalleryStats();

  await app.register(galleryRoutesPlugin);
  await app.register(galleryPeopleRoutesPlugin);
  await app.register(galleryAlbumRoutesPlugin);
  await app.register(gallerySlideshowRoutesPlugin);
  await app.register(galleryMusicRoutesPlugin);
  await app.register(galleryInboxRoutesPlugin);
  await app.register(galleryDropRoutesPlugin);
  await app.register(galleryReviewRoutesPlugin);
  await app.register(galleryVoiceNoteRoutesPlugin);
  await app.register(galleryDuplicateJobRoutesPlugin);
  await app.register(galleryStreamPlugin);

  // Slideshows use only user-uploaded music now; purge any built-in beds a prior
  // version seeded (idempotent, best-effort — safe when the store isn't configured).
  try { removeBuiltinMusic(); } catch { /* best-effort; uploads still work */ }

  const stopWorker = startGalleryScanWorker();
  const stopFaceWorker = startFaceScanWorker();
  const stopRenderWorker = startSlideshowRenderWorker();
  const stopTranscodeWorker = startTranscodeWorker();
  const stopDuplicateWorker = startDuplicateScanWorker();

  // Slideshow music uploaded before an App files library existed moves
  // itself into that library once there is one (docs/app-storage-plan.md, phase
  // 3): shortly after boot and every six hours after that.
  const importMusic = async () => {
    try {
      const result = await importBucketMusicIfDue();
      if (result && (result.moved > 0 || result.failed > 0)) {
        app.log.info(`Moved ${result.moved} slideshow music track${result.moved === 1 ? "" : "s"} into the App files library${result.failed > 0 ? `; ${result.failed} could not be moved` : ""}.`);
      }
    } catch (err) {
      app.log.warn({ err }, "Could not move slideshow music into the library; will try again later.");
    }
  };
  const musicKickoff = setTimeout(() => { void importMusic(); }, 60 * 1000);
  musicKickoff.unref?.();
  const musicTimer = setInterval(() => { void importMusic(); }, 6 * 60 * 60 * 1000);
  musicTimer.unref?.();

  app.addHook("onClose", async () => {
    stopWorker();
    stopFaceWorker();
    stopRenderWorker();
    stopTranscodeWorker();
    stopDuplicateWorker();
    clearTimeout(musicKickoff);
    clearInterval(musicTimer);
  });
}
