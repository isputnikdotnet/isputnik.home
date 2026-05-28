import type { MetadataCandidate, MetadataSearchInput } from "./types.js";

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
