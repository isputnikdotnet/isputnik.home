import { fetchJson, normalizeText } from "../lookup-shared.js";
import {
  EMPTY_PERSON_FACTS,
  candidateSnippet,
  normalizePartialDate,
  type PersonLookupCandidate,
  type PersonLookupResult
} from "../person-facts.js";

// Open Library's per-author record is regularly the slowest thing in a person
// lookup — 10s and sometimes a hard failure, measured. It only adds a biography
// to a card that already stands without one, so it gets a short budget of its
// own rather than holding the whole shortlist at the wall.
const OPEN_LIBRARY_DETAIL_TIMEOUT_MS = 5_000;

export interface OpenLibraryAuthorSearch {
  docs?: Array<{
    key?: string;
    name?: string;
    top_work?: string;
    birth_date?: string;
    death_date?: string;
    work_count?: number;
  }>;
}

export async function lookupOpenLibraryPerson(name: string): Promise<PersonLookupResult | null> {
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

// Open Library author records sharing the exact name — the same rule the photo
// picker uses, because a looser match there returns another person's books.
export async function openLibraryCandidates(name: string): Promise<PersonLookupCandidate[]> {
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
