import { useEffect, useState } from "react";
import { BookOpen, Share2 } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { UserAreaNav } from "./UserAreaNav";
import { navigate } from "../../router";
import { MessageBox } from "../../shared/MessageBox";

interface SharedBook {
  id: string;
  type: "audiobook" | "ebook";
  title: string;
  coverUrl: string | null;
  sharedBy: string | null;
  sharedAt: string;
  expiresAt: string | null;
}

export function SharedWithMePage({
  user,
  logout
}: {
  user: PublicUser;
  logout: () => Promise<void>;
}) {
  const [books, setBooks] = useState<SharedBook[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ books: SharedBook[] }>("/api/shared-with-me")
      .then((payload) => setBooks(payload.books))
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load shared books"));
  }, []);

  return (
    <DashboardShell active="user" user={user} logout={logout} sideNav={<UserAreaNav active="shared" />}>
      <section className="work-area audiobook-area">
        <div className="section-head audiobook-head">
          <div>
            <p className="eyebrow">Digital Library</p>
            <h1>Shared with me</h1>
          </div>
          {books && books.length > 0 && (
            <span>{books.length} {books.length === 1 ? "book" : "books"}</span>
          )}
        </div>

        {error && <MessageBox tone="error" title="Error">{error}</MessageBox>}

        {books && books.length === 0 ? (
          <div className="empty-state library-empty">
            <Share2 size={58} aria-hidden="true" />
            <h2>Nothing shared with you yet</h2>
            <p className="muted">When someone shares a book with your account, it appears here.</p>
          </div>
        ) : (
          <div className="audiobook-grid">
            {(books ?? []).map((book) => (
              <article className="saved-audiobook-card" key={book.id}>
                <button className="audiobook-card" onClick={() => navigate(`${book.type === "ebook" ? "/ebooks" : "/audiobooks"}/books/${book.id}`)}>
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
                    <span>{book.sharedBy ? `Shared by ${book.sharedBy}` : "Shared with you"}</span>
                    <small>{book.expiresAt ? `Until ${new Date(book.expiresAt).toLocaleDateString()}` : "No expiry"}</small>
                  </div>
                </button>
              </article>
            ))}
            {books === null && <p className="management-empty">Loading…</p>}
          </div>
        )}
      </section>
    </DashboardShell>
  );
}
