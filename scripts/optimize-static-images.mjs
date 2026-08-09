// Converts the app's bundled static artwork from PNG to WebP, sized to what the
// UI actually renders.
//
// Why: the built-in category art shipped as 1254x1254 PNGs, ~2.9 MB each, into a
// layout whose largest render is the 246px preview in the category editor (and a
// 40x40 thumbnail in the list). Thirteen of them made 37 MB of the Docker image
// and of every browser's cache, to draw pictures no bigger than a postage stamp.
// The default covers were the same story in miniature: ~900 KB of PNG for a
// placeholder. WebP at these sizes is 40-50x smaller with no visible difference.
//
// Sizes are derived from the CSS, not guessed:
//   category art  512px  - .category-large-preview sits in a 246px sidebar column
//                          (category-images.css), so 512 covers it at 2x DPR.
//   default covers native - already ~750x1047, which is right for a cover tile;
//                          only the encoding was wrong.
//   scene backdrops native - 1672x941 painted with `background-size: cover` over
//                          the whole viewport (layout.css), so a wide monitor is
//                          already upscaling them. Never shrink these; encode at
//                          a higher quality with smart chroma subsampling too,
//                          because upscaling magnifies artefacts and the space
//                          art is mostly the wide, smooth gradients that band
//                          first.
//
// The script is idempotent: it skips a target that is already newer than its
// source, so re-running after adding one new PNG only converts that one.
//
// Usage:  node scripts/optimize-static-images.mjs [--keep-png] [--force]
//   --keep-png  leave the PNG originals in place (default: delete them, since
//               nothing references them once the code points at .webp)
//   --force     re-encode even when the .webp is already up to date

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// sharp is a server dependency; this script runs from the repo root.
const require = createRequire(import.meta.url);
const sharp = require("sharp");

const root = fileURLToPath(new URL("..", import.meta.url));
const keepPng = process.argv.includes("--keep-png");
const force = process.argv.includes("--force");

/** `size` null keeps the source dimensions; `webp` is passed to sharp's encoder.
 *  @type {{ dir: string, size: number | null, webp: import("sharp").WebpOptions }[]} */
const TARGETS = [
  { dir: "apps/web/public/Assets/categories", size: 512, webp: { quality: 80 } },
  { dir: "apps/web/public/Assets/covers", size: null, webp: { quality: 82 } },
  {
    dir: "apps/web/src/assets/backgrounds",
    size: null,
    webp: { quality: 86, smartSubsample: true }
  }
];

let totalBefore = 0;
let totalAfter = 0;
let converted = 0;
let skipped = 0;

for (const target of TARGETS) {
  const dir = path.join(root, target.dir);
  if (!fs.existsSync(dir)) {
    console.warn(`skip (missing): ${target.dir}`);
    continue;
  }
  const pngs = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".png")).sort();
  for (const name of pngs) {
    const src = path.join(dir, name);
    const dest = src.replace(/\.png$/i, ".webp");
    const srcStat = fs.statSync(src);

    if (!force && fs.existsSync(dest) && fs.statSync(dest).mtimeMs >= srcStat.mtimeMs) {
      skipped += 1;
      continue;
    }

    let pipeline = sharp(src);
    if (target.size) pipeline = pipeline.resize(target.size, target.size, { fit: "cover" });
    const out = await pipeline.webp(target.webp).toBuffer();
    fs.writeFileSync(dest, out);

    totalBefore += srcStat.size;
    totalAfter += out.length;
    converted += 1;
    const ratio = (srcStat.size / out.length).toFixed(0);
    console.log(
      `${name.padEnd(32)} ${kb(srcStat.size).padStart(9)} -> ${kb(out.length).padStart(8)}  (${ratio}x)`
    );

    if (!keepPng) fs.unlinkSync(src);
  }
}

function kb(bytes) {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(2)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
}

console.log(
  `\n${converted} converted, ${skipped} already current` +
    (converted ? `  ${kb(totalBefore)} -> ${kb(totalAfter)}` : "") +
    (keepPng ? "  (PNG originals kept)" : "")
);
