// The shapes a person lookup hands back — life facts, a result, a picker
// candidate — and the date normalization every source's dates go through.

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
export function partialDate(year: string, month?: string | null, day?: string | null): string | null {
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

export interface PersonLookupResult {
  bio: string | null;
  photoUrl: string | null;
  source: "wikipedia" | "openlibrary" | "fantlab";
  sourceUrl: string | null;
  facts: PersonFacts;
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

// The one line a result card shows when the page carried no short description.
export function candidateSnippet(bio: string | null): string | null {
  if (!bio) return null;
  const line = bio.replace(/\s+/g, " ").trim();
  if (!line) return null;
  return line.length <= 190 ? line : `${line.slice(0, 189).replace(/\s+\S*$/, "")}…`;
}
