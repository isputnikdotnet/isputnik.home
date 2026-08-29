// Optional online enrichment, gated by the "online_metadata" scan source.
// Fills metadata the local sources couldn't provide — narrator, description,
// cover art (LibriVox / Open Library) — and author photos & bios (Wikipedia /
// Open Library). Lookups only ever fill gaps; they never overwrite local or
// manual data.
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { db } from "../../../db.js";
import { thumbnailAbsolutePath, thumbnailStorageKey } from "../shared/thumbnail.js";
import { downloadImage, REMOTE_FETCH_USER_AGENT } from "../shared/remote-image.js";
import { normalizeLibrarySettings } from "../shared/library-settings.js";
import { fetchLibrivoxById, resolveArchiveCoverUrl, searchLibrivox, searchLibrivoxByAuthor } from "./providers/librivox.js";
import { searchOpenLibrary } from "./providers/open-library.js";
import { MetadataLinkError, type MetadataCandidate } from "./providers/types.js";

const REQUEST_TIMEOUT_MS = 12_000;
// Open Library's per-author record is regularly the slowest thing in a person
// lookup — 10s and sometimes a hard failure, measured. It only adds a biography
// to a card that already stands without one, so it gets a short budget of its
// own rather than holding the whole shortlist at the wall.
const OPEN_LIBRARY_DETAIL_TIMEOUT_MS = 5_000;
// Pause between consecutive online lookups, shared across the whole process so
// concurrent scan workers can't hammer the public APIs.
const POLITENESS_DELAY_MS = 250;
// Failed person lookups are retried, but not on every scan.
const PERSON_RETRY_DAYS = 30;
const MAX_AUTHORS_PER_RUN = 100;

let onlineQueue: Promise<unknown> = Promise.resolve();

function enqueueLookup<T>(task: () => Promise<T>): Promise<T> {
  const run = onlineQueue.then(async () => {
    try {
      return await task();
    } finally {
      await new Promise((resolve) => setTimeout(resolve, POLITENESS_DELAY_MS));
    }
  });
  onlineQueue = run.catch(() => {});
  return run;
}

async function fetchJson<T>(url: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T | null> {
  const response = await fetch(url, {
    headers: { "user-agent": REMOTE_FETCH_USER_AGENT, accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    return null;
  }
  return await response.json() as T;
}

// ── Matching ─────────────────────────────────────────────────────────────────

function normalizeText(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/^(the|a|an)\s+/, "")
    .trim();
}

// Folder titles often carry rip noise: "Pride and Prejudice (version 2) [64kbps]".
function simplifyTitle(value: string) {
  return value
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleScore(local: string, candidate: string) {
  const a = normalizeText(local);
  const b = normalizeText(candidate);
  if (!a || !b) return 0;
  if (a === b) return 3;
  if ((a.includes(b) || b.includes(a)) && Math.min(a.length, b.length) >= 4) return 2;
  const aTokens = new Set(a.split(" "));
  const bTokens = new Set(b.split(" "));
  const shared = [...aTokens].filter((token) => bTokens.has(token)).length;
  const union = new Set([...aTokens, ...bTokens]).size;
  return union > 0 && shared / union >= 0.6 ? 1 : 0;
}

// True when any name token of length ≥ 3 is shared — tolerates "Twain Mark"
// vs "Mark Twain" and initials-vs-full-name differences.
function authorsOverlap(localAuthors: string[], candidateAuthors: string[]) {
  const localTokens = new Set(
    localAuthors.flatMap((name) => normalizeText(name).split(" ")).filter((token) => token.length >= 3)
  );
  return candidateAuthors.some((name) =>
    normalizeText(name).split(" ").some((token) => token.length >= 3 && localTokens.has(token))
  );
}

function pickCandidate(candidates: MetadataCandidate[], title: string, authors: string[]) {
  let best: { candidate: MetadataCandidate; score: number } | null = null;
  for (const candidate of candidates) {
    const score = Math.max(titleScore(title, candidate.title), titleScore(simplifyTitle(title), candidate.title));
    if (score === 0) continue;
    if (authors.length > 0 && candidate.authors.length > 0 && !authorsOverlap(authors, candidate.authors)) continue;
    // With no local author to verify against, demand a strong title match.
    if (authors.length === 0 && score < 2) continue;
    if (!best || score > best.score) {
      best = { candidate, score };
    }
  }
  return best?.candidate ?? null;
}

// ── Book lookup ──────────────────────────────────────────────────────────────

export interface OnlineBookLookupInput {
  title: string;
  authors: string[];
  needCover: boolean;
}

async function lookupLibrivox(input: OnlineBookLookupInput): Promise<MetadataCandidate | null> {
  // searchLibrivox already retries with noise-stripped/article-stripped titles.
  const candidates = await searchLibrivox({ query: input.title, limit: 10 }).catch(() => []);
  const titleMatch = pickCandidate(candidates, input.title, input.authors);
  if (titleMatch) {
    return titleMatch;
  }

  // Exact-title search missed — list the author's catalogue (two pages max)
  // and score titles locally. Slim records; refetch the winner in full.
  const surname = input.authors
    .map((name) => normalizeText(name).split(" ").filter((token) => token.length >= 3).pop())
    .find(Boolean);
  if (!surname) {
    return null;
  }
  for (const offset of [0, 50]) {
    const page = await searchLibrivoxByAuthor(surname, offset).catch(() => []);
    const match = pickCandidate(page, input.title, input.authors);
    if (match?.librivoxId) {
      return await fetchLibrivoxById(match.librivoxId).catch(() => null) ?? match;
    }
    if (match || page.length < 50) {
      return match;
    }
  }
  return null;
}

export async function lookupOnlineBookMetadata(input: OnlineBookLookupInput): Promise<MetadataCandidate | null> {
  return enqueueLookup(async () => {
    // LibriVox first: it is the only source that knows the narrator, and these
    // libraries are mostly LibriVox rips.
    const librivoxMatch = await lookupLibrivox(input);
    if (librivoxMatch) {
      if (input.needCover && librivoxMatch.archiveId) {
        librivoxMatch.coverUrl = await resolveArchiveCoverUrl(librivoxMatch.archiveId) ?? librivoxMatch.coverUrl;
      }
      return librivoxMatch;
    }

    const candidates = await searchOpenLibrary({
      query: simplifyTitle(input.title),
      author: input.authors[0],
      limit: 8
    }).catch(() => []);
    return pickCandidate(candidates, input.title, input.authors);
  });
}

// ── Life facts ───────────────────────────────────────────────────────────────

// The short line that sits above a biography: born, died, country of origin,
// and what this person did. Wikidata answers the first three exactly and in a
// language-independent way; the occupation is the Wikipedia page's own one-line
// description ("English writer and humorist"), which is already localized and
// costs nothing extra to read. Every field is optional, every one is editable
// afterwards, and nothing here ever replaces a value someone typed.
export interface PersonFacts {
  // Partial dates — 'YYYY' | 'YYYY-MM' | 'YYYY-MM-DD', the convention the
  // people table shares with the family tree.
  birthDate: string | null;
  deathDate: string | null;
  country: string | null;
  occupation: string | null;
  wikidataId: string | null;
  wikipediaUrl: string | null;
}

export const EMPTY_PERSON_FACTS: PersonFacts = {
  birthDate: null,
  deathDate: null,
  country: null,
  occupation: null,
  wikidataId: null,
  wikipediaUrl: null
};

// The people columns each fact writes to, in one place: enrichPerson fills them
// and the profile routes read them back. wikidataId is missing on purpose — it
// is how a lookup finds the item it is reading, not something the table keeps.
export const PERSON_FACT_COLUMNS: Array<[keyof PersonFacts, string]> = [
  ["birthDate", "birth_date"],
  ["deathDate", "death_date"],
  ["country", "country"],
  ["occupation", "occupation"],
  ["wikipediaUrl", "wikipedia_url"]
];

const MONTH_NAMES = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december"
];

// "September", "Sep", "sept." → "09". Three letters is enough to be unambiguous
// in English, the only language these sources spell months in.
function monthNumber(word: string): string | null {
  const wanted = word.toLowerCase().replace(/\.$/, "");
  if (wanted.length < 3) return null;
  const index = MONTH_NAMES.findIndex((month) => month.startsWith(wanted.slice(0, 3)));
  return index < 0 ? null : String(index + 1).padStart(2, "0");
}

// Assemble a partial date, dropping any part that doesn't hold up: an
// impossible month leaves the year, an impossible day leaves the month. The
// result always satisfies the YYYY[-MM[-DD]] shape the profile route validates.
function partialDate(year: string, month?: string | null, day?: string | null): string | null {
  if (!/^\d{4}$/.test(year)) return null;
  const monthNo = month == null ? NaN : Number(month);
  if (!Number.isInteger(monthNo) || monthNo < 1 || monthNo > 12) return year;
  const mm = String(monthNo).padStart(2, "0");
  const dayNo = day == null ? NaN : Number(day);
  const daysInMonth = new Date(Date.UTC(Number(year), monthNo, 0)).getUTCDate();
  if (!Number.isInteger(dayNo) || dayNo < 1 || dayNo > daysInMonth) return `${year}-${mm}`;
  return `${year}-${mm}-${String(dayNo).padStart(2, "0")}`;
}

// Sources spell dates however they like — one Open Library field returns
// "2 September 1952", "1952", and "1899?". Everything lands as a partial ISO
// date or as nothing; a value that can only be read as a year becomes the year,
// which is what the person page shows anyway.
export function normalizePartialDate(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;

  const iso = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/.exec(value);
  if (iso) return partialDate(iso[1], iso[2], iso[3]);

  const dayFirst = /^(\d{1,2})\s+([A-Za-z.]+),?\s+(\d{4})$/.exec(value);
  if (dayFirst) return partialDate(dayFirst[3], monthNumber(dayFirst[2]), dayFirst[1]);

  const monthFirst = /^([A-Za-z.]+)\s+(\d{1,2}),?\s+(\d{4})$/.exec(value);
  if (monthFirst) return partialDate(monthFirst[3], monthNumber(monthFirst[1]), monthFirst[2]);

  const monthYear = /^([A-Za-z.]+)\s+(\d{4})$/.exec(value);
  if (monthYear) return partialDate(monthYear[2], monthNumber(monthYear[1]));

  // "c. 1849", "1899?", "born 1920" — the year is still worth keeping.
  const year = /(?:^|\D)(1\d{3}|20\d{2})(?:\D|$)/.exec(value);
  return year ? year[1] : null;
}

// Wikidata property ids. P31 answers "is this item a person at all" — the guard
// the candidate list has always had — and the rest are the facts themselves.
const WIKIDATA_INSTANCE_OF = "P31";
const WIKIDATA_HUMAN = "Q5";
const WIKIDATA_BIRTH = "P569";
const WIKIDATA_DEATH = "P570";
const WIKIDATA_CITIZENSHIP = "P27";

interface WikidataStatement {
  rank?: string;
  value?: { type?: string; content?: unknown };
}

// One property per request, deliberately: the REST endpoint filtered to a single
// property answers in about a kilobyte, where the same item's full statement set
// is ~190KB (measured on Q42, Q34660, Q7245). Three or four small requests in
// parallel beat one enormous one, and a scan enriching a hundred authors would
// feel the difference.
async function wikidataStatements(qid: string, property: string): Promise<WikidataStatement[] | null> {
  const body = await fetchJson<Record<string, WikidataStatement[]>>(
    `https://www.wikidata.org/w/rest.php/wikibase/v1/entities/items/${encodeURIComponent(qid)}/statements`
    + `?property=${property}`
  ).catch(() => null);
  if (!body) return null;
  const claims = body[property];
  return Array.isArray(claims) ? claims : [];
}

// Wikidata records contested facts as several statements: a "deprecated" one is
// known to be wrong, and a "preferred" one is the value to show.
function bestStatement(claims: WikidataStatement[]): WikidataStatement | null {
  const usable = claims.filter((claim) => claim.rank !== "deprecated" && claim.value?.type === "value");
  return usable.find((claim) => claim.rank === "preferred") ?? usable[0] ?? null;
}

// Wikidata times carry their own precision: 11 is a day, 10 a month, 9 a year,
// anything coarser a decade or worse. A year-precision time still arrives as
// "+1952-00-00T00:00:00Z", so partialDate's own checks would degrade it even
// without the precision — this reads it anyway, because a day-precision time
// that genuinely falls on 1 January must not be trimmed to a year. BCE dates
// have no place in the YYYY convention, so a classical author gets no dates
// rather than a wrong one.
function wikidataDate(claims: WikidataStatement[] | null): string | null {
  const claim = claims ? bestStatement(claims) : null;
  const content = claim?.value?.content as { time?: string; precision?: number } | undefined;
  const parsed = typeof content?.time === "string" ? /^\+(\d{4})-(\d{2})-(\d{2})T/.exec(content.time) : null;
  if (!parsed) return null;
  const [, year, month, day] = parsed;
  const precision = content?.precision ?? 11;
  if (precision >= 11) return partialDate(year, month, day);
  if (precision === 10) return partialDate(year, month);
  if (precision === 9) return partialDate(year);
  return null;
}

function wikidataItemIds(claims: WikidataStatement[] | null): string[] {
  return (claims ?? [])
    .filter((claim) => claim.rank !== "deprecated")
    .map((claim) => claim.value?.content)
    .filter((content): content is string => typeof content === "string" && /^Q\d+$/.test(content));
}

export interface WikidataPersonFacts {
  // null means "couldn't tell" — a network failure must not hide a real person,
  // so callers keep anything this can't answer for.
  human: boolean | null;
  birthDate: string | null;
  deathDate: string | null;
  countryIds: string[];
}

const NO_WIKIDATA_FACTS: WikidataPersonFacts = {
  human: null, birthDate: null, deathDate: null, countryIds: []
};

// Answered items, kept for the life of the process — the same author is looked
// up again every time the dialog is reopened, and the same item answers for a
// page in two languages. Only a COMPLETE read is stored: a request Wikidata
// declined returns null rather than an empty claim list, and remembering that
// as "no dates" would make one rate-limited moment permanent.
const wikidataFactsCache = new Map<string, WikidataPersonFacts>();

// askHuman is false wherever a person already chose the page (a pasted link) or
// the occupation guard has already run: the P31 request only earns its place
// when a machine is picking between same-name results.
//
// One property per await, never in parallel. Four concurrent requests for the
// same item came back partly answered — a lookup for Jane Austen returned her
// birth date but no death date and no country, both of which Wikidata plainly
// holds (measured) — and a dropped answer is indistinguishable from "Wikidata
// doesn't know", so the fact just goes quietly missing. Serial is also what
// Wikimedia asks of anonymous clients.
async function fetchWikidataFacts(qid: string, askHuman: boolean): Promise<WikidataPersonFacts> {
  const cached = wikidataFactsCache.get(qid);
  if (cached) return cached;

  // The guard goes first and alone. A name search turns up the books ABOUT an
  // author as much as the author, and an item that isn't a person is about to
  // be dropped — asking it for a birthday as well would spend three quarters of
  // this function's requests on exactly the results nobody can use.
  const instanceOf = askHuman ? await wikidataStatements(qid, WIKIDATA_INSTANCE_OF) : null;
  const human = instanceOf === null ? null : instanceOf.some((claim) => claim.value?.content === WIKIDATA_HUMAN);
  if (human === false) {
    const facts = { ...NO_WIKIDATA_FACTS, human };
    wikidataFactsCache.set(qid, facts);
    return facts;
  }

  const birth = await wikidataStatements(qid, WIKIDATA_BIRTH);
  const death = await wikidataStatements(qid, WIKIDATA_DEATH);
  const citizenship = await wikidataStatements(qid, WIKIDATA_CITIZENSHIP);
  const facts = {
    human,
    birthDate: wikidataDate(birth),
    deathDate: wikidataDate(death),
    // Two is the whole of the "country of origin" story anyone wants to read; a
    // much-travelled author can carry a dozen citizenships.
    countryIds: wikidataItemIds(citizenship).slice(0, 2)
  };
  // Every property answered — including the guard, when it was asked — so this
  // is what Wikidata actually holds and is worth not asking twice.
  if (birth && death && citizenship && (!askHuman || instanceOf)) {
    wikidataFactsCache.set(qid, facts);
  }
  return facts;
}

// Country labels repeat relentlessly — a family's library draws its authors
// from a handful of countries — so each item is asked about once per process
// rather than once per person. This is also the main defence against Wikidata's
// anonymous rate limit: the country is the one fact that needs a second request
// to become readable, so it is the first thing a 429 costs, and a scan over a
// hundred authors should make a handful of label requests rather than a hundred.
// A null caches "no label in these languages"; a FAILED request caches nothing,
// so a rate-limited lookup is retried rather than remembered as an answer.
const labelCache = new Map<string, string | null>();

// Labels for the country items above — one batched request, answered in the
// first library language that has a label and falling back to English. Free
// text is what gets stored, so this is the whole of a country's localization.
async function wikidataLabels(qids: string[], languages: string[]): Promise<Map<string, string>> {
  const langs = wikiLanguages(languages);
  const cacheKey = (qid: string) => `${qid}|${langs.join(",")}`;

  const labels = new Map<string, string>();
  const missing: string[] = [];
  for (const qid of new Set(qids)) {
    const cached = labelCache.get(cacheKey(qid));
    if (cached === undefined) missing.push(qid);
    else if (cached !== null) labels.set(qid, cached);
  }
  if (missing.length === 0) return labels;

  const ids = missing.slice(0, 50);
  const body = await fetchJson<{ entities?: Record<string, { labels?: Record<string, { value?: string }> }> }>(
    "https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=labels"
    + `&languages=${langs.join("|")}&ids=${ids.join("|")}`
  ).catch(() => null);
  if (!body?.entities) return labels;

  for (const qid of ids) {
    const entityLabels = body.entities[qid]?.labels;
    const value = langs.map((lang) => entityLabels?.[lang]?.value?.trim()).find(Boolean) ?? null;
    labelCache.set(cacheKey(qid), value);
    if (value) labels.set(qid, value);
  }
  return labels;
}

function joinCountries(ids: string[], labels: Map<string, string>): string | null {
  const names = ids.map((id) => labels.get(id)).filter((name): name is string => Boolean(name));
  return names.length > 0 ? names.join(", ") : null;
}

// Wikipedia's short description regularly ends with the very years that sit
// beside it once the dates land — "English novelist (1775–1817)" reading as
// "English novelist (1775–1817) · 1775 – 1817" on the page. Drop a trailing
// parenthetical that is nothing but dates; anything with a word in it stays.
export function trimYearRange(description: string): string {
  // Letters only where they spell a date qualifier — "born", "died", "c.",
  // "b. 1952", "BC". Anything else in the parenthetical keeps it: "(pen name of
  // Eric Blair)" is the description, not a repeat of the dates beside it.
  return description
    .replace(/\s*\((?:born|died|circa|fl\.?|BCE?|AD|[0-9]|[\s.,–—-]|[bcdr])+\)\s*$/i, "")
    .trim();
}

// Everything a Wikipedia page says about a person on its own, before Wikidata
// is asked: the one-line description, and where the facts came from.
function wikipediaFacts(summary: WikipediaSummary, pageUrl: string | null): PersonFacts {
  const description = summary.description?.trim();
  return {
    ...EMPTY_PERSON_FACTS,
    occupation: description ? trimYearRange(description) || null : null,
    wikidataId: summary.wikibase_item ?? null,
    wikipediaUrl: pageUrl
  };
}

// Fill a fact set's birth/death/country from its own Wikidata item, when it
// named one. Failures leave the facts exactly as they came in: an unreachable
// Wikidata must not cost a page its biography.
async function withWikidataFacts(facts: PersonFacts, languages: string[], askHuman = false): Promise<PersonFacts> {
  if (!facts.wikidataId) return facts;
  const wikidata = await fetchWikidataFacts(facts.wikidataId, askHuman).catch(() => null);
  if (!wikidata) return facts;
  const labels = await wikidataLabels(wikidata.countryIds, languages).catch(() => new Map<string, string>());
  return {
    ...facts,
    birthDate: wikidata.birthDate,
    deathDate: wikidata.deathDate,
    country: joinCountries(wikidata.countryIds, labels)
  };
}

// ── Person lookup (photo + bio) ──────────────────────────────────────────────

export interface PersonLookupResult {
  bio: string | null;
  photoUrl: string | null;
  source: "wikipedia" | "openlibrary";
  sourceUrl: string | null;
  facts: PersonFacts;
}

interface WikipediaSummary {
  type?: string;
  titles?: { normalized?: string };
  wikibase_item?: string;
  description?: string;
  extract?: string;
  thumbnail?: { source?: string };
  originalimage?: { source?: string };
  content_urls?: { desktop?: { page?: string } };
}

// Guard against same-name pages about unrelated people (athletes, musicians…).
// Applied to English pages, where descriptions are predictable.
//
// The second line is for NARRATORS, who are mostly actors and were mostly being
// rejected: measured on real pages, Simon Vance ("British audiobook narrator"),
// Scott Brick and Kate Reading all passed on "narrator", but Jim Dale ("British
// actor, singer, songwriter") and Bahni Turpin ("American actor") did not, so
// the automatic lookup silently skipped them. Widening this admits a few more
// same-name strangers, which is the right trade for a library that is half
// read aloud by actors — and the guard still rejects the Joe Barrett who is an
// "Irish sportsperson" rather than the one who narrates.
const OCCUPATION_PATTERN = new RegExp(
  "\\b(author|writer|novelist|poet|playwright|essayist|journalist|philosopher|historian|biographer|"
  + "dramatist|naturalist|theologian|critic|scholar|translator|cleric|clergyman|preacher|economist|"
  + "scientist|physicist|psychologist|mathematician|statesman|emperor|narrator|humorist|satirist|"
  + "storyteller|lexicographer|polymath|fabulist|"
  + "actor|actress|performer|broadcaster|presenter|voice artist|voice-over)\\b", "i"
);

// Does this page read like it is about someone a library credits — a writer or
// the actor who read them aloud? Exported so a test can pin the real
// descriptions this has to accept and the ones it must keep rejecting.
export function looksLikeContributor(text: string): boolean {
  return OCCUPATION_PATTERN.test(text);
}

async function lookupWikipediaPerson(name: string, lang: string, languages: string[]): Promise<PersonLookupResult | null> {
  const title = encodeURIComponent(name.trim().replace(/\s+/g, "_"));
  const summary = await fetchJson<WikipediaSummary>(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${title}`);
  if (!summary || summary.type !== "standard" || !summary.extract) {
    return null;
  }
  if (lang === "en" && !looksLikeContributor(`${summary.description ?? ""} ${summary.extract.slice(0, 240)}`)) {
    return null;
  }
  const pageUrl = summary.content_urls?.desktop?.page ?? null;
  return {
    bio: summary.extract,
    photoUrl: summary.thumbnail?.source ?? summary.originalimage?.source ?? null,
    source: "wikipedia",
    sourceUrl: pageUrl,
    // The guard above has already accepted this page, so no P31 question is
    // asked here — this is only about the dates and the country.
    facts: await withWikidataFacts(wikipediaFacts(summary, pageUrl), languages)
  };
}

interface OpenLibraryAuthorSearch {
  docs?: Array<{
    key?: string;
    name?: string;
    top_work?: string;
    birth_date?: string;
    death_date?: string;
    work_count?: number;
  }>;
}

async function lookupOpenLibraryPerson(name: string): Promise<PersonLookupResult | null> {
  const search = await fetchJson<OpenLibraryAuthorSearch>(
    `https://openlibrary.org/search/authors.json?q=${encodeURIComponent(name)}&limit=5`
  );
  const wanted = normalizeText(name);
  const doc = (search?.docs ?? []).find((entry) => entry.key && entry.name && normalizeText(entry.name) === wanted);
  if (!doc?.key) {
    return null;
  }
  const olid = doc.key.replace(/^\/authors\//, "");
  const detail = await fetchJson<{ bio?: string | { value?: string } }>(
    `https://openlibrary.org/authors/${encodeURIComponent(olid)}.json`
  );
  const bio = typeof detail?.bio === "string" ? detail.bio : detail?.bio?.value ?? null;
  return {
    bio: bio?.trim() || null,
    // 404s (instead of a placeholder) when the author has no photo.
    photoUrl: `https://covers.openlibrary.org/a/olid/${olid}-L.jpg?default=false`,
    source: "openlibrary",
    sourceUrl: `https://openlibrary.org/authors/${olid}`,
    // Open Library has no country and no occupation to give; the dates it does
    // have arrive as prose ("2 September 1952") and are normalized on the way in.
    facts: {
      ...EMPTY_PERSON_FACTS,
      birthDate: normalizePartialDate(doc.birth_date),
      deathDate: normalizePartialDate(doc.death_date)
    }
  };
}

function wikiLanguages(languages: string[]) {
  return Array.from(new Set(
    [...languages, "en"].map((lang) => lang.trim().toLowerCase()).filter((lang) => /^[a-z]{2,3}$/.test(lang))
  ));
}

export async function lookupPersonInfo(name: string, languages: string[]): Promise<PersonLookupResult | null> {
  return enqueueLookup(async () => {
    for (const lang of wikiLanguages(languages)) {
      const result = await lookupWikipediaPerson(name, lang, languages).catch(() => null);
      if (result) {
        return result;
      }
    }
    return await lookupOpenLibraryPerson(name).catch(() => null);
  });
}

// ── Person candidates (the Find Info picker) ─────────────────────────────────

// Everything the picker needs to tell two same-name matches apart BEFORE
// applying either — which is why this sits next to lookupPersonInfo rather than
// replacing it: the scanner wants one confident answer, a person at the dialog
// wants the shortlist that answer was chosen from.
// Only the things that tell two same-name results apart. The facts a result can
// actually contribute to a profile live on `facts` (see PersonLookupResult),
// which this inherits — birth and death dates are facts, not trivia.
export interface PersonCandidateDetails {
  language?: string;
  pageTitle?: string;
  topWork?: string;
  workCount?: number;
  olid?: string;
}

export interface PersonLookupCandidate extends PersonLookupResult {
  // Stable within one response — the list's React key and selection handle.
  id: string;
  title: string;
  description: string | null;
  details: PersonCandidateDetails;
}

interface WikipediaSearchResponse {
  pages?: Array<{ key?: string; title?: string; description?: string | null }>;
}

// A Wikipedia candidate carries the Wikidata id its summary reported, which is
// what answers "is this page even about a person?" — see isHumanEntity.
interface WikiCandidate {
  candidate: PersonLookupCandidate;
  qid: string | null;
}

// At most this many Wikipedia pages per language, and this many results in all —
// every extra page costs a summary request, and a list longer than a screen
// stops being a shortlist.
const MAX_WIKI_PAGES_PER_LANGUAGE = 3;
const MAX_PERSON_CANDIDATES = 8;

// The one line a result card shows when the page carried no short description.
function candidateSnippet(bio: string | null): string | null {
  if (!bio) return null;
  const line = bio.replace(/\s+/g, " ").trim();
  if (!line) return null;
  return line.length <= 190 ? line : `${line.slice(0, 189).replace(/\s+\S*$/, "")}…`;
}

function wikipediaSummaryUrl(lang: string, key: string) {
  return `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(key)}`;
}

// A search for an author's name also turns up the books ABOUT them and the ideas
// named after them ("Ayn Rand: The Russian Radical", "Objectivism") — the one
// kind of wrong result a person cannot use at all. fetchWikidataFacts answers
// "is this a human" (P31) in the same breath as the dates and the country, so
// the guard costs one request rather than a round of its own.

// Every Wikipedia page worth offering for a name, in one language: the
// exact-title page first (the usual hit), then whatever the site search adds.
// No occupation guard here — a same-name athlete is a visible, rejectable entry
// in a list, where the automatic lookup had to drop it silently because nobody
// was there to say no. Pages that aren't about a PERSON are dropped later, by
// isHumanEntity.
async function wikipediaCandidates(name: string, lang: string): Promise<WikiCandidate[]> {
  const search = await fetchJson<WikipediaSearchResponse>(
    `https://${lang}.wikipedia.org/w/rest.php/v1/search/page?q=${encodeURIComponent(name)}&limit=5`
  ).catch(() => null);

  const keys: string[] = [];
  const searchKeys = (search?.pages ?? []).map((page) => page.key).filter((key): key is string => Boolean(key));
  for (const key of [name.trim().replace(/\s+/g, "_"), ...searchKeys]) {
    if (keys.length >= MAX_WIKI_PAGES_PER_LANGUAGE) break;
    if (!keys.some((seen) => seen.toLowerCase() === key.toLowerCase())) keys.push(key);
  }

  const summaries = await Promise.all(
    keys.map((key) => fetchJson<WikipediaSummary>(wikipediaSummaryUrl(lang, key)).catch(() => null))
  );

  return summaries.flatMap((summary, index) => {
    if (!summary || summary.type !== "standard" || !summary.extract) return [];
    const title = summary.titles?.normalized ?? keys[index].replace(/_/g, " ");
    return [{
      qid: summary.wikibase_item ?? null,
      candidate: {
        id: `wikipedia:${lang}:${keys[index]}`,
        title,
        description: summary.description ?? candidateSnippet(summary.extract),
        bio: summary.extract,
        photoUrl: summary.thumbnail?.source ?? summary.originalimage?.source ?? null,
        source: "wikipedia" as const,
        sourceUrl: summary.content_urls?.desktop?.page ?? null,
        facts: wikipediaFacts(summary, summary.content_urls?.desktop?.page ?? null),
        details: { language: lang, pageTitle: title }
      }
    }];
  });
}

// Open Library author records sharing the exact name — the same rule the photo
// picker uses, because a looser match there returns another person's books.
async function openLibraryCandidates(name: string): Promise<PersonLookupCandidate[]> {
  const search = await fetchJson<OpenLibraryAuthorSearch>(
    `https://openlibrary.org/search/authors.json?q=${encodeURIComponent(name)}&limit=10`
  ).catch(() => null);
  const wanted = normalizeText(name);
  const docs = (search?.docs ?? [])
    .filter((doc) => doc.key && doc.name && normalizeText(doc.name) === wanted)
    .slice(0, 3);

  const details = await Promise.all(docs.map((doc) =>
    fetchJson<{ bio?: string | { value?: string } }>(
      `https://openlibrary.org/authors/${encodeURIComponent(doc.key!.replace(/^\/authors\//, ""))}.json`,
      OPEN_LIBRARY_DETAIL_TIMEOUT_MS
    ).catch(() => null)
  ));

  return docs.map((doc, index) => {
    const olid = doc.key!.replace(/^\/authors\//, "");
    const raw = details[index]?.bio;
    const bio = (typeof raw === "string" ? raw : raw?.value ?? null)?.trim() || null;
    const years = [doc.birth_date, doc.death_date].filter(Boolean).join(" – ");
    return {
      id: `openlibrary:${olid}`,
      title: doc.name!,
      description: doc.top_work
        ? `${doc.top_work}${years ? ` (${years})` : ""}`
        : years || candidateSnippet(bio),
      bio,
      // 404s (instead of a placeholder) when the record has no photo; the
      // picker drops a candidate photo whose image fails to load.
      photoUrl: `https://covers.openlibrary.org/a/olid/${olid}-L.jpg?default=false`,
      source: "openlibrary" as const,
      sourceUrl: `https://openlibrary.org/authors/${olid}`,
      facts: {
        ...EMPTY_PERSON_FACTS,
        birthDate: normalizePartialDate(doc.birth_date),
        deathDate: normalizePartialDate(doc.death_date)
      },
      details: {
        olid,
        topWork: doc.top_work,
        workCount: doc.work_count
      }
    };
  });
}

// What belongs at the top: the page actually named after this person, in the
// language their library speaks, that reads like a page about a writer. The
// user still chooses — this only decides who gets read first.
function candidateScore(candidate: PersonLookupCandidate, name: string, languages: string[]) {
  let score = 0;
  if (normalizeText(candidate.title) === normalizeText(name)) score += 4;
  if (looksLikeContributor(`${candidate.description ?? ""} ${candidate.bio?.slice(0, 240) ?? ""}`)) score += 3;
  if (candidate.photoUrl) score += 1;
  const langIndex = candidate.details.language ? languages.indexOf(candidate.details.language) : -1;
  if (langIndex === 0) score += 2;
  else if (langIndex > 0) score += 1;
  return score;
}

// Which of the two person sources to ask. "all" is the default and what almost
// everyone wants; narrowing is for when a name turns up noise from one of them.
export type PersonLookupSource = "all" | "wikipedia" | "openlibrary";

export async function lookupPersonCandidates(
  name: string,
  languages: string[],
  source: PersonLookupSource = "all"
): Promise<PersonLookupCandidate[]> {
  return enqueueLookup(async () => {
    const langs = wikiLanguages(languages);
    const [wikiGroups, openLibrary] = await Promise.all([
      source === "openlibrary"
        ? Promise.resolve([] as WikiCandidate[][])
        : Promise.all(langs.map((lang) => wikipediaCandidates(name, lang).catch(() => [] as WikiCandidate[]))),
      source === "wikipedia"
        ? Promise.resolve([] as PersonLookupCandidate[])
        : openLibraryCandidates(name).catch(() => [] as PersonLookupCandidate[])
    ]);
    const wiki = wikiGroups.flat();

    // One round of questions per Wikidata item, not per page: the same article
    // in two languages shares an id, so a bilingual library asks once.
    const factsByQid = new Map<string, WikidataPersonFacts>();
    for (const qid of new Set(wiki.map((entry) => entry.qid).filter((qid): qid is string => Boolean(qid)))) {
      factsByQid.set(qid, await fetchWikidataFacts(qid, true).catch(() => null) ?? NO_WIKIDATA_FACTS);
    }
    // Every country named across the whole shortlist, resolved to labels in one
    // request rather than one per result.
    const countryLabels = await wikidataLabels(
      [...factsByQid.values()].flatMap((facts) => facts.countryIds),
      langs
    ).catch(() => new Map<string, string>());

    // Different-language wikis routinely resolve to one article, and a repeated
    // result reads as two separate findings.
    const seen = new Set<string>();
    const unique = [
      ...wiki
        .filter((entry) => entry.qid === null || factsByQid.get(entry.qid)?.human !== false)
        .map((entry) => {
          const wikidata = entry.qid ? factsByQid.get(entry.qid) : null;
          if (!wikidata) return entry.candidate;
          return {
            ...entry.candidate,
            facts: {
              ...entry.candidate.facts,
              birthDate: wikidata.birthDate,
              deathDate: wikidata.deathDate,
              country: joinCountries(wikidata.countryIds, countryLabels)
            }
          };
        }),
      ...openLibrary
    ].filter((candidate) => {
      if (!candidate.bio && !candidate.photoUrl) return false;
      const key = candidate.sourceUrl ?? candidate.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return unique
      .map((candidate, index) => ({ candidate, index, score: candidateScore(candidate, name, langs) }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, MAX_PERSON_CANDIDATES)
      .map((entry) => entry.candidate);
  });
}

// Resolve a single pasted person link to a bio + photo. Only the two person
// sources are accepted (a deliberate boundary, mirroring the book custom-link
// allowlist). Unlike the auto lookup, no occupation guard is applied — an
// explicit link is a trusted choice.
export async function lookupPersonByUrl(rawUrl: string): Promise<PersonLookupCandidate | null> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new MetadataLinkError("Enter a valid link (including https://).");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new MetadataLinkError("Only http(s) links are supported.");
  }
  const host = url.hostname.toLowerCase();

  return enqueueLookup(async () => {
    if (host === "wikipedia.org" || host.endsWith(".wikipedia.org")) {
      const lang = host.replace(/\.wikipedia\.org$/, "").split(".")[0] || "en";
      const title = url.pathname.match(/\/wiki\/(.+)$/)?.[1];
      if (!title) {
        throw new MetadataLinkError("That doesn't look like a Wikipedia article link.");
      }
      const summary = await fetchJson<WikipediaSummary>(
        `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(decodeURIComponent(title))}`
      );
      if (!summary || summary.type !== "standard" || !summary.extract) {
        return null;
      }
      const pageTitle = summary.titles?.normalized ?? decodeURIComponent(title).replace(/_/g, " ");
      return {
        id: `wikipedia:${lang}:${title}`,
        title: pageTitle,
        description: summary.description ?? candidateSnippet(summary.extract),
        bio: summary.extract,
        photoUrl: summary.originalimage?.source ?? summary.thumbnail?.source ?? null,
        source: "wikipedia",
        sourceUrl: summary.content_urls?.desktop?.page ?? url.href,
        facts: await withWikidataFacts(
          wikipediaFacts(summary, summary.content_urls?.desktop?.page ?? url.href),
          [lang]
        ),
        details: { language: lang, pageTitle }
      };
    }

    if (host === "openlibrary.org" || host === "www.openlibrary.org") {
      const olid = url.pathname.match(/\/authors\/(OL\w+)/i)?.[1];
      if (!olid) {
        throw new MetadataLinkError("That doesn't look like an Open Library author link.");
      }
      const detail = await fetchJson<{
        name?: string;
        bio?: string | { value?: string };
        birth_date?: string;
        death_date?: string;
      }>(`https://openlibrary.org/authors/${olid}.json`);
      if (!detail) {
        return null;
      }
      const bio = (typeof detail.bio === "string" ? detail.bio : detail.bio?.value ?? null)?.trim() || null;
      return {
        id: `openlibrary:${olid}`,
        title: detail.name ?? olid,
        description: candidateSnippet(bio),
        bio,
        // 404s (rather than a placeholder) when the author has no photo; the UI
        // drops it on image-load error.
        photoUrl: `https://covers.openlibrary.org/a/olid/${olid}-L.jpg?default=false`,
        source: "openlibrary",
        sourceUrl: `https://openlibrary.org/authors/${olid}`,
        facts: {
          ...EMPTY_PERSON_FACTS,
          birthDate: normalizePartialDate(detail.birth_date),
          deathDate: normalizePartialDate(detail.death_date)
        },
        details: { olid }
      };
    }

    throw new MetadataLinkError("Paste a Wikipedia or Open Library author link.");
  });
}

// One photo per source the user can pick from — Wikipedia page image per
// language, plus Open Library author records sharing the exact name. No
// occupation guard here: a human is choosing, and the hint text (page
// description / top work) is what disambiguates same-name people.
export interface PersonPhotoCandidate {
  // Full-quality image to apply.
  photoUrl: string;
  // Smaller image for the picker grid (thumbnail when available).
  previewUrl: string;
  label: string;
  hint: string | null;
  sourceUrl: string | null;
}

export async function lookupPersonPhotoCandidates(name: string, languages: string[]): Promise<PersonPhotoCandidate[]> {
  return enqueueLookup(async () => {
    const candidates: PersonPhotoCandidate[] = [];

    for (const lang of wikiLanguages(languages)) {
      const title = encodeURIComponent(name.trim().replace(/\s+/g, "_"));
      const summary = await fetchJson<WikipediaSummary>(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${title}`)
        .catch(() => null);
      const photoUrl = summary?.originalimage?.source ?? summary?.thumbnail?.source;
      if (summary?.type === "standard" && photoUrl) {
        candidates.push({
          photoUrl,
          previewUrl: summary.thumbnail?.source ?? photoUrl,
          label: `Wikipedia (${lang})`,
          hint: summary.description ?? null,
          sourceUrl: summary.content_urls?.desktop?.page ?? null
        });
      }
    }

    const search = await fetchJson<OpenLibraryAuthorSearch>(
      `https://openlibrary.org/search/authors.json?q=${encodeURIComponent(name)}&limit=10`
    ).catch(() => null);
    const wanted = normalizeText(name);
    const matchingDocs = (search?.docs ?? [])
      .filter((doc) => doc.key && doc.name && normalizeText(doc.name) === wanted)
      .slice(0, 3);
    for (const doc of matchingDocs) {
      const olid = doc.key!.replace(/^\/authors\//, "");
      const years = [doc.birth_date, doc.death_date].filter(Boolean).join(" – ");
      candidates.push({
        // 404s (instead of a placeholder) when this record has no photo; the
        // picker drops candidates whose image fails to load.
        photoUrl: `https://covers.openlibrary.org/a/olid/${olid}-L.jpg?default=false`,
        previewUrl: `https://covers.openlibrary.org/a/olid/${olid}-M.jpg?default=false`,
        label: "Open Library",
        hint: doc.top_work ? `${doc.top_work}${years ? ` (${years})` : ""}` : years || null,
        sourceUrl: `https://openlibrary.org/authors/${olid}`
      });
    }

    // Different language wikis frequently share one Commons image.
    const seen = new Set<string>();
    return candidates.filter((candidate) => {
      if (seen.has(candidate.photoUrl)) return false;
      seen.add(candidate.photoUrl);
      return true;
    });
  });
}

// ── Author enrichment pass ───────────────────────────────────────────────────

interface AuthorToEnrich {
  id: string;
  name: string;
  bio: string | null;
  cover_storage_key: string | null;
}

export async function writePersonPhoto(authorId: string, photoUrl: string) {
  const buffer = await downloadImage(photoUrl);
  // Versioned file name: photo URLs are cached by the browser, so replacing a
  // photo must produce a new URL to show up immediately.
  const storageKey = thumbnailStorageKey("people", authorId, `${authorId}-photo-${Date.now()}.webp`);
  const absolutePath = thumbnailAbsolutePath(storageKey);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  await sharp(buffer).resize(512, 512, { fit: "inside", withoutEnlargement: true }).webp({ quality: 85 }).toFile(absolutePath);
  return storageKey;
}

// Best-effort removal of replaced photo files.
export function removeStoredPhotos(storageKeys: Array<string | null | undefined>) {
  for (const key of new Set(storageKeys.filter((key): key is string => Boolean(key)))) {
    try {
      fs.unlinkSync(thumbnailAbsolutePath(key));
    } catch {
      // already gone or unreadable — nothing to clean
    }
  }
}

function bioWithAttribution(result: PersonLookupResult) {
  if (!result.bio) {
    return null;
  }
  const source = result.source === "wikipedia" ? "Wikipedia" : "Open Library";
  return `${result.bio}\n\nSource: ${source}${result.sourceUrl ? ` — ${result.sourceUrl}` : ""}`;
}

// Fills bio/photo/life facts for one person. People are identified by name
// across libraries (same model as the people routes), so updates apply by name
// and only to rows where the field is still empty.
export async function enrichPerson(name: string, languages: string[]): Promise<{ updatedBio: boolean; updatedPhoto: boolean; updatedFacts: boolean; result: PersonLookupResult | null }> {
  const rows = db.prepare(
    "SELECT id, name, bio, image_storage_key AS cover_storage_key FROM people WHERE name = ?"
  ).all(name) as AuthorToEnrich[];
  if (rows.length === 0) {
    return { updatedBio: false, updatedPhoto: false, updatedFacts: false, result: null };
  }

  const needsBio = rows.some((row) => !row.bio);
  const needsPhoto = rows.some((row) => !row.cover_storage_key);
  const result = await lookupPersonInfo(name, languages);
  db.prepare("UPDATE people SET enriched_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE name = ?").run(name);
  if (!result) {
    return { updatedBio: false, updatedPhoto: false, updatedFacts: false, result: null };
  }

  let updatedBio = false;
  const bio = bioWithAttribution(result);
  if (needsBio && bio) {
    db.prepare("UPDATE people SET bio = ? WHERE name = ? AND (bio IS NULL OR bio = '')").run(bio, name);
    updatedBio = true;
  }

  let updatedPhoto = false;
  if (needsPhoto && result.photoUrl) {
    try {
      const storageKey = await writePersonPhoto(rows[0].id, result.photoUrl);
      db.prepare("UPDATE people SET image_storage_key = ? WHERE name = ? AND image_storage_key IS NULL").run(storageKey, name);
      updatedPhoto = true;
    } catch {
      // no photo is fine — the bio may still have landed
    }
  }

  // Life facts land one column at a time, and only into a column that is still
  // empty: a hand-typed birth year survives every later rescan, and a lookup
  // that only knows the dates doesn't blank out a country someone filled in.
  let updatedFacts = false;
  for (const [key, column] of PERSON_FACT_COLUMNS) {
    const value = result.facts[key];
    if (!value) continue;
    const changed = db.prepare(
      `UPDATE people SET ${column} = ? WHERE name = ? AND (${column} IS NULL OR ${column} = '')`
    ).run(value, name).changes;
    if (changed > 0) updatedFacts = true;
  }

  return { updatedBio, updatedPhoto, updatedFacts, result };
}

export interface EnrichAuthorsOptions {
  // Restrict to the people credited on one book (single-book rescan).
  bookId?: string;
  limit?: number;
  shouldCancel?: () => boolean;
  onProgress?: (processed: number, total: number) => void;
}

export async function enrichLibraryAuthors(libraryId: string, options: EnrichAuthorsOptions = {}) {
  const library = db.prepare("SELECT settings_json FROM libraries WHERE id = ?").get(libraryId) as { settings_json: string } | undefined;
  const defaultLanguage = library ? normalizeLibrarySettings("audiobook", library.settings_json).default_language ?? "en" : "en";

  const rows = db.prepare(`
    SELECT people.name
    FROM people
    JOIN item_people ON item_people.person_id = people.id
    JOIN library_items ON library_items.id = item_people.item_id
    WHERE library_items.library_id = ?
      ${options.bookId ? "AND item_people.item_id = ?" : ""}
      AND (people.bio IS NULL OR people.image_storage_key IS NULL OR people.birth_date IS NULL)
      AND (people.enriched_at IS NULL OR datetime(people.enriched_at) < datetime('now', ?))
    GROUP BY people.id
    ORDER BY people.enriched_at IS NOT NULL, people.name
    LIMIT ?
  `).all(
    ...(options.bookId ? [libraryId, options.bookId] : [libraryId]),
    `-${PERSON_RETRY_DAYS} days`,
    options.limit ?? MAX_AUTHORS_PER_RUN
  ) as { name: string }[];

  const names = Array.from(new Set(rows.map((row) => row.name)));
  let updated = 0;
  let processed = 0;

  for (const name of names) {
    if (options.shouldCancel?.()) {
      break;
    }
    try {
      const result = await enrichPerson(name, [defaultLanguage]);
      if (result.updatedBio || result.updatedPhoto || result.updatedFacts) {
        updated += 1;
      }
    } catch {
      // one bad lookup must not stop the pass
    }
    processed += 1;
    if (processed % 5 === 0 || processed === names.length) {
      options.onProgress?.(processed, names.length);
    }
  }

  return { attempted: names.length, updated };
}
