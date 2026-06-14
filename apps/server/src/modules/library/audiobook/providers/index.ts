import { fetchFantlabByUrl, searchFantlab } from "./fantlab.js";
import { fetchItunesByUrl, searchItunes } from "./itunes.js";
import { fetchLibrivoxByUrl, searchLibrivox } from "./librivox.js";
import { fetchOpenLibraryByUrl, searchOpenLibrary } from "./open-library.js";
import { MetadataLinkError, type MetadataCandidate, type MetadataProvider, type MetadataSearchInput } from "./types.js";

export type { MetadataCandidate, MetadataProvider } from "./types.js";
export { MetadataLinkError } from "./types.js";

export async function searchMetadataProvider(provider: MetadataProvider, input: MetadataSearchInput) {
  if (provider === "itunes") {
    return searchItunes(input);
  }
  if (provider === "openlibrary") {
    return searchOpenLibrary(input);
  }
  if (provider === "librivox") {
    return searchLibrivox(input);
  }
  return searchFantlab(input);
}

export async function searchAllMetadataProviders(input: MetadataSearchInput): Promise<MetadataCandidate[]> {
  const results = await Promise.allSettled([
    searchItunes(input),
    searchOpenLibrary(input),
    searchFantlab(input),
    searchLibrivox(input)
  ]);
  return results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
}

// Resolve a single pasted book link to candidate(s). Only a fixed allowlist of
// public provider hosts is fetched (a deliberate SSRF boundary for a
// self-hosted app); each host is parsed by that provider's by-URL function.
export async function fetchMetadataFromUrl(rawUrl: string): Promise<MetadataCandidate[]> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new MetadataLinkError("Enter a valid link (including https://).");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new MetadataLinkError("Only http(s) links are supported.");
  }

  const host = url.hostname.replace(/^www\./i, "").toLowerCase();
  if (host === "openlibrary.org") {
    return fetchOpenLibraryByUrl(rawUrl);
  }
  if (host === "books.apple.com" || host === "itunes.apple.com" || host === "music.apple.com") {
    return fetchItunesByUrl(rawUrl);
  }
  if (host === "fantlab.ru") {
    return fetchFantlabByUrl(rawUrl);
  }
  if (host === "librivox.org") {
    return fetchLibrivoxByUrl(rawUrl);
  }
  throw new MetadataLinkError("Unsupported site. Paste a link from Open Library, Apple Books, FantLab, or LibriVox.");
}
