import type { FastifyInstance } from "fastify";
import { galleryRoutesPlugin } from "./routes.js";
import { galleryStreamPlugin } from "./stream.js";
import { startGalleryScanWorker } from "./scanner.js";

export async function galleryPlugin(app: FastifyInstance) {
  await app.register(galleryRoutesPlugin);
  await app.register(galleryStreamPlugin);

  const stopWorker = startGalleryScanWorker();
  app.addHook("onClose", async () => {
    stopWorker();
  });
}
