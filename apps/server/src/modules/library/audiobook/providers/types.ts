export type MetadataProvider = "itunes" | "openlibrary" | "fantlab" | "librivox";

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
