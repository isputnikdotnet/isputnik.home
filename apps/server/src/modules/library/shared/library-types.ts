export const LIBRARY_TYPES = ["audiobook", "ebook", "gallery"] as const;
export type LibraryType = typeof LIBRARY_TYPES[number];

// Library types whose items are rows in `library_items` with a primary category
// in `item_categories` — the cross-type "book-like" media. This is the single
// source of truth for the unified catalog-adjacent features that span types:
// the home feeds, the global Categories browse, and category re-match. A new
// digital library type joins them by (a) being added here and (b) having its
// scanner write item_metadata (title) + a primary item_categories row and store
// its subjects as tags — exactly what the audiobook and ebook scanners already do.
export const BOOK_LIBRARY_TYPES = ["audiobook", "ebook"] as const;
export type BookLibraryType = typeof BOOK_LIBRARY_TYPES[number];

// Every media module namespace used by shares, item access, and collections. A
// superset of BookLibraryType — gallery items are shareable/collectable but are
// not "book-like" (no authors/categories/reading progress).
export const MEDIA_MODULES = ["audiobook", "ebook", "gallery"] as const;
export type MediaModule = typeof MEDIA_MODULES[number];

// Map a library type onto the share/collection module namespace it uses. Anything
// unexpected folds into "audiobook" to keep routing valid. This is the single
// source of truth for the libraries.type → module mapping.
export function mediaKind(libraryType: string): MediaModule {
  return libraryType === "ebook" ? "ebook" : libraryType === "gallery" ? "gallery" : "audiobook";
}
