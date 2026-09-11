import { fetchJson } from "../lookup-shared.js";
import {
  EMPTY_PERSON_FACTS,
  candidateSnippet,
  type PersonFacts,
  type PersonLookupCandidate,
  type PersonLookupResult
} from "../person-facts.js";
import { withWikidataFacts } from "./wikidata.js";

// Wikipedia's short description regularly ends with the very years that sit
// beside it once the dates land — "English novelist (1775–1817)" reading as
// "English novelist (1775–1817) · 1775 – 1817" on the page. Drop a trailing
// parenthetical that is nothing but dates; anything with a word in it stays.
export function trimYearRange(description: string): string {
  // Take the trailing parenthetical whole, then judge its contents separately.
  // Deciding both at once needs one alternation of overlapping date fragments
  // (born|…|BCE?|…|[bcdr]), and a repeated overlapping alternation backtracks
  // exponentially when the closing ")" never arrives: "(bcbcbc…" at sixty
  // characters wedged the event loop for minutes (js/redos, alert #254). The
  // description comes from a Wikipedia page, which anyone can edit.
  const parenthetical = /\(([^()]*)\)\s*$/.exec(description);
  if (!parenthetical) {
    return description.trim();
  }

  // Letters only where they spell a date qualifier — "born", "died", "c.",
  // "b. 1952", "BC". Anything else in the parenthetical keeps it: "(pen name of
  // Eric Blair)" is the description, not a repeat of the dates beside it. Words
  // first, then a single character class over what is left: both passes are
  // linear, with nothing for a backtracker to explore.
  const remainder = parenthetical[1].replace(/born|died|circa|fl\.?|bce?|ad/gi, " ");
  if (!/^[0-9\s.,–—bcdr-]+$/i.test(remainder)) {
    return description.trim();
  }

  return description.slice(0, parenthetical.index).trim();
}

// Everything a Wikipedia page says about a person on its own, before Wikidata
// is asked: the one-line description, and where the facts came from.
export function wikipediaFacts(summary: WikipediaSummary, pageUrl: string | null): PersonFacts {
  const description = summary.description?.trim();
  return {
    ...EMPTY_PERSON_FACTS,
    occupation: description ? trimYearRange(description) || null : null,
    wikidataId: summary.wikibase_item ?? null,
    wikipediaUrl: pageUrl
  };
}

export interface WikipediaSummary {
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

export async function lookupWikipediaPerson(name: string, lang: string, languages: string[]): Promise<PersonLookupResult | null> {
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

interface WikipediaSearchResponse {
  pages?: Array<{ key?: string; title?: string; description?: string | null }>;
}

// A Wikipedia candidate carries the Wikidata id its summary reported, which is
// what answers "is this page even about a person?" — see isHumanEntity.
export interface WikiCandidate {
  candidate: PersonLookupCandidate;
  qid: string | null;
}

// At most this many Wikipedia pages per language, and this many results in all —
// every extra page costs a summary request, and a list longer than a screen
// stops being a shortlist.
const MAX_WIKI_PAGES_PER_LANGUAGE = 3;

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
export async function wikipediaCandidates(name: string, lang: string): Promise<WikiCandidate[]> {
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
