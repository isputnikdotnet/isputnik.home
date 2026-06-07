import { useEffect, useState } from "react";
import { BookOpen, Heart, Trash2 } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { LibraryNavTabs } from "./LibraryNavTabs";
import { navigate } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import { formatDuration } from "../../shared/utils";
import type { SavedBook } from "./types";

export function MyListPage({
  user,
  logout
}: {
  user: PublicUser;
  logout: () => Promise<void>;
}) {
  const [books, setBooks] = useState<SavedBook[] | null>(null);
  const [error, setError] = useState("");
  const [removingIds, setRemovingIds] = useState<string[]>([]);

  useEffect(() => {
    api<{ books: SavedBook[] }>("/api/library/saved")
      .then((payload) => setBooks(payload.books))
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load your favorites"));
  }, []);

  const removeBook = async (bookId: string) => {
    setRemovingIds((current) => [...current, bookId]);
    setError("");
    try {
      await api(`/api/library/books/${bookId}/save`, { method: "DELETE" });
      setBooks((current) => current?.filter((book) => book.id !== bookId) ?? current);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to remove this book from Favorites");
    } finally {
      setRemovingIds((current) => current.filter((id) => id !== bookId));
    }
  };

  return (
    <DashboardShell active="audiobooks" user={user} logout={logout}>
      <section className="work-area audiobook-area">
        <LibraryNavTabs active="saved" />

        <div className="section-head audiobook-head">
          <div>
            <p className="eyebrow">Digital Library</p>
            <h1>Favorites</h1>
          </div>
          {books && books.length > 0 && (
            <span>{books.length} {books.length === 1 ? "book" : "books"}</span>
          )}
        </div>

        {error && <MessageBox tone="error" title="Favorites error">{error}</MessageBox>}

        {books && books.length === 0 ? (
          <div className="empty-state library-empty">
            <Heart size={58} aria-hidden="true" />
            <h2>No favorites yet</h2>
            <p className="muted">Open a book and tap “Add to Favorites” to save it here.</p>
          </div>
        ) : (
          <div className="audiobook-grid">
            {(books ?? []).map((book) => {
              const removing = removingIds.includes(book.id);
              return (
                <article className="saved-audiobook-card" key={book.id}>
                  <button className="audiobook-card" onClick={() => navigate(`/audiobooks/books/${book.id}`)}>
                    <div className="audiobook-cover" aria-hidden="true">
                      {book.coverUrl ? (
                        <img src={book.coverUrl} alt="" />
                      ) : (
                        <>
                          <BookOpen size={13} />
                          <strong>{book.title.slice(0, 2).toUpperCase()}</strong>
                        </>
                      )}
                    </div>
                    <div className="audiobook-card-body">
                      <strong>{book.title}</strong>
                      <span>{book.authors.length > 0 ? book.authors.join(", ") : "Unknown author"}</span>
                      <small>
                        {book.durationSeconds != null ? `${formatDuration(book.durationSeconds)} · ` : ""}
                        {book.fileCount} {book.fileCount === 1 ? "file" : "files"}
                      </small>
                      {book.note && <p className="audiobook-card-note">{book.note}</p>}
                    </div>
                  </button>
                  <button
                    className="icon-button danger saved-audiobook-remove"
                    onClick={() => removeBook(book.id)}
                    disabled={removing}
                    aria-label={`Remove ${book.title} from Favorites`}
                    title="Remove from Favorites"
                  >
                    <Trash2 size={16} />
                  </button>
                </article>
              );
            })}
            {books === null && <p className="management-empty">Loading your list...</p>}
          </div>
        )}
      </section>
    </DashboardShell>
  );
}
