import type { FastifyInstance } from "fastify";
import { librarySettingsPlugin } from "./settings.js";
import { coversPlugin } from "./covers.js";
import { storagePlugin } from "./storage.js";
import { audiobookPlugin } from "./audiobook/index.js";
import { ebookPlugin } from "./ebook/index.js";

export async function libraryPlugin(app: FastifyInstance) {
  await app.register(librarySettingsPlugin);
  await app.register(coversPlugin);
  await app.register(storagePlugin);
  await app.register(audiobookPlugin);
  await app.register(ebookPlugin);
}
