export type MetadataProvider = "itunes" | "openlibrary" | "fantlab";

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
  source: MetadataProvider;
}

export interface MetadataSearchInput {
  query: string;
  author?: string;
  limit?: number;
}
