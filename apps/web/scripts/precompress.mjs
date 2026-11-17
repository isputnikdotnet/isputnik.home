// After `vite build`: write a Brotli (.br) and a gzip (.gz) copy beside every text
// file in dist, for the server to send to browsers that accept them
// (@fastify/static `preCompressed`, apps/server/src/core/static-files.ts).
//
// Why at build time: the server streams static files, and its own response
// compression (core/compression.ts) leaves streams alone, so the app's scripts
// and styles went out uncompressed: about 1.9 MB on a first visit instead of
// about 400 KB. Compressing once here, at the highest settings, costs nothing
// per request.
//
// A copy is written only when it is meaningfully smaller than the original;
// otherwise the server falls back to the original file.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const TEXT = /\.(js|mjs|css|html|svg|json|webmanifest|txt|md|xml|map)$/i;
const MIN_BYTES = 1024;

let files = 0, before = 0, after = 0;
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    if (!TEXT.test(entry.name)) continue;
    const source = fs.readFileSync(full);
    if (source.length < MIN_BYTES) continue;
    const br = brotliCompressSync(source, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
        [constants.BROTLI_PARAM_SIZE_HINT]: source.length
      }
    });
    const gz = gzipSync(source, { level: 9 });
    // Not worth a second file (and a second lookup) for under 10 % saved.
    if (br.length < source.length * 0.9) fs.writeFileSync(`${full}.br`, br);
    if (gz.length < source.length * 0.9) fs.writeFileSync(`${full}.gz`, gz);
    files += 1;
    before += source.length;
    after += Math.min(br.length, source.length);
  }
}

if (!fs.existsSync(dist)) {
  console.error(`precompress: ${dist} does not exist — run vite build first.`);
  process.exit(1);
}
walk(dist);
const mb = (n) => (n / 1048576).toFixed(2);
console.log(`precompress: ${files} files, ${mb(before)} MB → ${mb(after)} MB with Brotli.`);
