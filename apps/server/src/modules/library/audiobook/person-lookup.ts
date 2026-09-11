// Looking a person up: the one confident answer a scan wants (lookupPersonInfo),
// the shortlist the Find Info picker offers, a pasted link, and photo choices.
import { MetadataLinkError } from "./providers/types.js";
import { enqueueLookup, fetchJson, normalizeText } from "./lookup-shared.js";
import {
  candidateSnippet,
  EMPTY_PERSON_FACTS,
  normalizePartialDate,
  type PersonLookupCandidate,
  type PersonLookupResult
} from "./person-facts.js";
import {
  fetchWikidataFacts,
  joinCountries,
  NO_WIKIDATA_FACTS,
  wikiLanguages,
  wikidataLabels,
  withWikidataFacts,
  type WikidataPersonFacts
} from "./providers/wikidata.js";
import {
  looksLikeContributor,
  lookupWikipediaPerson,
  wikipediaCandidates,
  wikipediaFacts,
  type WikiCandidate,
  type WikipediaSummary
} from "./providers/wikipedia.js";
import { lookupOpenLibraryPerson, openLibraryCandidates, type OpenLibraryAuthorSearch } from "./providers/open-library-people.js";
import { fantlabPersonCandidates, fantlabRecordCandidate, type FantlabPersonKind } from "./providers/fantlab-people.js";

// ── Person lookup (photo + bio) ──────────────────────────────────────────────

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

const MAX_PERSON_CANDIDATES = 8;

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

// Which person source to ask. "all" is the default and what almost everyone
// wants; narrowing is for when a name turns up noise from one of them.
export type PersonLookupSource = "all" | "wikipedia" | "openlibrary" | "fantlab";

export async function lookupPersonCandidates(
  name: string,
  languages: string[],
  source: PersonLookupSource = "all"
): Promise<PersonLookupCandidate[]> {
  return enqueueLookup(async () => {
    const langs = wikiLanguages(languages);
    const asked = (which: PersonLookupSource) => source === "all" || source === which;
    const [wikiGroups, openLibrary, fantlab] = await Promise.all([
      asked("wikipedia")
        ? Promise.all(langs.map((lang) => wikipediaCandidates(name, lang).catch(() => [] as WikiCandidate[])))
        : Promise.resolve([] as WikiCandidate[][]),
      asked("openlibrary")
        ? openLibraryCandidates(name).catch(() => [] as PersonLookupCandidate[])
        : Promise.resolve([] as PersonLookupCandidate[]),
      asked("fantlab")
        ? fantlabPersonCandidates(name).catch(() => [] as PersonLookupCandidate[])
        : Promise.resolve([] as PersonLookupCandidate[])
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
      ...openLibrary,
      ...fantlab
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

    if (host === "fantlab.ru" || host === "www.fantlab.ru") {
      // A writer's page and a narrator's page are different entities there.
      const person = url.pathname.match(/^\/(autor|dictor)(\d+)/i);
      if (!person) {
        throw new MetadataLinkError("That doesn't look like a FantLab person link (expected fantlab.ru/autorNNNN or /dictorNNNN).");
      }
      return fantlabRecordCandidate(person[1].toLowerCase() as FantlabPersonKind, Number(person[2]));
    }

    throw new MetadataLinkError("Paste a Wikipedia, Open Library, or FantLab person link.");
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

    // FantLab portraits: the only source with a picture of most Russian authors.
    for (const candidate of await fantlabPersonCandidates(name).catch(() => [])) {
      if (candidate.photoUrl) {
        candidates.push({
          photoUrl: candidate.photoUrl,
          previewUrl: candidate.photoUrl,
          label: "FantLab",
          hint: candidate.description,
          sourceUrl: candidate.sourceUrl
        });
      }
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
