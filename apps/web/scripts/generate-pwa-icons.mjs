// Generates PWA icons from the brand app-icon SVG.
// Run with: node scripts/generate-pwa-icons.mjs
import sharp from "sharp";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const brandDir = path.join(here, "..", "public", "Assets", "brand");
const src = path.join(brandDir, "isputnik-app-icon.svg");
const out = (name) => path.join(brandDir, name);

// Matches the darkest stop of the icon background gradient (#102238).
const BG = { r: 0x10, g: 0x22, b: 0x38, alpha: 1 };

async function plain(size, name) {
  await sharp(src, { density: 384 }).resize(size, size).png().toFile(out(name));
  console.log(`  ${name} (${size}x${size})`);
}

// Maskable icons must keep content inside the ~80% safe zone, so we render the
// glyph smaller on a solid background that fills the platform's mask shape.
async function maskable(size, name) {
  const inner = Math.round(size * 0.78);
  const glyph = await sharp(src, { density: 384 }).resize(inner, inner).png().toBuffer();
  const pad = Math.round((size - inner) / 2);
  await sharp({ create: { width: size, height: size, channels: 4, background: BG } })
    .composite([{ input: glyph, top: pad, left: pad }])
    .png()
    .toFile(out(name));
  console.log(`  ${name} (${size}x${size}, maskable)`);
}

console.log("Generating PWA icons...");
await plain(192, "pwa-icon-192.png");
await plain(512, "pwa-icon-512.png");
await plain(180, "apple-touch-icon.png");
await maskable(512, "pwa-icon-maskable-512.png");
console.log("Done.");
