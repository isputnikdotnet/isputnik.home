import { useEffect, useState } from "react";
import { BookOpen } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { navigate } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import { AudiobookNav } from "./AudiobookNav";

interface TagDetail {
  name: string;
  books: { id: string; title: string; authors: string[]; coverUrl: string | null }[];
}

export function TagDetailPage({
  tagName,
  user,
  logout
}: {
  tagName: string;
  user: PublicUser;
  logout: () => Promise<void>;
}) {
  const [tag, setTag] = useState<TagDetail | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setError("");
    setTag(null);
    api<{ tag: TagDetail }>(`/api/library/tags/${encodeURIComponent(tagName)}/books`)
      .then((payload) => setTag(payload.tag))
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load tag"));
  }, [tagName]);

  return (
    <DashboardShell active="audiobooks" user={user} logout={logout} sideNav={<AudiobookNav active="categories" />}>
      <section className="work-area scene-page audiobook-scene audiobook-area">
        <button className="back-link" onClick={() => navigate("/audiobooks")}>← Audiobooks</button>

        {error && <MessageBox tone="error" title="Tag error">{error}</MessageBox>}

        {tag && (
          <>
            <div className="section-head audiobook-head">
              <div>
                <p className="eyebrow">Tag</p>
                <h1>{tag.name}</h1>
              </div>
              <span>{tag.books.length} {tag.books.length === 1 ? "book" : "books"}</span>
            </div>

            {tag.books.length === 0 ? (
              <p className="management-empty">No books with this tag yet.</p>
            ) : (
              <div className="audiobook-grid">
                {tag.books.map((book) => (
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
                    </div>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </section>
    </DashboardShell>
  );
}
