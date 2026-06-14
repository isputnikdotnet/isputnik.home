// LibriVox catalogue provider. Public-domain audiobooks ripped from
// librivox.org usually carry no narrator tag or cover art; the LibriVox API is
// the authoritative source for both (readers per section, archive.org item for
// cover art). https://librivox.org/api/info
import { REMOTE_FETCH_USER_AGENT } from "../../shared/remote-image.js";
import { MetadataLinkError, type MetadataCandidate, type MetadataSearchInput } from "./types.js";

const REQUEST_TIMEOUT_MS = 12_000;
const MAX_NARRATORS = 10;

interface LibrivoxBook {
  id?: string;
  title?: string;
  description?: string;
  language?: string;
  copyright_year?: string;
  url_iarchive?: string;
  totaltimesecs?: number;
  authors?: Array<{ first_name?: string; last_name?: string }>;
  genres?: Array<{ name?: string }>;
  sections?: Array<{ readers?: Array<{ display_name?: string }> }>;
}

interface LibrivoxResponse {
  books?: LibrivoxBook[];
  error?: string;
}

// LibriVox reports full language names; the rest of the app stores ISO-ish codes.
const LANGUAGE_CODES: Record<string, string> = {
  english: "en", russian: "ru", german: "de", french: "fr", spanish: "es",
  italian: "it", dutch: "nl", portuguese: "pt", polish: "pl", ukrainian: "uk",
  chinese: "zh", japanese: "ja", hebrew: "he", latin: "la", greek: "el",
  swedish: "sv", danish: "da", finnish: "fi", hungarian: "hu", czech: "cs"
};

function languageCode(value: string | undefined) {
  if (!value) return undefined;
  return LANGUAGE_CODES[value.trim().toLowerCase()] ?? value;
}

// Descriptions arrive as HTML ("<em>…</em><br />(Summary from Wikipedia)").
function stripHtml(value: string | undefined) {
  if (!value) return undefined;
  const text = value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text || undefined;
}

// Reader display names can carry annotations like "Kara Shallenberg (1969-2023)".
function cleanReaderName(value: string | undefined) {
  return (value ?? "").replace(/\s*\([^)]*\d[^)]*\)\s*$/, "").trim();
}

function narratorNames(book: LibrivoxBook) {
  const names: string[] = [];
  for (const section of book.sections ?? []) {
    for (const reader of section.readers ?? []) {
      const name = cleanReaderName(reader.display_name);
      if (name && !names.includes(name)) {
        names.push(name);
      }
    }
  }
  return names.slice(0, MAX_NARRATORS);
}

function authorNames(book: LibrivoxBook) {
  return (book.authors ?? [])
    .map((author) => [author.first_name, author.last_name].map((part) => part?.trim()).filter(Boolean).join(" "))
    .filter(Boolean);
}

export function archiveIdentifier(urlIarchive: string | undefined) {
  const match = (urlIarchive ?? "").match(/archive\.org\/details\/([^/?#]+)/i);
  return match ? match[1] : null;
}

async function librivoxFetch(params: URLSearchParams): Promise<LibrivoxBook[]> {
  const response = await fetch(`https://librivox.org/api/feed/audiobooks/?${params}`, {
    headers: { "user-agent": REMOTE_FETCH_USER_AGENT, accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) {
    throw new Error("LibriVox search failed.");
  }
  const payload = await response.json() as LibrivoxResponse;
  // "No books found" comes back as {"error": "..."} with HTTP 200.
  return Array.isArray(payload.books) ? payload.books : [];
}

function toCandidate(book: LibrivoxBook): MetadataCandidate | null {
  if (!book.title?.trim()) {
    return null;
  }
  const identifier = archiveIdentifier(book.url_iarchive);
  const year = Number(book.copyright_year);
  return {
    title: book.title.trim(),
    authors: authorNames(book),
    narrators: narratorNames(book),
    year: Number.isFinite(year) && year > 0 ? year : undefined,
    description: stripHtml(book.description),
    // Item tile thumbnail — always available without an extra request. Scan
    // enrichment upgrades it to the full-size cover via resolveArchiveCoverUrl.
    coverUrl: identifier ? `https://archive.org/services/img/${identifier}` : undefined,
    genres: (book.genres ?? []).map((genre) => genre.name?.trim()).filter((name): name is string => Boolean(name)),
    language: languageCode(book.language),
    archiveId: identifier ?? undefined,
    librivoxId: book.id,
    source: "librivox"
  };
}

function toCandidates(books: LibrivoxBook[]) {
  return books
    .map(toCandidate)
    .filter((candidate): candidate is MetadataCandidate => candidate !== null);
}

// The `title` parameter is an exact (case-insensitive) match — "The Adventures
// of Tom Sawyer" finds nothing because the catalogue title has no leading
// "The". Try the query as-is, then without bracketed rip noise, then without a
// leading article.
function titleQueryVariants(query: string) {
  const noNoise = query.replace(/\([^)]*\)/g, " ").replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
  const noArticle = (value: string) => value.replace(/^(the|a|an)\s+/i, "").trim();
  return Array.from(new Set([query.trim(), noArticle(query.trim()), noNoise, noArticle(noNoise)].filter(Boolean)));
}

export async function searchLibrivox(input: MetadataSearchInput): Promise<MetadataCandidate[]> {
  // The API can answer an individual variant with an error status (parentheses
  // in particular); a failed variant just falls through to the next one.
  let failures = 0;
  const variants = titleQueryVariants(input.query);
  for (const title of variants) {
    const params = new URLSearchParams({
      format: "json",
      extended: "1",
      limit: String(input.limit ?? 8),
      title
    });
    try {
      const books = await librivoxFetch(params);
      if (books.length > 0) {
        return toCandidates(books);
      }
    } catch {
      failures += 1;
    }
  }
  if (failures === variants.length) {
    throw new Error("LibriVox search failed.");
  }
  return [];
}

// A LibriVox book link (https://librivox.org/<slug>/). The catalogue page itself
// 403s automated clients, so instead of scraping we recover a title from the
// slug ("the-…-by-author" → title + author) and run it through the JSON search
// API, which is the same authoritative source the title search already uses.
export async function fetchLibrivoxByUrl(url: string): Promise<MetadataCandidate[]> {
  const slug = new URL(url).pathname.replace(/^\/+|\/+$/g, "");
  const splitAt = slug.lastIndexOf("-by-");
  const titleSlug = splitAt >= 0 ? slug.slice(0, splitAt) : slug;
  const query = titleSlug.replace(/[-_]+/g, " ").trim();
  if (!query) {
    throw new MetadataLinkError("That doesn't look like a LibriVox book link.");
  }
  return searchLibrivox({ query, limit: 8 });
}

// All books for an author surname. Slim records: no sections (narrators) and
// no archive link — follow up with fetchLibrivoxById on the chosen result.
export async function searchLibrivoxByAuthor(surname: string, offset = 0): Promise<MetadataCandidate[]> {
  const params = new URLSearchParams({
    format: "json",
    limit: "50",
    offset: String(offset),
    author: surname
  });
  return toCandidates(await librivoxFetch(params));
}

export async function fetchLibrivoxById(id: string): Promise<MetadataCandidate | null> {
  const params = new URLSearchParams({ format: "json", extended: "1", id });
  const books = await librivoxFetch(params);
  return toCandidates(books)[0] ?? null;
}

// The item tile from /services/img is ~180px. The real cover art is the item's
// JPEG file (derived thumbs, waveform PNGs, and spectrograms excluded), served
// from /download — which redirects to a mirror node, hence downloadImage's
// redirect support.
export async function resolveArchiveCoverUrl(identifier: string): Promise<string | null> {
  try {
    const response = await fetch(`https://archive.org/metadata/${encodeURIComponent(identifier)}/files`, {
      headers: { "user-agent": REMOTE_FETCH_USER_AGENT, accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (!response.ok) {
      return null;
    }
    const payload = await response.json() as { result?: Array<{ name?: string; format?: string; size?: string | number }> };
    const covers = (payload.result ?? [])
      .filter((file) => file.name && file.format === "JPEG" && !/(_thumb|__ia_thumb)\.jpe?g$/i.test(file.name))
      .sort((left, right) => Number(right.size ?? 0) - Number(left.size ?? 0));
    return covers[0]?.name
      ? `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeURIComponent(covers[0].name)}`
      : null;
  } catch {
    return null;
  }
}
