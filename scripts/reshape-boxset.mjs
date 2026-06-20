// Reshape a multi-work audiobook "box set" (one folder holding several works at
// irregular depths — a "Selected Works" rip, a multi-CD omnibus, …) into the
// one-folder-per-book layout the scanner ingests cleanly in "Treat folder as book"
// mode:
//
//   <out>/<Author> - <Title> [<Narrator>]/
//       metadata.json   (authoritative: author / narrator / series / language)
//       cover.tif        (the scanner transcodes .tif -> webp on import)
//       <audio…>         (subfolders preserved; play order falls out of the path sort)
//
// Pure Node, no dependencies. Hardlinks by default (instant, no extra disk on the
// same volume) with a copy fallback; deleting <out> never touches the originals.
//
// THIS IS A TEMPLATE. The WORKS table below is the mapping for one specific box set
// (Андрэй Каляда — Выбранае Уладзіміра Караткевіча) and is meant to be edited for
// yours: set AUTHOR/NARRATOR, then list each target book with the source folder(s)
// to pull from, the cover, and any series info. Sources/covers are matched by
// substring against what's actually on disk, so exact spelling never has to be
// retyped here.
//
//   node scripts/reshape-boxset.mjs --box "<boxDir>" --out "<outDir>"            # dry run
//   node scripts/reshape-boxset.mjs --box "<boxDir>" --out "<outDir>" --apply --clean
//   node scripts/reshape-boxset.mjs ... --apply --copy        # real copies, not hardlinks
//   node scripts/reshape-boxset.mjs ... --anthology           # keep grouped works as ONE book
//
// Flags: --box <dir> (required)  --out <dir> (required)  --apply  --link|--copy  --clean  --anthology

import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const val = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};

const BOX = val("--box");
const OUT = val("--out");
const APPLY = has("--apply");
const LINK = !has("--copy"); // hardlink unless --copy is given
const CLEAN = has("--clean");
const ANTHOLOGY = has("--anthology");

if (!BOX || !OUT) {
  console.error("usage: node scripts/reshape-boxset.mjs --box <dir> --out <dir> [--apply --link|--copy --clean --anthology]");
  process.exit(2);
}
const boxRoot = path.resolve(BOX);
const outRoot = path.resolve(OUT);

// ─── Edit for your box set ──────────────────────────────────────────────────
const AUTHOR = "Уладзімір Караткевіч";
const NARRATOR = "Андрэй Каляда";
const LANG = "be";
const LIT = "Беларуская літаратура";
// Optional grouping folder whose children are separate works (split unless --anthology).
const GROUP_DIR = "Аповесці";
const GROUP_TITLES = { "1": "Цыганскі кароль", "2": "Сівая легенда", "3": "Ладдзя роспачы", "4": "Чазенія" };

// Each book: out title, the box subfolder(s) to pull from (substring-matched), the
// cover (substring-matched within Covers/), and optional series / genre overrides.
const WORK_DEFS = [
  { title: "Дзікае паляванне караля Стаха", from: [["Дзікае"]], cover: ["Паляванне"] },
  { title: "Хрыстос прызямліўся ў Гародні", from: [["Хрыстос"]], cover: ["Хрыстос"] },
  { title: "Каласы пад сярпом тваім, кніга 1", from: [["Каласы", "першая"]], cover: ["Каласы", "1"], series: "Каласы пад сярпом тваім", seriesPosition: 1 },
  { title: "Каласы пад сярпом тваім, кніга 2", from: [["Каласы", "другая"]], cover: ["Каласы", "2"], series: "Каласы пад сярпом тваім", seriesPosition: 2 },
  { title: "Быў. Ёсць. Буду", from: [["Быў"]], cover: ["Быў"], genres: ["Паэзія"] },
  { title: "Чорны замак Альшанскі", from: [["замак"]], cover: ["Замак"] }
];
// ────────────────────────────────────────────────────────────────────────────

const AUDIO_EXT = new Set([".mp3", ".m4a", ".m4b", ".flac", ".ogg", ".opus", ".aac", ".wav", ".wave"]);
const numCmp = (a, b) => a.localeCompare(b, undefined, { numeric: true });
const listDirs = (p) => { try { return fs.readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; } };
const listFiles = (p) => { try { return fs.readdirSync(p, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name); } catch { return []; } };

const boxDirs = listDirs(boxRoot);
const coverFiles = listFiles(path.join(boxRoot, "Covers"));
const groupDirs = listDirs(path.join(boxRoot, GROUP_DIR)).sort(numCmp);

const matchDirs = (tokens) => boxDirs.filter((n) => tokens.every((t) => n.includes(t))).sort(numCmp).map((n) => path.join(boxRoot, n));
const matchCover = (tokens) => {
  const m = coverFiles.filter((n) => tokens.every((t) => n.includes(t))).sort(numCmp)[0];
  return m ? path.join(boxRoot, "Covers", m) : null;
};
const baseMeta = (title, extra = {}) => ({ title, authors: [AUTHOR], narrators: [NARRATOR], language: LANG, genres: [LIT], ...extra });

const works = WORK_DEFS.map((def) => ({
  out: def.title,
  sources: def.from.flatMap(matchDirs),
  cover: matchCover(def.cover),
  meta: baseMeta(def.title, {
    ...(def.genres ? { genres: def.genres } : {}),
    ...(def.series ? { series: def.series, seriesPosition: def.seriesPosition } : {})
  })
}));

if (ANTHOLOGY) {
  works.push({ out: GROUP_DIR, sources: groupDirs.map((n) => path.join(boxRoot, GROUP_DIR, n)), cover: matchCover([GROUP_DIR]), meta: baseMeta(GROUP_DIR) });
} else {
  for (const n of groupDirs) {
    const idx = (n.match(/^\d+/) || ["?"])[0];
    const title = GROUP_TITLES[idx] || n.replace(/^\d+\s*-\s*/, "").trim();
    works.push({ out: title, sources: [path.join(boxRoot, GROUP_DIR, n)], cover: matchCover([GROUP_DIR]), meta: baseMeta(title) });
  }
}

function collectAudio(dir) {
  const out = [];
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const abs = path.join(d, e.name);
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) walk(abs, r);
      else if (AUDIO_EXT.has(path.extname(e.name).toLowerCase())) out.push({ abs, rel: r });
    }
  })(dir, "");
  return out;
}

let linked = 0;
let copied = 0;
function place(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (LINK) {
    try { fs.linkSync(src, dest); linked++; return; } catch { /* cross-volume etc → copy */ }
  }
  fs.copyFileSync(src, dest);
  copied++;
}

console.log(`box:  ${boxRoot}`);
console.log(`out:  ${outRoot}`);
console.log(`mode: ${APPLY ? "APPLY" : "dry-run"} · ${LINK ? "hardlink (copy fallback)" : "copy"}${ANTHOLOGY ? ` · ${GROUP_DIR} as one book` : ` · ${GROUP_DIR} split`}\n`);

if (boxDirs.length === 0) { console.error(`! box not found or empty: ${boxRoot}`); process.exit(1); }

if (APPLY) {
  if (fs.existsSync(outRoot) && fs.readdirSync(outRoot).length > 0 && !CLEAN) {
    console.error(`! ${outRoot} is not empty — pass --clean to replace it.`);
    process.exit(1);
  }
  if (CLEAN) fs.rmSync(outRoot, { recursive: true, force: true });
  fs.mkdirSync(outRoot, { recursive: true });
}

let grand = 0;
const warnings = [];
for (const w of works) {
  const outDir = path.join(outRoot, `${AUTHOR} - ${w.out} [${NARRATOR}]`);
  const multi = w.sources.length > 1;
  if (w.sources.length === 0) warnings.push(`no source matched for "${w.out}"`);
  if (!w.cover) warnings.push(`no cover matched for "${w.out}"`);

  let n = 0;
  for (const src of w.sources) {
    const base = multi ? path.join(outDir, path.basename(src)) : outDir;
    for (const f of collectAudio(src)) {
      if (APPLY) place(f.abs, path.join(base, f.rel));
      n++;
    }
  }
  if (APPLY) {
    fs.mkdirSync(outDir, { recursive: true });
    if (w.cover) fs.copyFileSync(w.cover, path.join(outDir, "cover.tif"));
    fs.writeFileSync(path.join(outDir, "metadata.json"), `${JSON.stringify(w.meta, null, 2)}\n`, "utf8");
  }
  grand += n;

  const series = w.meta.series ? `  series="${w.meta.series}" #${w.meta.seriesPosition}` : "";
  console.log(`• ${w.out}`);
  console.log(`    ${String(n).padStart(3)} files · ${w.sources.length} source(s)${multi ? " → subfolders" : ""} · cover=${w.cover ? path.basename(w.cover) : "—"}${series}`);
}

console.log(`\n${works.length} books · ${grand} audio files${APPLY ? ` · ${linked} hardlinked, ${copied} copied` : ""}`);
if (warnings.length) console.log(`warnings:\n  - ${warnings.join("\n  - ")}`);
if (!APPLY) console.log(`\nThis was a dry run. Re-run with --apply --clean to write to ${outRoot}.`);
