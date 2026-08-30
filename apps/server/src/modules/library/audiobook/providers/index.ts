import { fetchAudibleByUrl, searchAudible } from "./audible.js";
import { fetchFantlabByUrl, searchFantlab } from "./fantlab.js";
import { fetchItunesByUrl, searchItunes } from "./itunes.js";
import { fetchLibrivoxByUrl, searchLibrivox } from "./librivox.js";
import { fetchOpenLibraryByUrl, searchOpenLibrary } from "./open-library.js";
import { rankByQueryRelevance } from "./relevance.js";
import { MetadataLinkError, type MetadataCandidate, type MetadataProvider, type MetadataSearchInput } from "./types.js";

export type { MetadataCandidate, MetadataProvider } from "./types.js";
export { MetadataLinkError } from "./types.js";

const DEFAULT_LIMIT = 8;

// The gate below throws results away, so ask the keyword providers for more
// than we intend to show — otherwise a page full of near-misses can push the
// real match past the limit and the search comes back empty. Only for the
// providers where an extra row is one extra row: LibriVox already matches
// titles exactly, and every FantLab hit costs a second request for its blurb.
const OVER_FETCH: Record<MetadataProvider, number> = {
  audible: 3, itunes: 3, openlibrary: 3, fantlab: 1, librivox: 1
};

async function searchRaw(provider: MetadataProvider, input: MetadataSearchInput) {
  const limit = (input.limit ?? DEFAULT_LIMIT) * OVER_FETCH[provider];
  return searchProvider(provider, { ...input, limit });
}

async function searchProvider(provider: MetadataProvider, input: MetadataSearchInput) {
  if (provider === "itunes") {
    return searchItunes(input);
  }
  if (provider === "openlibrary") {
    return searchOpenLibrary(input);
  }
  if (provider === "librivox") {
    return searchLibrivox(input);
  }
  if (provider === "audible") {
    return searchAudible(input);
  }
  return searchFantlab(input);
}

// Every interactive lookup goes through the relevance gate (see relevance.ts):
// providers answer keyword searches, so what comes back is "related to" the
// query, not "matching" it. The scan-time enrichment path calls the provider
// modules directly and scores its own matches against the local title instead.
export async function searchMetadataProvider(provider: MetadataProvider, input: MetadataSearchInput) {
  return rankByQueryRelevance(await searchRaw(provider, input), input).slice(0, input.limit ?? DEFAULT_LIMIT);
}

export async function searchAllMetadataProviders(input: MetadataSearchInput): Promise<MetadataCandidate[]> {
  const providers: MetadataProvider[] = ["audible", "itunes", "openlibrary", "fantlab", "librivox"];
  const results = await Promise.allSettled(providers.map((provider) => searchRaw(provider, input)));
  // Ranked across providers, so the closest titles lead regardless of source
  // rather than the list opening with all eight of Audible's.
  return rankByQueryRelevance(results.flatMap((result) => result.status === "fulfilled" ? result.value : []), input)
    .slice(0, (input.limit ?? DEFAULT_LIMIT) * 3);
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
  if (host.startsWith("audible.") || host.endsWith(".audible.com")) {
    return fetchAudibleByUrl(rawUrl);
  }
  throw new MetadataLinkError("Unsupported site. Paste a link from Audible, Open Library, Apple Books, FantLab, or LibriVox.");
}
