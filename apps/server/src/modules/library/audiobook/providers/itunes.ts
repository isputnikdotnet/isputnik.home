import { fetchTextFromUrl } from "../../shared/remote-image.js";
import { MetadataLinkError, type MetadataCandidate, type MetadataSearchInput } from "./types.js";

interface ItunesResult {
  collectionName?: string;
  trackName?: string;
  artistName?: string;
  primaryGenreName?: string;
  releaseDate?: string;
  description?: string;
  longDescription?: string;
  artworkUrl100?: string;
  collectionViewUrl?: string;
}

interface ItunesResponse {
  results?: ItunesResult[];
}

function yearFromDate(value?: string) {
  const match = value?.match(/\d{4}/);
  return match ? Number(match[0]) : undefined;
}

function highResolutionCover(value?: string) {
  return value?.replace(/100x100bb\.(jpg|png)$/i, "600x600bb.$1");
}

function mapItunesResult(result: ItunesResult): MetadataCandidate {
  return {
    title: result.collectionName ?? result.trackName!,
    authors: result.artistName ? [result.artistName] : [],
    year: yearFromDate(result.releaseDate),
    description: result.longDescription ?? result.description,
    coverUrl: highResolutionCover(result.artworkUrl100),
    genres: result.primaryGenreName ? [result.primaryGenreName] : [],
    source: "itunes" as const
  };
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
    .map(mapItunesResult);
}

export async function fetchItunesByUrl(url: string): Promise<MetadataCandidate[]> {
  const parsed = new URL(url);
  // Apple links carry the item id as ?i= (a track inside a collection) or the
  // trailing /idNNNNNNN path segment.
  const id = parsed.searchParams.get("i") ?? parsed.pathname.match(/\/id(\d+)/)?.[1];
  if (!id) {
    throw new MetadataLinkError("That doesn't look like an Apple Books link.");
  }

  const payload = JSON.parse(
    await fetchTextFromUrl(`https://itunes.apple.com/lookup?id=${id}`, { accept: "application/json" })
  ) as ItunesResponse;
  return (payload.results ?? [])
    .filter((result) => result.collectionName || result.trackName)
    .map(mapItunesResult);
}
