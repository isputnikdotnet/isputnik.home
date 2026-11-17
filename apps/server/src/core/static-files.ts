// The web app's files (apps/web/dist), served by @fastify/static.
//
// Two things a plain registration got wrong:
//
// • Compression. @fastify/static streams files, and response compression
//   (core/compression.ts) deliberately leaves streams alone, so scripts and
//   styles went out raw: about 1.9 MB on a first visit instead of about 400 KB.
//   The web build writes a .br and a .gz beside every text file
//   (apps/web/scripts/precompress.mjs); `preCompressed` sends the one the browser
//   accepts, falls back to the original otherwise, and adds `Vary: accept-encoding`.
//
// • Caching. Everything was `max-age=0`, so a browser asked again for files that
//   can never change. Files under static/ carry a content hash in their name
//   (Vite's assetsDir), so they are cached for a year as immutable. Everything
//   else — index.html, sw.js, the manifest, guides, icons — keeps the default and
//   is revalidated, so a new release is picked up on the next load.
import path from "node:path";
import type { FastifyInstance } from "fastify";
import staticFiles from "@fastify/static";

/** Vite's assetsDir: every file in it has a content hash in its name. */
export const HASHED_ASSETS_DIR = "static";
export const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

/** Whether a served file sits in the hashed-assets folder under `root`. */
export function isHashedAsset(root: string, filePath: string): boolean {
  const relative = path.relative(path.join(path.resolve(root), HASHED_ASSETS_DIR), path.resolve(filePath));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export async function registerStaticFiles(app: FastifyInstance, root: string): Promise<void> {
  await app.register(staticFiles, {
    root,
    wildcard: false,
    preCompressed: true,
    setHeaders: (reply, filePath) => {
      if (isHashedAsset(root, filePath)) reply.header("cache-control", IMMUTABLE_CACHE);
    }
  });
}
