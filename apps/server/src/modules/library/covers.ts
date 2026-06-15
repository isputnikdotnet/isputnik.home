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
      const stat = await fs.stat(absolutePath);

      // Cover files are overwritten in place under a deterministic key when a
      // cover changes, so the URL stays the same. Cache by a content validator
      // (size + mtime) rather than a fixed max-age: the browser revalidates each
      // load and we 304 when unchanged, but serve the new image the moment the
      // file is replaced — no stale cover lingering after an edit.
      const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
      reply.header("Cache-Control", "private, no-cache").header("ETag", etag);

      if (request.headers["if-none-match"] === etag) {
        reply.code(304).send();
        return;
      }

      const cover = await fs.readFile(absolutePath);
      reply
        .type(mimeTypeForCover(storageKey))
        .header("Content-Length", cover.byteLength)
        .send(cover);
    } catch {
      reply.code(404).send({ error: "Cover not found" });
    }
  });
}
