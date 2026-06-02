import { useEffect, useState } from "react";
import { BookOpen } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { navigate } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import { AudiobookNav } from "./AudiobookNav";
import { CategoryIcon } from "./categoryIcons";
import type { CategoryDetail } from "./types";

export function CategoryDetailPage({
  categoryKey,
  user,
  logout
}: {
  categoryKey: string;
  user: PublicUser;
  logout: () => Promise<void>;
}) {
  const [category, setCategory] = useState<CategoryDetail | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setError("");
    setCategory(null);
    api<{ category: CategoryDetail }>(`/api/library/categories/${categoryKey}/books`)
      .then((payload) => setCategory(payload.category))
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load category"));
  }, [categoryKey]);

  return (
    <DashboardShell active="audiobooks" user={user} logout={logout} sideNav={<AudiobookNav active="categories" />}>
      <section className="work-area scene-page audiobook-scene audiobook-area">
        <button className="back-link" onClick={() => navigate("/audiobooks/categories")}>← Categories</button>

        {error && <MessageBox tone="error" title="Category error">{error}</MessageBox>}

        {category && (
          <>
            <div className="category-detail-head">
              <div className="category-detail-image" aria-hidden="true">
                {category.imageUrl ? (
                  <img src={category.imageUrl} alt="" />
                ) : (
                  <CategoryIcon icon={category.icon} size={46} />
                )}
              </div>
              <div className="category-detail-copy">
                <p className="eyebrow">Category</p>
                <h1>{category.name}</h1>
              </div>
              <span className="category-detail-count">
                {category.books.length} {category.books.length === 1 ? "book" : "books"}
              </span>
            </div>

            {category.books.length === 0 ? (
              <p className="management-empty">No books in this category yet.</p>
            ) : (
              <div className="audiobook-grid">
                {category.books.map((book) => (
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
