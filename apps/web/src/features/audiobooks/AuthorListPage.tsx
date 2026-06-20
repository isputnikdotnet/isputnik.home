import { useEffect, useState } from "react";
import { BookOpen, Headphones, Search, UserRound } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { navigate } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import { AudiobookPageHeader } from "./AudiobooksPage";

type KindFilter = "all" | "audiobook" | "ebook";
type AuthorSummary = { name: string; audiobookCount: number; ebookCount: number };

// The single, cross-type Authors browse (replaces the old per-section author
// lists). Authors are global, so one list spans audiobooks + ebooks; the
// All / Audiobooks / Ebooks toggle mirrors the category detail page. Every card
// opens the unified person page at /people/:name.
export function AuthorListPage({
  user,
  logout
}: {
  user: PublicUser;
  logout: () => Promise<void>;
}) {
  const [authors, setAuthors] = useState<AuthorSummary[]>([]);
  const [photos, setPhotos] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");

  useEffect(() => {
    api<{ authors: AuthorSummary[] }>("/api/library/people/authors")
      .then((payload) => setAuthors(payload.authors))
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load authors"));
    api<{ photos: Record<string, string> }>("/api/library/people/photos")
      .then((payload) => setPhotos(payload.photos))
      .catch(() => {}); // avatars are decoration — the list works without them
  }, []);

  // Toggle counts = how many authors fall in each media type; the toggle only
  // appears when authors actually span both types.
  const audiobookAuthors = authors.filter((a) => a.audiobookCount > 0).length;
  const ebookAuthors = authors.filter((a) => a.ebookCount > 0).length;
  const hasBothTypes = audiobookAuthors > 0 && ebookAuthors > 0;

  // The title count on each card, scoped to the active filter.
  const cardCount = (a: AuthorSummary) =>
    kindFilter === "audiobook" ? a.audiobookCount
      : kindFilter === "ebook" ? a.ebookCount
        : a.audiobookCount + a.ebookCount;

  const term = search.trim().toLowerCase();
  const shown = authors
    .filter((a) => kindFilter === "all" || (kindFilter === "audiobook" ? a.audiobookCount > 0 : a.ebookCount > 0))
    .filter((a) => !term || a.name.toLowerCase().includes(term));

  return (
    <DashboardShell active="authors" user={user} logout={logout}>
      <section className="audiobook-main-page">
        <AudiobookPageHeader
          title="Authors"
          subtitle={`${shown.length} ${shown.length === 1 ? "author" : "authors"}`}
        />

        {error && <MessageBox tone="error" title="Authors error">{error}</MessageBox>}

        {authors.length > 0 && (
          <div className="audiobook-toolbar">
            <label className="search-field">
              <Search size={17} aria-hidden="true" />
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search authors"
                aria-label="Search authors"
              />
            </label>
          </div>
        )}

        {hasBothTypes && (
          <div className="kind-toggle" role="group" aria-label="Filter by media type">
            <button type="button" className={kindFilter === "all" ? "is-active" : ""} onClick={() => setKindFilter("all")}>
              All<span className="kind-toggle-count">{authors.length}</span>
            </button>
            <button type="button" className={kindFilter === "audiobook" ? "is-active" : ""} onClick={() => setKindFilter("audiobook")}>
              <Headphones size={15} aria-hidden="true" />Audiobooks<span className="kind-toggle-count">{audiobookAuthors}</span>
            </button>
            <button type="button" className={kindFilter === "ebook" ? "is-active" : ""} onClick={() => setKindFilter("ebook")}>
              <BookOpen size={15} aria-hidden="true" />Ebooks<span className="kind-toggle-count">{ebookAuthors}</span>
            </button>
          </div>
        )}

        {shown.length === 0 ? (
          <div className="empty-state library-empty">
            <UserRound size={48} aria-hidden="true" />
            <h2>No authors{term ? " match" : " yet"}</h2>
          </div>
        ) : (
          <div className="person-grid">
            {shown.map((author) => (
              <button
                key={author.name}
                className="person-card"
                onClick={() => navigate(`/people/${encodeURIComponent(author.name)}?from=${encodeURIComponent("/authors")}`)}
              >
                <div className="person-avatar" aria-hidden="true">
                  {photos[author.name] ? <img src={photos[author.name]} alt="" /> : <UserRound size={26} />}
                </div>
                <div className="person-card-body">
                  <strong>{author.name}</strong>
                  <span>{cardCount(author)} {cardCount(author) === 1 ? "title" : "titles"}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </section>
    </DashboardShell>
  );
}
