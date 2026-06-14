import { useEffect, useState } from "react";
import { ArrowLeft, BookOpen, Headphones } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { getReferrer, navigate } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import { FeedTile } from "../library/FeedTile";
import { CategoryIcon } from "./categoryIcons";
import type { CategoryDetail } from "./types";

type KindFilter = "all" | "audiobook" | "ebook";

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
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const backTo = getReferrer();

  useEffect(() => {
    setError("");
    setCategory(null);
    setKindFilter("all");
    api<{ category: CategoryDetail }>(`/api/library/categories/${categoryKey}/books`)
      .then((payload) => setCategory(payload.category))
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load category"));
  }, [categoryKey]);

  // Counts drive both the toggle labels and whether the toggle is worth showing
  // (only when the category actually holds both media types).
  const audiobookCount = category?.books.filter((book) => book.kind === "audiobook").length ?? 0;
  const ebookCount = category?.books.filter((book) => book.kind === "ebook").length ?? 0;
  const hasBothTypes = audiobookCount > 0 && ebookCount > 0;
  const shownBooks = category
    ? (kindFilter === "all" ? category.books : category.books.filter((book) => book.kind === kindFilter))
    : [];

  return (
    <DashboardShell active="categories" user={user} logout={logout}>
      <section className="audiobook-main-page">
        <button className="audiobook-back-button" type="button" onClick={() => navigate(backTo ?? "/categories")}>
          <ArrowLeft size={17} aria-hidden="true" />
          <span>{backTo ? "Back" : "Back to categories"}</span>
        </button>

        {error && <MessageBox tone="error" title="Category error">{error}</MessageBox>}

        {category && (
          <>
            <div className="category-detail-head">
              <div className="category-detail-image" aria-hidden="true">
                <CategoryIcon icon={category.icon} size={44} />
              </div>
              <div className="category-detail-copy">
                <p className="eyebrow">Category</p>
                <h1>{category.name}</h1>
              </div>
              <span className="category-detail-count">
                {category.books.length} {category.books.length === 1 ? "book" : "books"}
              </span>
            </div>

            {hasBothTypes && (
              <div className="kind-toggle" role="group" aria-label="Filter by media type">
                <button type="button" className={kindFilter === "all" ? "is-active" : ""} onClick={() => setKindFilter("all")}>
                  All<span className="kind-toggle-count">{category.books.length}</span>
                </button>
                <button type="button" className={kindFilter === "audiobook" ? "is-active" : ""} onClick={() => setKindFilter("audiobook")}>
                  <Headphones size={15} aria-hidden="true" />Audiobooks<span className="kind-toggle-count">{audiobookCount}</span>
                </button>
                <button type="button" className={kindFilter === "ebook" ? "is-active" : ""} onClick={() => setKindFilter("ebook")}>
                  <BookOpen size={15} aria-hidden="true" />Ebooks<span className="kind-toggle-count">{ebookCount}</span>
                </button>
              </div>
            )}

            {shownBooks.length === 0 ? (
              <p className="management-empty">No books in this category yet.</p>
            ) : (
              // Mixed view labels each tile by type; a single-type view doesn't need it.
              <div className="library-feed-grid">
                {shownBooks.map((book) => (
                  <FeedTile key={`${book.kind}-${book.id}`} item={book} progress kindLabel={kindFilter === "all"} />
                ))}
              </div>
            )}
          </>
        )}
      </section>
    </DashboardShell>
  );
}
