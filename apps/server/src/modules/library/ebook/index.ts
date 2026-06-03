import type { FastifyInstance } from "fastify";
import { ebookRoutesPlugin } from "./routes.js";
import { startEbookScanWorker } from "./scanner.js";

export async function ebookPlugin(app: FastifyInstance) {
  await app.register(ebookRoutesPlugin);

  const stopWorker = startEbookScanWorker();
  app.addHook("onClose", async () => {
    stopWorker();
  });
}
