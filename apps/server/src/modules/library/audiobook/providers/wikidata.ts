import { fetchJson } from "../lookup-shared.js";
import { partialDate, type PersonFacts } from "../person-facts.js";

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

export const NO_WIKIDATA_FACTS: WikidataPersonFacts = {
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
export async function fetchWikidataFacts(qid: string, askHuman: boolean): Promise<WikidataPersonFacts> {
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
export async function wikidataLabels(qids: string[], languages: string[]): Promise<Map<string, string>> {
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

export function joinCountries(ids: string[], labels: Map<string, string>): string | null {
  const names = ids.map((id) => labels.get(id)).filter((name): name is string => Boolean(name));
  return names.length > 0 ? names.join(", ") : null;
}

export function wikiLanguages(languages: string[]) {
  return Array.from(new Set(
    [...languages, "en"].map((lang) => lang.trim().toLowerCase()).filter((lang) => /^[a-z]{2,3}$/.test(lang))
  ));
}

// Fill a fact set's birth/death/country from its own Wikidata item, when it
// named one. Failures leave the facts exactly as they came in: an unreachable
// Wikidata must not cost a page its biography.
export async function withWikidataFacts(facts: PersonFacts, languages: string[], askHuman = false): Promise<PersonFacts> {
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
