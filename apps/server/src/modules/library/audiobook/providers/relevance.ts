// Every provider behind the lookup dialog answers a keyword search, not an
// exact one: Audible, iTunes, Open Library and FantLab all return whatever is
// loosely related to the words sent — the rest of the series, a study guide
// about the book, an unrelated title that happens to share one word. Open
// Library's `q` even searches descriptions and subjects. The dialog then reads
// as "a lot of wrong titles".
//
// This gate is the contract the dialog promises: a candidate survives only when
// everything typed in the search box is actually present in the result itself
// (its title, subtitle, authors, or identifiers). Nothing about the book being
// edited widens the search — the query is the whole of it — so a lookup returns
// matches for what was typed and nothing else.
import type { MetadataCandidate, MetadataSearchInput } from "./types.js";

// Dropped from the required-token set: they carry no selectivity, and providers
// routinely omit or add them ("The Hobbit" vs "Hobbit").
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "in", "on", "at", "for", "to", "by", "with", "from",
  "и", "в", "во", "на", "с", "со", "у", "о", "об", "от", "до", "для", "из", "по", "не"
]);

// Lowercase, fold diacritics (and Cyrillic й/ё, which decompose the same way),
// then split on anything that isn't a letter or a digit. Single characters go:
// they are initials ("J. R. R. Tolkien") or noise, never a title's substance.
export function matchTokens(value: string): string[] {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter((token) => token.length > 1);
}

// Two tokens match when they are equal, or when one is the other's inflection:
// a shared prefix that leaves at most a couple of trailing characters
// ("толстой"/"толстого", "mir"/"mira", "cat"/"cats"). Deliberately loose enough
// for Russian case endings and English plurals, and no looser — "кот"/"код"
// share only two characters and stay apart.
function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const shortest = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < shortest && a[prefix] === b[prefix]) prefix += 1;
  return prefix >= 3 && prefix >= shortest - 1;
}

function containsToken(haystack: string[], token: string): boolean {
  return haystack.some((candidate) => tokensMatch(candidate, token));
}

// What the user asked for: the query plus an explicit author filter, if the
// caller passed one. Stopwords are dropped here only — they still count when
// comparing whole phrases below, so "The Hobbit" outranks "Hobbit".
function requiredTokens(input: MetadataSearchInput): string[] {
  const tokens = [...matchTokens(input.query), ...matchTokens(input.author ?? "")]
    .filter((token) => !STOPWORDS.has(token));
  return Array.from(new Set(tokens));
}

// Where a query token may be found. Identifiers are in here so pasting an ASIN
// or an ISBN into the box still works — that is a search for what was typed too.
function candidateTokens(candidate: MetadataCandidate): string[] {
  return matchTokens([
    candidate.title,
    candidate.subtitle ?? "",
    ...candidate.authors,
    candidate.asin ?? "",
    candidate.isbn ?? ""
  ].join(" "));
}

// Ordering among the survivors: the closer the title alone is to the query, the
// higher it sits. An exact title wins outright, a title that starts with the
// query (or that the query starts with) comes next, and a longer title that
// merely contains every word sinks — that is where series omnibuses and
// "… : A Study Guide" belong.
function relevanceScore(candidate: MetadataCandidate, required: string[], queryPhrase: string): number {
  const titleTokens = matchTokens(candidate.title);
  const titlePhrase = titleTokens.join(" ");
  let score = 0;
  if (titlePhrase === queryPhrase) {
    score += 100;
  } else if (titlePhrase.startsWith(queryPhrase) || queryPhrase.startsWith(titlePhrase)) {
    score += 50;
  } else if (titlePhrase.includes(queryPhrase)) {
    score += 30;
  }
  const inTitle = required.filter((token) => containsToken(titleTokens, token)).length;
  score += required.length > 0 ? (inTitle / required.length) * 20 : 0;
  // Each word of title beyond the query is one more thing the user didn't ask for.
  score -= Math.min(Math.max(titleTokens.length - required.length, 0), 10);
  return score;
}

// Drop every candidate that isn't a match for the query, then order the rest by
// how closely their title tracks it. An empty query (nothing to match against)
// passes everything through untouched.
export function rankByQueryRelevance<T extends MetadataCandidate>(candidates: T[], input: MetadataSearchInput): T[] {
  const required = requiredTokens(input);
  if (required.length === 0) {
    return candidates;
  }
  const queryPhrase = matchTokens(input.query).join(" ");
  return candidates
    .map((candidate, index) => ({ candidate, index, tokens: candidateTokens(candidate) }))
    .filter((entry) => required.every((token) => containsToken(entry.tokens, token)))
    .map((entry) => ({ ...entry, score: relevanceScore(entry.candidate, required, queryPhrase) }))
    // Stable within a score so each provider's own relevance order survives.
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((entry) => entry.candidate);
}
