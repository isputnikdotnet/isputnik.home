// Default cover art shown for a book that has no artwork, keyed by media type.
// Files live in apps/web/public/Assets/covers/ (served at /Assets/covers/).
// Add an entry here once the art for a type is in place; callers fall back to a
// line icon for any type without a default image.
export const DEFAULT_COVERS: Partial<Record<"audiobook" | "ebook", string>> = {
  audiobook: "/Assets/covers/audiobook-default.png",
  ebook: "/Assets/covers/ebook-default.png"
};
