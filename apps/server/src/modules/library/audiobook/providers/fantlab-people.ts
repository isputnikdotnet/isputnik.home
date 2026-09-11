import { fetchJson, normalizeText } from "../lookup-shared.js";
import {
  EMPTY_PERSON_FACTS,
  candidateSnippet,
  normalizePartialDate,
  type PersonLookupCandidate
} from "../person-facts.js";

// ── FantLab people ───────────────────────────────────────────────────────────
// The Russian-language source. Wikipedia and Open Library between them know
// almost nothing about the authors a Russian shelf is full of — and nothing at
// all about its narrators — while what they do know is in English. FantLab's
// records carry the biography, the dates, the country, and a portrait, all in
// Russian.
//
// Writers and narrators are separate entities there, each with its own search,
// its own record endpoint, and its own page (fantlab.ru/autor1073 vs
// /dictor2061), so a name is looked up as both and whichever answers wins.

const FANTLAB_SITE = "https://fantlab.ru";
const FANTLAB_API = "https://api.fantlab.ru";
const FANTLAB_MAX_PEOPLE = 3;

// "autor" is FantLab's own spelling; "dictor" is its word for a narrator.
export type FantlabPersonKind = "autor" | "dictor";

interface FantlabAuthorMatch {
  autor_id?: number;
  rusname?: string;
  name?: string;
}

// search-persons is the index for everyone who isn't a writer — narrators,
// translators, cover artists — so the type has to be checked, not assumed.
interface FantlabPersonMatch {
  person_id?: number;
  name?: string;
  type?: string;
}

interface FantlabPersonRecord {
  id?: number;
  name?: string;
  name_orig?: string;
  anons?: string;
  birthday?: string | null;
  deathday?: string | null;
  // Author records name one country; narrator records list them.
  country_name?: string | null;
  countries?: Array<{ name?: string }>;
  image?: string | null;
  image_preview?: string | null;
}

// FantLab records a known day with an unknown year as "0000-09-06". That is a
// birthday, not a birth date, and the profile has nowhere to put it.
function fantlabDate(value: string | null | undefined) {
  return value && !value.startsWith("0000") ? normalizePartialDate(value) : null;
}

function fantlabImageUrl(path: string | null | undefined) {
  if (!path) return null;
  return path.startsWith("http") ? path : `${FANTLAB_SITE}${path}`;
}

// Biographies arrive as HTML with the odd inline link.
function fantlabText(value: string | null | undefined) {
  if (!value) return null;
  const text = value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, "\"")
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    // Ampersands last: unescaping them first turns a biography's literal
    // "&amp;lt;" into a "<" it never said (js/double-escaping, alert #255).
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text || null;
}

function fantlabCountry(record: FantlabPersonRecord) {
  const listed = record.countries?.map((entry) => entry.name?.trim()).filter(Boolean).join(", ");
  return record.country_name?.trim() || listed || null;
}

function fantlabCandidate(record: FantlabPersonRecord, kind: FantlabPersonKind, id: number): PersonLookupCandidate | null {
  const title = record.name?.trim();
  if (!title) return null;
  const bio = fantlabText(record.anons);
  const original = record.name_orig?.trim();
  return {
    id: `fantlab:${kind}:${id}`,
    title,
    // The Latin spelling is exactly what tells two same-name results apart here.
    description: original || candidateSnippet(bio),
    bio,
    photoUrl: fantlabImageUrl(record.image ?? record.image_preview),
    source: "fantlab" as const,
    sourceUrl: `${FANTLAB_SITE}/${kind}${id}`,
    facts: {
      ...EMPTY_PERSON_FACTS,
      birthDate: fantlabDate(record.birthday),
      deathDate: fantlabDate(record.deathday),
      country: fantlabCountry(record)
    },
    // Its pages are Russian, which is what puts them first for a Russian shelf
    // (see candidateScore).
    details: { language: "ru" }
  };
}

export async function fantlabRecordCandidate(kind: FantlabPersonKind, id: number) {
  const record = await fetchJson<FantlabPersonRecord>(`${FANTLAB_API}/${kind}/${id}`).catch(() => null);
  return record ? fantlabCandidate(record, kind, id) : null;
}

// Both searches are fuzzy enough to answer "Толстой" with every Tolstoy; keep
// the ones actually named what was asked for, the same rule Open Library gets.
function fantlabNamed(name: string) {
  const wanted = normalizeText(name);
  return (candidateName: string | undefined) => normalizeText(candidateName ?? "") === wanted;
}

async function fantlabAuthorIds(name: string): Promise<number[]> {
  const search = await fetchJson<{ matches?: FantlabAuthorMatch[] }>(
    `${FANTLAB_API}/search-autors?q=${encodeURIComponent(name)}&page=1`
  ).catch(() => null);
  const named = fantlabNamed(name);
  return (search?.matches ?? [])
    .filter((match) => match.autor_id && named(match.rusname || match.name))
    .map((match) => match.autor_id!)
    .slice(0, FANTLAB_MAX_PEOPLE);
}

// Narrators live in the search-persons index, which also holds translators and
// cover artists — everyone who isn't a writer. Only the narrators belong here:
// this app's people are authors and narrators, nothing else.
async function fantlabNarratorIds(name: string): Promise<number[]> {
  const search = await fetchJson<{ matches?: FantlabPersonMatch[] }>(
    `${FANTLAB_API}/search-persons?q=${encodeURIComponent(name)}`
  ).catch(() => null);
  const named = fantlabNamed(name);
  return (search?.matches ?? [])
    .filter((match) => match.person_id && match.type === "dictor" && named(match.name))
    .map((match) => match.person_id!)
    .slice(0, FANTLAB_MAX_PEOPLE);
}

// A name is looked up as both a writer and a narrator: the dialog doesn't know
// which role brought someone here (people are shared across roles), and asking
// both costs one extra search on a name only one of them will answer.
export async function fantlabPersonCandidates(name: string): Promise<PersonLookupCandidate[]> {
  const [authorIds, narratorIds] = await Promise.all([
    fantlabAuthorIds(name).catch(() => []),
    fantlabNarratorIds(name).catch(() => [])
  ]);
  const wanted: Array<[FantlabPersonKind, number]> = [
    ...authorIds.map((id): [FantlabPersonKind, number] => ["autor", id]),
    ...narratorIds.map((id): [FantlabPersonKind, number] => ["dictor", id])
  ];

  const candidates = await Promise.all(wanted.map(([kind, id]) => fantlabRecordCandidate(kind, id)));
  return candidates.filter((candidate): candidate is PersonLookupCandidate => candidate !== null);
}
