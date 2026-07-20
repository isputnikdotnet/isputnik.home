import type { FastifyInstance } from "fastify";
import { galleryRoutesPlugin } from "./routes.js";
import { galleryPeopleRoutesPlugin } from "./people-routes.js";
import { galleryAlbumRoutesPlugin } from "./album-routes.js";
import { gallerySlideshowRoutesPlugin } from "./slideshow-routes.js";
import { galleryMusicRoutesPlugin } from "./music-routes.js";
import { seedBuiltinMusic } from "./music.js";
import { startSlideshowRenderWorker } from "./slideshow-render.js";
import { galleryStreamPlugin } from "./stream.js";
import { startGalleryScanWorker } from "./scanner.js";
import { startFaceScanWorker } from "./faces/scanner.js";

export async function galleryPlugin(app: FastifyInstance) {
  await app.register(galleryRoutesPlugin);
  await app.register(galleryPeopleRoutesPlugin);
  await app.register(galleryAlbumRoutesPlugin);
  await app.register(gallerySlideshowRoutesPlugin);
  await app.register(galleryMusicRoutesPlugin);
  await app.register(galleryStreamPlugin);

  // Synthesise the built-in ambient beds once (idempotent; a no-op if the thumbnail
  // store isn't configured or ffmpeg is unavailable). Fire-and-forget so a slow
  // first-boot encode never blocks server startup.
  void seedBuiltinMusic().catch(() => { /* best-effort; uploads still work */ });

  const stopWorker = startGalleryScanWorker();
  const stopFaceWorker = startFaceScanWorker();
  const stopRenderWorker = startSlideshowRenderWorker();
  app.addHook("onClose", async () => {
    stopWorker();
    stopFaceWorker();
    stopRenderWorker();
  });
}
