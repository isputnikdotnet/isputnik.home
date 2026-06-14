export const LIBRARY_TYPES = ["audiobook", "ebook", "photo", "video"] as const;
export type LibraryType = typeof LIBRARY_TYPES[number];

// Library types whose items are rows in `books` with a primary category in
// book_metadata.category_id — the cross-type "book-like" media. This is the single
// source of truth for the unified catalog-adjacent features that span types:
// the home feeds, the global Categories browse, and category re-match. A new
// digital library type joins them by (a) being added here and (b) having its
// scanner write book_metadata (title + matchCategoryId) and store its subjects as
// tags — exactly what the audiobook and ebook scanners already do.
export const BOOK_LIBRARY_TYPES = ["audiobook", "ebook"] as const;
export type BookLibraryType = typeof BOOK_LIBRARY_TYPES[number];
