// UI-convention checker (see docs/UI-CONVENTIONS.md). Zero dependencies so it
// can run anywhere node runs: scans apps/web/src for patterns that bypass the
// shared UI primitives and exits 1 with file:line pointers when it finds any.
// It also checks that the in-app Help page still lists every user guide.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const REPO = join(import.meta.dirname, "..");
const ROOT = join(REPO, "apps", "web", "src");

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
  },
  {
    // A map built on a hand-written tile URL misses the referrerPolicy that keeps
    // OpenStreetMap drawing anything at all — it answers an unidentified request
    // with a "blocked" image, not an error, so the map looks built and reads wrong.
    pattern: /tile\.openstreetmap\.org/,
    allow: (path) => path === "shared/mapTiles.ts",
    message: "Use OSM_TILE_URL/OSM_TILE_OPTIONS from shared/mapTiles, not a raw tile URL."
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

// ── Buttons render through shared/Button ──
// A raw <button> outside shared/ is a ratchet, not a ban: the files that still
// have some are listed with their count in raw-buttons-baseline.json, and a file
// may only go DOWN. More than its count (or any at all in an unlisted file)
// fails; fewer fails too until the baseline is lowered with
// `npm run check:ui -- --update-button-baseline`, so a converted button can't
// quietly be replaced by a new raw one. The update only ever lowers — raising a
// count means editing the file by hand, where review can see it.
//
// And a <Button> must not hand-apply a variant's class: `className="icon-button"`
// on a bare Button is the same bypass with extra steps. Use `variant`/`compact`.
const BUTTON_BASELINE = join(REPO, "scripts", "raw-buttons-baseline.json");
const VARIANT_CLASS = /(?<![\w-])(primary-button|secondary-button|danger-button|text-button|icon-button|library-toolbar-button|compact-button)(?![\w-])/;
{
  const baseline = existsSync(BUTTON_BASELINE) ? JSON.parse(readFileSync(BUTTON_BASELINE, "utf8")).files ?? {} : {};
  const counts = {};
  const rawLines = {};
  for (const file of walk(ROOT)) {
    const path = relative(ROOT, file).split(sep).join("/");
    if (!path.endsWith(".tsx") || path.startsWith("shared/")) continue;
    const text = readFileSync(file, "utf8");
    text.split("\n").forEach((line, i) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("{/*")) return;
      if (/<button\b/.test(line)) {
        counts[path] = (counts[path] ?? 0) + 1;
        (rawLines[path] ??= []).push(`    ${i + 1}: ${line.trim()}`);
      }
    });
    // The opening tag, up to the first ">" that isn't an arrow's.
    for (const match of text.matchAll(/<Button\b(?:=>|[^>])*>/g)) {
      const classAttr = match[0].match(/className=(?:"[^"]*"|\{[^}]*\})/);
      if (classAttr && VARIANT_CLASS.test(classAttr[0])) {
        const line = text.slice(0, match.index).split("\n").length;
        console.error(`apps/web/src/${path}:${line}  <Button> wears a variant class by hand — use variant="…" / compact instead.`);
        console.error(`    ${classAttr[0]}`);
        failures++;
      }
    }
  }

  if (process.argv.includes("--update-button-baseline")) {
    // Lower only: a file keeps min(now, allowed); an unlisted file stays unlisted.
    const lowered = Object.entries(baseline)
      .map(([path, allowed]) => [path, Math.min(counts[path] ?? 0, allowed)])
      .filter(([, allowed]) => allowed > 0)
      .sort(([a], [b]) => a.localeCompare(b));
    const doc = existsSync(BUTTON_BASELINE) ? JSON.parse(readFileSync(BUTTON_BASELINE, "utf8")) : {};
    doc.files = Object.fromEntries(lowered);
    writeFileSync(BUTTON_BASELINE, `${JSON.stringify(doc, null, 2)}\n`);
    for (const path of Object.keys(baseline)) delete baseline[path];
    Object.assign(baseline, doc.files);
    console.log(`scripts/raw-buttons-baseline.json lowered — ${lowered.reduce((sum, [, n]) => sum + n, 0)} raw <button> allowed outside shared/.`);
  }

  for (const path of new Set([...Object.keys(counts), ...Object.keys(baseline)])) {
    const now = counts[path] ?? 0;
    const allowed = baseline[path] ?? 0;
    if (now > allowed) {
      console.error(
        `apps/web/src/${path}  ${now} raw <button>, ${allowed === 0 ? "none allowed" : `baseline allows ${allowed}`} — render it through shared/Button with a variant (docs/UI-CONVENTIONS.md).`
      );
      console.error(rawLines[path].join("\n"));
      failures++;
    } else if (now < allowed) {
      console.error(
        `scripts/raw-buttons-baseline.json  apps/web/src/${path} is down to ${now} raw <button> (baseline ${allowed}) — lock that in: npm run check:ui -- --update-button-baseline`
      );
      failures++;
    }
  }
}

// ── Help page ↔ docs/users ──
// The Help page is how anyone finds the guides from inside the app, and adding a
// guide without listing it fails silently — the doc exists, nobody can reach it.
// Checked both ways, so a renamed or deleted guide leaves no dead card behind.
const GUIDES_DIR = join(REPO, "docs", "users");
const HELP_PAGE = join(ROOT, "pages", "HelpPage.tsx");

if (existsSync(GUIDES_DIR) && existsSync(HELP_PAGE)) {
  const help = readFileSync(HELP_PAGE, "utf8");
  // The page builds hrefs with a guide("file.md") helper.
  const listed = new Set([...help.matchAll(/guide\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]));
  // README.md is the folder's own index, not a guide the app links to.
  const onDisk = readdirSync(GUIDES_DIR).filter((name) => name.endsWith(".md") && name !== "README.md");

  for (const name of onDisk) {
    if (!listed.has(name)) {
      console.error(`docs/users/${name}  Guide isn't listed on the Help page (apps/web/src/pages/HelpPage.tsx).`);
      failures++;
    }
  }
  for (const name of listed) {
    if (!existsSync(join(GUIDES_DIR, name))) {
      console.error(`apps/web/src/pages/HelpPage.tsx  Links to docs/users/${name}, which doesn't exist.`);
      failures++;
    }
  }
}

// ── Locale key parity ──
// English (apps/web/src/locales/en) is the source of truth; every other language
// must carry exactly the same keys in the same files. Runtime fallback would hide
// a missing translation behind an English string, so drift is caught here instead.
const LOCALES_DIR = join(ROOT, "locales");

if (existsSync(LOCALES_DIR)) {
  const flatten = (value, prefix = "") =>
    value !== null && typeof value === "object"
      ? Object.entries(value).flatMap(([key, child]) => flatten(child, prefix ? `${prefix}.${key}` : key))
      : [prefix];
  // Languages legitimately differ in which CLDR plural forms they carry (English
  // has one/other, Russian one/few/many/other), so compare plural keys by their
  // base name — "hour_few" counts as "hour".
  const dePlural = (key) => key.replace(/_(zero|one|two|few|many|other)$/, "");
  const keysOf = (lang, file) => {
    try {
      return new Set(flatten(JSON.parse(readFileSync(join(LOCALES_DIR, lang, file), "utf8"))).map(dePlural));
    } catch (err) {
      console.error(`apps/web/src/locales/${lang}/${file}  Invalid JSON: ${err.message}`);
      failures++;
      return new Set();
    }
  };
  const jsonIn = (dir) => (existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".json")) : []);

  const enFiles = jsonIn(join(LOCALES_DIR, "en"));
  const languages = readdirSync(LOCALES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "en")
    .map((entry) => entry.name);

  for (const lang of languages) {
    const langFiles = jsonIn(join(LOCALES_DIR, lang));
    for (const file of langFiles) {
      if (!enFiles.includes(file)) {
        console.error(`apps/web/src/locales/${lang}/${file}  Has no English counterpart (en is the source of truth).`);
        failures++;
      }
    }
    for (const file of enFiles) {
      if (!langFiles.includes(file)) {
        console.error(`apps/web/src/locales/en/${file}  Missing from locales/${lang}/ — every language mirrors en.`);
        failures++;
        continue;
      }
      const enKeys = keysOf("en", file);
      const langKeys = keysOf(lang, file);
      for (const key of enKeys) {
        if (!langKeys.has(key)) {
          console.error(`apps/web/src/locales/${lang}/${file}  Missing key "${key}" (present in en).`);
          failures++;
        }
      }
      for (const key of langKeys) {
        if (!enKeys.has(key)) {
          console.error(`apps/web/src/locales/${lang}/${file}  Key "${key}" doesn't exist in en — removed, renamed, or a typo.`);
          failures++;
        }
      }
    }
  }
}

// ── Custom properties nobody defines (warning only) ──
// A var(--x) that no stylesheet or component ever sets resolves to its fallback,
// or to nothing — which is how `--accent` spent months as a colour two files
// guessed differently. Names are collected from every `--x:` declaration in the
// CSS and every "--x" string in the TS/TSX (inline styles, setProperty). Reported
// once per name, never fatal: some of these are deliberate hooks with a fallback.
{
  const defined = new Set();
  const uses = new Map(); // name -> ["file:line", …]
  function* everything(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) yield* everything(full);
      else if (/\.(css|tsx?)$/.test(entry.name)) yield full;
    }
  }
  for (const file of everything(ROOT)) {
    const isCss = file.endsWith(".css");
    // Blank out CSS comments but keep their newlines, so line numbers hold.
    const text = isCss
      ? readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
      : readFileSync(file, "utf8");
    const definitions = isCss ? /(--[\w-]+)\s*:/g : /["'`](--[a-zA-Z][\w-]*)["'`]/g;
    for (const match of text.matchAll(definitions)) defined.add(match[1]);
    for (const match of text.matchAll(/var\(\s*(--[\w-]+)/g)) {
      const line = text.slice(0, match.index).split("\n").length;
      const where = `apps/web/src/${relative(ROOT, file).split(sep).join("/")}:${line}`;
      uses.set(match[1], [...(uses.get(match[1]) ?? []), where]);
    }
  }
  const undefinedNames = [...uses.keys()].filter((name) => !defined.has(name)).sort();
  for (const name of undefinedNames) {
    const where = uses.get(name);
    const more = where.length > 3 ? ` (+${where.length - 3} more)` : "";
    console.warn(`warning: var(${name}) is never defined — ${where.slice(0, 3).join(", ")}${more}`);
  }
}

if (failures > 0) {
  console.error(`\ncheck:ui failed — ${failures} violation${failures === 1 ? "" : "s"}. See docs/UI-CONVENTIONS.md.`);
  process.exit(1);
}
console.log("check:ui passed — UI conventions hold, Help lists every guide, locales are in sync.");
