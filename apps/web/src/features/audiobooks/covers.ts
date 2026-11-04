// Placeholder art for anything with no picture of its own, keyed by kind. The files
// live in apps/web/public/Assets/covers/ (served at /Assets/covers/) and come from the
// app icons' family: one dark tone per kind, a faint orbit, a cream glyph. They are
// posters (2:3); the video kinds also have a 16:9 frame for wide cards.
export type CoverKind = "audiobook" | "ebook" | "movie" | "show";

export const DEFAULT_COVERS: Partial<Record<CoverKind, string>> = {
  audiobook: "/Assets/covers/audiobook.svg",
  ebook: "/Assets/covers/ebook.svg",
  movie: "/Assets/covers/movie.svg",
  show: "/Assets/covers/show.svg"
};

export const DEFAULT_WIDE_COVERS: Partial<Record<"movie" | "show", string>> = {
  movie: "/Assets/covers/movie-wide.svg",
  show: "/Assets/covers/show-wide.svg"
};

/** The placeholder for a collection entry, by its entity type; null for kinds without one. */
export function placeholderForEntity(entityType: string): string | null {
  switch (entityType) {
    case "audiobook": return DEFAULT_COVERS.audiobook ?? null;
    case "ebook": return DEFAULT_COVERS.ebook ?? null;
    case "video_movie": return DEFAULT_COVERS.movie ?? null;
    case "video_show": return DEFAULT_COVERS.show ?? null;
    default: return null;
  }
}
