// UI-convention checker (see docs/UI-CONVENTIONS.md). Zero dependencies so it
// can run anywhere node runs: scans apps/web/src for patterns that bypass the
// shared UI primitives and exits 1 with file:line pointers when it finds any.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(import.meta.dirname, "..", "apps", "web", "src");

// path is checked with forward slashes, relative to apps/web/src
const RULES = [
  {
    pattern: /\bwindow\.(confirm|alert)\s*\(|(?<![.\w])(?:confirm|alert)\s*\(/,
    allow: () => false,
    message: "Use shared/ConfirmDialog (or MessageBox) instead of confirm()/alert()."
  },
  {
    pattern: /modal-backdrop/,
    allow: (path) => path === "shared/Modal.tsx",
    message: "Use shared/Modal instead of hand-rolling a modal-backdrop."
  },
  {
    pattern: /className=["'`{][^"'`}]*(?<![\w-])(confirm-modal|metadata-modal)(?![\w-])/,
    allow: (path) => path.startsWith("shared/"),
    message: "Modal surfaces (confirm-modal/metadata-modal) are owned by shared/Modal."
  }
];

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(tsx|ts)$/.test(entry.name)) yield full;
  }
}

let failures = 0;
for (const file of walk(ROOT)) {
  const path = relative(ROOT, file).split(sep).join("/");
  if (path.endsWith(".d.ts")) continue;
  const lines = readFileSync(file, "utf8").split("\n");
  for (const rule of RULES) {
    if (rule.allow(path)) continue;
    lines.forEach((line, i) => {
      if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) return;
      if (rule.pattern.test(line)) {
        console.error(`apps/web/src/${path}:${i + 1}  ${rule.message}`);
        console.error(`    ${line.trim()}`);
        failures++;
      }
    });
  }
}

if (failures > 0) {
  console.error(`\ncheck:ui failed — ${failures} violation${failures === 1 ? "" : "s"}. See docs/UI-CONVENTIONS.md.`);
  process.exit(1);
}
console.log("check:ui passed — UI conventions hold.");
