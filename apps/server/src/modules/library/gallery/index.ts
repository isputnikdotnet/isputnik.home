import type { FastifyInstance } from "fastify";
import { galleryRoutesPlugin } from "./routes.js";
import { galleryPeopleRoutesPlugin } from "./people-routes.js";
import { galleryStreamPlugin } from "./stream.js";
import { startGalleryScanWorker } from "./scanner.js";
import { startFaceScanWorker } from "./faces/scanner.js";

export async function galleryPlugin(app: FastifyInstance) {
  await app.register(galleryRoutesPlugin);
  await app.register(galleryPeopleRoutesPlugin);
  await app.register(galleryStreamPlugin);

  const stopWorker = startGalleryScanWorker();
  const stopFaceWorker = startFaceScanWorker();
  app.addHook("onClose", async () => {
    stopWorker();
    stopFaceWorker();
  });
}
