import type { FastifyInstance } from "fastify";
import { audiobookRoutesPlugin } from "./routes.js";
import { audiobookBooksPlugin } from "./books.js";
import { audiobookStreamPlugin } from "./stream.js";
import { audiobookPeoplePlugin } from "./people.js";
import { startAudiobookScanWorker } from "./scanner.js";

export async function audiobookPlugin(app: FastifyInstance) {
  await app.register(audiobookRoutesPlugin);
  await app.register(audiobookBooksPlugin);
  await app.register(audiobookStreamPlugin);
  await app.register(audiobookPeoplePlugin);

  const stopWorker = startAudiobookScanWorker();
  app.addHook("onClose", async () => {
    stopWorker();
  });
}
