import type { FastifyInstance } from "fastify";
import { audiobookRoutesPlugin } from "./routes.js";
import { audiobookBooksPlugin } from "./books.js";
import { startAudiobookScanWorker } from "./scanner.js";

export async function audiobookPlugin(app: FastifyInstance) {
  await app.register(audiobookRoutesPlugin);
  await app.register(audiobookBooksPlugin);

  const stopWorker = startAudiobookScanWorker();
  app.addHook("onClose", async () => {
    stopWorker();
  });
}
