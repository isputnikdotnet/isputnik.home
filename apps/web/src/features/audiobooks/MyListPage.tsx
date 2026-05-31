import { useEffect, useState } from "react";
import { BookOpen, Heart } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { AudiobookNav } from "./AudiobookNav";
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

  useEffect(() => {
    api<{ books: SavedBook[] }>("/api/library/saved")
      .then((payload) => setBooks(payload.books))
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load your list"));
  }, []);

  return (
    <DashboardShell active="audiobooks" user={user} logout={logout} sideNav={<AudiobookNav active="saved" />}>
      <section className="work-area scene-page audiobook-scene audiobook-area">
        <div className="section-head audiobook-head">
          <div>
            <p className="eyebrow">Digital Library</p>
            <h1>My List</h1>
          </div>
          {books && books.length > 0 && (
            <span>{books.length} {books.length === 1 ? "book" : "books"}</span>
          )}
        </div>

        {error && <MessageBox tone="error" title="My List error">{error}</MessageBox>}

        {books && books.length === 0 ? (
          <div className="empty-state library-empty">
            <Heart size={58} aria-hidden="true" />
            <h2>Nothing saved yet</h2>
            <p className="muted">Open a book and tap “My List” in the player to save it here.</p>
          </div>
        ) : (
          <div className="audiobook-grid">
            {(books ?? []).map((book) => (
              <button className="audiobook-card" key={book.id} onClick={() => navigate(`/audiobooks/books/${book.id}`)}>
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
            ))}
            {books === null && <p className="management-empty">Loading your list...</p>}
          </div>
        )}
      </section>
    </DashboardShell>
  );
}
