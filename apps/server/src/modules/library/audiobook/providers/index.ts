import { searchFantlab } from "./fantlab.js";
import { searchItunes } from "./itunes.js";
import { searchOpenLibrary } from "./open-library.js";
import type { MetadataCandidate, MetadataProvider, MetadataSearchInput } from "./types.js";

export type { MetadataCandidate, MetadataProvider } from "./types.js";

export async function searchMetadataProvider(provider: MetadataProvider, input: MetadataSearchInput) {
  if (provider === "itunes") {
    return searchItunes(input);
  }
  if (provider === "openlibrary") {
    return searchOpenLibrary(input);
  }
  return searchFantlab(input);
}

export async function searchAllMetadataProviders(input: MetadataSearchInput): Promise<MetadataCandidate[]> {
  const results = await Promise.allSettled([
    searchItunes(input),
    searchOpenLibrary(input),
    searchFantlab(input)
  ]);
  return results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
}
