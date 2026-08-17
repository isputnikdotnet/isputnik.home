import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { resolveCoverKey, LIBRARY_BUCKET_RE } from "./shared/thumbnail.js";
import { getAccessibleLibrary } from "./shared/library-access.js";

function mimeTypeForCover(storageKey: string) {
  return {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp"
  }[path.extname(storageKey).toLowerCase()] ?? "application/octet-stream";
}

export async function coversPlugin(app: FastifyInstance) {
  // Thumbnails arrive in bursts — one gallery timeline page is 80 <img>s at once,
  // and a few "Load more" clicks would drain the global per-IP budget and 429 the
  // real API calls. This route gets its own, larger bucket: the files are tiny,
  // auth-gated, and immutably cached (?v=), so the ceiling only bounds scripted abuse.
  app.get("/api/library/covers/*", {
    preHandler: app.authenticate,
    config: { rateLimit: { max: 6000, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const storageKey = (request.params as { "*": string })["*"];
    // Thumbnails under a library bucket (item covers, previews, series covers,
    // face crops) are only for people who can see that library. The keys are
    // deterministic (<libraryId>/<shard>/<item>-cover.webp), so authentication
    // alone let any signed-in user fetch a private library's thumbnails by
    // reconstructing a key. resolveCoverKey derives the bucket from the RESOLVED
    // path (so an encoded-slash/.. key can't dodge the check) and rejects
    // non-image keys; gate the library-scoped buckets on library access. The
    // shared "people"/"categories" buckets are cross-library by design and don't
    // match LIBRARY_BUCKET_RE, so they pass through.
    const resolved = resolveCoverKey(storageKey);
    if (!resolved) {
      return reply.code(404).send({ error: "Cover not found" });
    }
    const user = request.user!;
    if (LIBRARY_BUCKET_RE.test(resolved.bucket) && !getAccessibleLibrary(resolved.bucket, user.id, user.role)) {
      return reply.code(404).send({ error: "Cover not found" });
    }
    try {
      const absolutePath = resolved.absolutePath;
      const stat = await fs.stat(absolutePath);

      // A `?v=` query param means the caller mints a fresh URL whenever the image
      // changes (callers pass the item's updated_at — see mapAsset). That URL is
      // therefore safe to cache immutably: the browser never re-requests it, and a
      // real change arrives under a new URL. This is what stops a person/timeline
      // grid of hundreds of thumbnails from re-hitting the server on every view.
      const versioned = typeof (request.query as { v?: string }).v === "string" && (request.query as { v?: string }).v !== "";
      if (versioned) {
        reply.header("Cache-Control", "private, max-age=31536000, immutable");
      } else {
        // Un-versioned keys (face-crop avatars, in-place-overwritten covers) keep the
        // same URL across edits, so cache by a content validator (size + mtime): the
        // browser revalidates each load and we 304 when unchanged, but serve the new
        // image the moment the file is replaced — no stale cover lingering after an edit.
        const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
        reply.header("Cache-Control", "private, no-cache").header("ETag", etag);
        if (request.headers["if-none-match"] === etag) {
          return reply.code(304).send();
        }
      }

      const cover = await fs.readFile(absolutePath);
      return reply
        .type(mimeTypeForCover(storageKey))
        .header("Content-Length", cover.byteLength)
        .send(cover);
    } catch {
      return reply.code(404).send({ error: "Cover not found" });
    }
  });
}
