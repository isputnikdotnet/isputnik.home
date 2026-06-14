import { fetchTextFromUrl } from "../../shared/remote-image.js";
import { MetadataLinkError, type MetadataCandidate, type MetadataSearchInput } from "./types.js";

interface OpenLibraryResponse {
  docs?: Array<{
    title?: string;
    author_name?: string[];
    first_publish_year?: number;
    publisher?: string[];
    isbn?: string[];
    language?: string[];
    subject?: string[];
    cover_i?: number;
    key?: string;
  }>;
}

// Shape of a single work (/works/OL…W.json) or edition (/books/OL…M.json) record.
// Works nest authors as { author: { key } }; editions use { key } directly.
interface OpenLibraryRecord {
  title?: string;
  description?: string | { value?: string };
  covers?: number[];
  subjects?: string[];
  publishers?: string[];
  publish_date?: string;
  isbn_13?: string[];
  isbn_10?: string[];
  languages?: Array<{ key?: string }>;
  authors?: Array<{ key?: string; author?: { key?: string } }>;
}

export async function searchOpenLibrary(input: MetadataSearchInput): Promise<MetadataCandidate[]> {
  const params = new URLSearchParams({
    q: [input.query, input.author].filter(Boolean).join(" "),
    limit: String(input.limit ?? 8),
    fields: "title,author_name,first_publish_year,publisher,isbn,language,subject,cover_i,key"
  });
  const response = await fetch(`https://openlibrary.org/search.json?${params}`);
  if (!response.ok) {
    throw new Error("Open Library search failed.");
  }

  const payload = await response.json() as OpenLibraryResponse;
  return (payload.docs ?? [])
    .filter((doc) => doc.title)
    .map((doc) => ({
      title: doc.title!,
      authors: doc.author_name ?? [],
      publisher: doc.publisher?.[0],
      year: doc.first_publish_year,
      coverUrl: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg` : undefined,
      isbn: doc.isbn?.[0],
      genres: doc.subject?.slice(0, 8) ?? [],
      language: doc.language?.[0],
      source: "openlibrary" as const
    }));
}

async function openLibraryJson<T>(path: string): Promise<T> {
  return JSON.parse(await fetchTextFromUrl(`https://openlibrary.org${path}`, { accept: "application/json" })) as T;
}

// Author keys ("/authors/OL…A") only carry the name in their own record; fetch a
// few in parallel, best-effort (a failed author lookup just drops that name).
async function resolveAuthorNames(keys: string[]): Promise<string[]> {
  const names = await Promise.all(keys.slice(0, 3).map(async (key) => {
    try {
      const author = await openLibraryJson<{ name?: string }>(`${key}.json`);
      return author.name?.trim() || null;
    } catch {
      return null;
    }
  }));
  return names.filter((name): name is string => Boolean(name));
}

export async function fetchOpenLibraryByUrl(url: string): Promise<MetadataCandidate[]> {
  const match = new URL(url).pathname.match(/\/(works|books)\/(OL\w+)/i);
  if (!match) {
    throw new MetadataLinkError("That doesn't look like an Open Library book or work link.");
  }

  const record = await openLibraryJson<OpenLibraryRecord>(`/${match[1].toLowerCase()}/${match[2]}.json`);
  if (!record.title?.trim()) {
    throw new MetadataLinkError("That Open Library record has no title.");
  }

  const authorKeys = (record.authors ?? [])
    .map((entry) => entry.author?.key ?? entry.key)
    .filter((key): key is string => Boolean(key));
  const description = typeof record.description === "string" ? record.description : record.description?.value;
  const coverId = record.covers?.find((id) => id > 0);
  const year = record.publish_date?.match(/\d{4}/)?.[0];

  return [{
    title: record.title.trim(),
    authors: await resolveAuthorNames(authorKeys),
    publisher: record.publishers?.[0],
    year: year ? Number(year) : undefined,
    description: description?.trim() || undefined,
    coverUrl: coverId ? `https://covers.openlibrary.org/b/id/${coverId}-L.jpg` : undefined,
    isbn: record.isbn_13?.[0] ?? record.isbn_10?.[0],
    genres: record.subjects?.slice(0, 8) ?? [],
    language: record.languages?.[0]?.key?.replace("/languages/", ""),
    source: "openlibrary"
  }];
}
