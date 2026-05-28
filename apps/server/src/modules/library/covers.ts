import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { thumbnailAbsolutePath } from "./shared/thumbnail.js";

function mimeTypeForCover(storageKey: string) {
  return {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp"
  }[path.extname(storageKey).toLowerCase()] ?? "application/octet-stream";
}

export async function coversPlugin(app: FastifyInstance) {
  app.get("/api/library/covers/*", { preHandler: app.authenticate }, async (request, reply) => {
    const storageKey = (request.params as { "*": string })["*"];
    try {
      const absolutePath = thumbnailAbsolutePath(storageKey);
      const cover = await fs.readFile(absolutePath);

      reply
        .type(mimeTypeForCover(storageKey))
        .header("Content-Length", cover.byteLength)
        .header("Cache-Control", "private, max-age=3600")
        .send(cover);
    } catch {
      reply.code(404).send({ error: "Cover not found" });
    }
  });
}
