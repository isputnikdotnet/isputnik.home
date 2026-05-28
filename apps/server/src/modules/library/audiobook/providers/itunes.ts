import type { MetadataCandidate, MetadataSearchInput } from "./types.js";

interface ItunesResponse {
  results?: Array<{
    collectionName?: string;
    trackName?: string;
    artistName?: string;
    primaryGenreName?: string;
    releaseDate?: string;
    description?: string;
    longDescription?: string;
    artworkUrl100?: string;
    collectionViewUrl?: string;
  }>;
}

function yearFromDate(value?: string) {
  const match = value?.match(/\d{4}/);
  return match ? Number(match[0]) : undefined;
}

function highResolutionCover(value?: string) {
  return value?.replace(/100x100bb\.(jpg|png)$/i, "600x600bb.$1");
}

export async function searchItunes(input: MetadataSearchInput): Promise<MetadataCandidate[]> {
  const params = new URLSearchParams({
    term: [input.query, input.author].filter(Boolean).join(" "),
    media: "audiobook",
    entity: "audiobook",
    limit: String(input.limit ?? 8)
  });
  const response = await fetch(`https://itunes.apple.com/search?${params}`);
  if (!response.ok) {
    throw new Error("iTunes search failed.");
  }

  const payload = await response.json() as ItunesResponse;
  return (payload.results ?? [])
    .filter((result) => result.collectionName || result.trackName)
    .map((result) => ({
      title: result.collectionName ?? result.trackName!,
      authors: result.artistName ? [result.artistName] : [],
      year: yearFromDate(result.releaseDate),
      description: result.longDescription ?? result.description,
      coverUrl: highResolutionCover(result.artworkUrl100),
      genres: result.primaryGenreName ? [result.primaryGenreName] : [],
      source: "itunes" as const
    }));
}
