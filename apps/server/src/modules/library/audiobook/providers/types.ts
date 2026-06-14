export type MetadataProvider = "itunes" | "openlibrary" | "fantlab" | "librivox" | "audible";

export interface MetadataCandidate {
  title: string;
  subtitle?: string;
  authors: string[];
  narrators?: string[];
  publisher?: string;
  year?: number;
  description?: string;
  coverUrl?: string;
  isbn?: string;
  asin?: string;
  genres?: string[];
  language?: string;
  // archive.org item identifier (LibriVox results) — lets scan enrichment
  // upgrade the tile thumbnail in coverUrl to the item's full-size cover art.
  archiveId?: string;
  // LibriVox catalogue id — present on author-search results, which are slim
  // (no narrators); fetchLibrivoxById(id) returns the full record.
  librivoxId?: string;
  source: MetadataProvider;
}

export interface MetadataSearchInput {
  query: string;
  author?: string;
  limit?: number;
}

// Thrown when a user-supplied metadata link is malformed or points at an
// unsupported host — a 400 (user-fixable), distinct from a provider fetch
// failure (502). Lives here so both index.ts and the provider modules can
// throw it without importing each other.
export class MetadataLinkError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "MetadataLinkError";
    this.status = status;
  }
}
