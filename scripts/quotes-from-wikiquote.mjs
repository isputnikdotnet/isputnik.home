#!/usr/bin/env node
// Build a quote pack for the Quotes import (docs/users/quotes.md) out of
// Wikiquote pages.
//
//   node scripts/quotes-from-wikiquote.mjs --lang ru --out ru.json \
//     --tags Литература --pages "Антон Павлович Чехов" "Лев Николаевич Толстой"
//
//   node scripts/quotes-from-wikiquote.mjs --lang en --out en.json \
//     --tags Wisdom --limit 40 --page-file authors.txt
//
// A one-off utility, not part of the app — the plan (docs/quotes-plan.md) keeps
// dataset converters here in scripts/ rather than shipping them.
//
// Two things make the output worth importing rather than merely large:
//
//   • SECTIONS ARE FILTERED. Wikiquote pages carry "Misattributed", "Disputed"
//     and "Quotes about X" sections, and scraping a page whole is exactly how
//     quote collections end up full of things their author never said. Those
//     sections are skipped; only the person's own quotes are taken.
//   • ROWS THAT WOULD EMBARRASS YOU ARE DROPPED. Anything still carrying markup
//     after cleaning, or too short to be a thought, or too long for a card, is
//     rejected and counted rather than shipped.
//
// The result still wants a human pass — run the import's dry run, read the
// preview, and use the Quotes page's "Imported" filter to weed afterwards.
//
// Wikiquote is CC BY-SA. Fine for a private family library; attribute it if you
// ever republish.
import fs from "node:fs/promises";

const USER_AGENT = "isputnik-home-quote-import/1.0 (private family library; one-off import)";
/** Titles per API request. The API's own cap for anonymous callers is 50. */
const BATCH_SIZE = 20;

// Sections that are not the subject's own words. Scraping these is how a pack
// ends up asserting that Mark Twain said things Mark Twain never said.
const SKIP_SECTIONS = {
  en: /misattributed|disputed|attributed|quotes about|about .*|external links|see also|references|notes|bibliography|further reading/i,
  ru: /цитаты о|о чехове|приписыва|источник|примечан|ссылк|см\. также|литератур|библиограф/i
};

function parseArgs(argv) {
  const args = { lang: "en", tags: [], pages: [], limit: 40, out: null, pageFile: null, maxLength: 300, total: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--lang") args.lang = argv[++i];
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--limit") args.limit = Number(argv[++i]);
    else if (arg === "--max-length") args.maxLength = Number(argv[++i]);
    else if (arg === "--total") args.total = Number(argv[++i]);
    else if (arg === "--page-file") args.pageFile = argv[++i];
    else if (arg === "--tags") { while (argv[i + 1] && !argv[i + 1].startsWith("--")) args.tags.push(argv[++i]); }
    else if (arg === "--pages") { while (argv[i + 1] && !argv[i + 1].startsWith("--")) args.pages.push(argv[++i]); }
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.out) throw new Error("--out <file> is required");
  return args;
}

/**
 * Remove a pattern until the text stops changing. A single pass is a lie
 * whenever removing the pattern can rebuild it: "<!-<!-- ->-->" leaves a live
 * "<!--" behind, and "<<ref>ref>" leaves a "<ref>". Wikitext rarely nests that
 * way by accident, but what this script prints is shipped as data, so it should
 * be what it claims. Every pattern passed here only ever shrinks the string, so
 * the loop always settles.
 */
function replaceUntilStable(text, pattern, replacement) {
  let current = text;
  let previous;
  do {
    previous = current;
    current = current.replace(pattern, replacement);
  } while (current !== previous);
  return current;
}

const stripUntilStable = (text, pattern) => replaceUntilStable(text, pattern, "");

/** Wikitext → plain text. Order matters: refs and comments go before anything else. */
function clean(wikitext) {
  let text = wikitext;
  for (const pattern of [/<ref[^>]*\/>/gi, /<ref[^>]*>[\s\S]*?<\/ref>/gi, /<!--[\s\S]*?-->/g]) {
    text = stripUntilStable(text, pattern);
  }
  // Templates that RENDER their first argument, before the blanket removal
  // below eats it. {{comment|меня|персонажа Ивана Семёныча}} is a word of the
  // quote plus an editor's note, and dropping the lot turns "У меня много
  // детей" into "У много детей" — mangled, and mangled invisibly.
  // Repeated, innermost pair outward: {{nobr|{{lang-la|dixit}}}} renders the
  // inner one first, and only a second pass can then see the outer as a
  // rendering template rather than a nested blob the blanket removal eats.
  text = replaceUntilStable(text, /\{\{\s*(?:comment|comment2|nobr|lang-\w+)\s*\|\s*([^|{}]*?)\s*(?:\|[^{}]*)?\}\}/gi, "$1");
  // Leftover inline templates, innermost pair first: repeating unwraps a nested
  // {{a|{{b}}}}, which one pass leaves as a half-eaten "{{a|}}" — and isUsable
  // then throws the whole quote away for still carrying braces.
  text = stripUntilStable(text, /\{\{[^{}]*\}\}/g);
  text = text
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, "$1") // [[target|shown]] → shown
    .replace(/\[\[([^\]]*)\]\]/g, "$1")          // [[shown]]        → shown
    .replace(/\[https?:\/\/\S+\s([^\]]*)\]/g, "$1") // [url label]   → label
    .replace(/'''''|'''|''/g, "");
  text = stripUntilStable(text, /<[^>]+>/g);     // any tag that survived
  return text.replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * A citation is only worth keeping if it names something. Wikiquote's nested
 * bullets run from "Walden (1854)" to a chapter number to a whole publication
 * history with links in it — so a source that is markup, a URL, or a bare
 * "III" is dropped and the quote keeps its attribution alone.
 */
function usableSource(source) {
  if (!source) return null;
  const trimmed = source
    .replace(/\s*\[[^\]]*$/, "")
    // A linked title that cleaned away to nothing leaves its quote marks behind:
    // `"", st. 12, in The Dramatic Review` — drop the empty pair, keep the rest.
    .replace(/^["“”']{2}\s*[,;]?\s*/, "")
    .replace(/[.,;\s]+$/, "")
    .trim();
  if (trimmed.length < 8 || trimmed.length > 120) return null;
  if (/[{}[\]|<>]|https?:\/\//.test(trimmed)) return null;
  if (/^[IVXLCDM\d\s.,§#-]+$/i.test(trimmed)) return null;   // "III", "§ 6.20", "1854"
  if (!/\p{L}{3}/u.test(trimmed)) return null;
  return trimmed;
}

/** Would this embarrass you on the home page? Then it is not a quote. */
function isUsable(text, maxLength) {
  if (text.length < 25 || text.length > maxLength) return false;
  // Cleaning missed something — markup, a citation, a URL.
  if (/[{}[\]|<>]|https?:\/\//.test(text)) return false;
  // Wikiquote's own ellipsis for an editorial cut: the sentence is incomplete.
  if (text.includes("<…>") || text.includes("…>")) return false;
  if (!/[.!?…»"']$/.test(text)) return false;
  // Mostly punctuation or digits is a citation fragment, not a thought.
  const letters = text.replace(/[^\p{L}]/gu, "").length;
  return letters / text.length > 0.6;
}

/**
 * Russian Wikiquote holds quotes in {{Q|text|Параметр=…}} templates, so the text
 * is the first POSITIONAL parameter. Braces nest, which is why this scans rather
 * than matching a regex.
 */
function extractTemplateQuotes(wikitext, skip) {
  const found = [];
  let section = "";
  for (let i = 0; i < wikitext.length; i += 1) {
    if (wikitext.startsWith("==", i)) {
      const end = wikitext.indexOf("\n", i);
      section = wikitext.slice(i, end === -1 ? undefined : end).replace(/=/g, "").trim();
      continue;
    }
    if (!wikitext.startsWith("{{Q|", i) && !wikitext.startsWith("{{Q |", i)) continue;
    if (skip.test(section)) continue;

    let depth = 0;
    let end = i;
    for (let j = i; j < wikitext.length; j += 1) {
      if (wikitext.startsWith("{{", j)) { depth += 1; j += 1; continue; }
      if (wikitext.startsWith("}}", j)) {
        depth -= 1;
        if (depth === 0) { end = j; break; }
        j += 1;
      }
    }
    if (end === i) continue;

    const body = wikitext.slice(i + 4, end);
    // Split on the pipes that separate template parameters, ignoring pipes that
    // belong to a nested [[link|label]] or {{template|arg}}.
    const parts = [];
    let depthBrace = 0;
    let depthBracket = 0;
    let current = "";
    for (let j = 0; j < body.length; j += 1) {
      if (body.startsWith("{{", j)) { depthBrace += 1; current += "{{"; j += 1; continue; }
      if (body.startsWith("}}", j)) { depthBrace -= 1; current += "}}"; j += 1; continue; }
      if (body.startsWith("[[", j)) { depthBracket += 1; current += "[["; j += 1; continue; }
      if (body.startsWith("]]", j)) { depthBracket -= 1; current += "]]"; j += 1; continue; }
      if (body[j] === "|" && depthBrace === 0 && depthBracket === 0) { parts.push(current); current = ""; continue; }
      current += body[j];
    }
    parts.push(current);

    const positional = parts.find((part) => !/^\s*[\p{L}\w ]+\s*=/u.test(part));
    if (positional) found.push({ text: clean(positional), source: null });
    i = end;
  }
  return found;
}

/**
 * English Wikiquote holds quotes as "* quote" bullets, with the citation on the
 * "** …" line beneath — which is where the source comes from.
 */
function extractBulletQuotes(wikitext, skip) {
  const found = [];
  let section = "";
  const lines = wikitext.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith("==")) { section = line.replace(/=/g, "").trim(); continue; }
    if (skip.test(section)) continue;
    if (!/^\*\s*[^*]/.test(line)) continue;

    const text = clean(line.replace(/^\*\s*/, ""));
    // The nested bullet under it is the citation. Keep it short — these run to
    // whole publication histories, and a card wants a title, not a footnote.
    const next = lines[i + 1] ?? "";
    let source = null;
    if (/^\*\*\s*[^*]/.test(next)) {
      const cited = clean(next.replace(/^\*\*\s*/, ""));
      source = cited;
    }
    found.push({ text, source });
  }
  return found;
}

async function fetchWikitext(lang, titles) {
  const url = new URL(`https://${lang}.wikiquote.org/w/api.php`);
  url.search = new URLSearchParams({
    action: "query", format: "json", prop: "revisions", rvprop: "content",
    rvslots: "main", redirects: "1", titles: titles.join("|")
  }).toString();

  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!response.ok) throw new Error(`Wikiquote replied ${response.status} for ${titles.join(", ")}`);
  const data = await response.json();

  const pages = new Map();
  for (const page of Object.values(data.query?.pages ?? {})) {
    const content = page.revisions?.[0]?.slots?.main?.["*"];
    if (content) pages.set(page.title, content);
  }
  return pages;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const titles = args.pageFile
    ? (await fs.readFile(args.pageFile, "utf8")).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
    : args.pages;
  if (titles.length === 0) throw new Error("Give at least one --pages title or a --page-file");

  const skip = SKIP_SECTIONS[args.lang] ?? SKIP_SECTIONS.en;

  // Russian Wikiquote mostly uses {{Q|…}} templates, but not always — some pages
  // are plain bullet lists like the English edition, and the template extractor
  // finds nothing at all on those. Fall back rather than reporting the page as
  // empty: "→ 0" on a page that clearly has quotes is the tool being wrong, not
  // the page being bare.
  const extract = args.lang === "ru"
    ? (wikitext, skipRe) => {
        const templated = extractTemplateQuotes(wikitext, skipRe);
        return templated.length > 0 ? templated : extractBulletQuotes(wikitext, skipRe);
      }
    : extractBulletQuotes;

  const quotes = [];
  const seen = new Set();
  let rejected = 0;

  // Kept per author rather than in one list, so --total can interleave them.
  const byAuthor = [];

  for (let i = 0; i < titles.length; i += BATCH_SIZE) {
    const batch = titles.slice(i, i + BATCH_SIZE);
    const pages = await fetchWikitext(args.lang, batch);
    for (const [title, wikitext] of pages) {
      // "Чехов, Антон Павлович" → "Антон Павлович Чехов"; leave the rest alone.
      const author = /^[^,]+,\s+.+$/.test(title)
        ? title.split(/,\s+/).reverse().join(" ")
        : title;

      const mine = [];
      for (const candidate of extract(wikitext, skip)) {
        if (mine.length >= args.limit) break;
        const text = candidate.text;
        if (!isUsable(text, args.maxLength)) { rejected += 1; continue; }
        const key = `${text.toLowerCase()}|${author.toLowerCase()}`;
        if (seen.has(key)) { rejected += 1; continue; }
        seen.add(key);
        mine.push({
          text,
          author,
          ...(usableSource(candidate.source) ? { source: usableSource(candidate.source) } : {}),
          ...(args.tags.length ? { tags: args.tags } : {})
        });
      }
      byAuthor.push({ title, quotes: mine });
      console.log(`  ${title} → ${mine.length}`);
    }
  }

  // Round-robin, so a --total of 100 across fifteen authors is a spread rather
  // than the first three authors and nothing else. Wikiquote lists the
  // best-known quotes near the top of a page, so taking one from each in turn
  // also takes the most famous ones first.
  const deepest = Math.max(0, ...byAuthor.map((entry) => entry.quotes.length));
  for (let rank = 0; rank < deepest; rank += 1) {
    for (const entry of byAuthor) {
      if (entry.quotes[rank]) quotes.push(entry.quotes[rank]);
    }
  }
  const total = args.total > 0 ? quotes.splice(args.total) : [];
  if (total.length > 0) console.log(`\n  (${total.length} beyond --total ${args.total} left out)`);

  const pack = {
    version: 1,
    defaults: { language: args.lang, visibility: "family", inRotation: true },
    quotes
  };
  await fs.writeFile(args.out, `${JSON.stringify(pack, null, 2)}\n`, "utf8");
  console.log(`\n${quotes.length} quotes → ${args.out}  (${rejected} candidates rejected)`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
