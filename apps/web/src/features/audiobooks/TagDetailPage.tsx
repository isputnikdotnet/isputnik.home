import { useEffect, useState } from "react";
import { ArrowLeft, BookOpen, Headphones } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { getReferrer, navigate } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import { FeedTile } from "../library/FeedTile";
import type { FeedItem } from "../library/feed";

interface TagDetail {
  name: string;
  books: FeedItem[];
}

type KindFilter = "all" | "audiobook" | "ebook";

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
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const backTo = getReferrer();

  useEffect(() => {
    setError("");
    setTag(null);
    setKindFilter("all");
    api<{ tag: TagDetail }>(`/api/library/tags/${encodeURIComponent(tagName)}/books`)
      .then((payload) => setTag(payload.tag))
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load tag"));
  }, [tagName]);

  const audiobookCount = tag?.books.filter((book) => book.kind === "audiobook").length ?? 0;
  const ebookCount = tag?.books.filter((book) => book.kind === "ebook").length ?? 0;
  const hasBothTypes = audiobookCount > 0 && ebookCount > 0;
  const shownBooks = tag
    ? (kindFilter === "all" ? tag.books : tag.books.filter((book) => book.kind === kindFilter))
    : [];

  return (
    <DashboardShell active="tags" user={user} logout={logout}>
      <section className="audiobook-main-page">
        <button className="audiobook-back-button" type="button" onClick={() => navigate(backTo ?? "/tags")}>
          <ArrowLeft size={17} aria-hidden="true" />
          <span>{backTo ? "Back" : "Back to tags"}</span>
        </button>

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

            {hasBothTypes && (
              <div className="kind-toggle" role="group" aria-label="Filter by media type">
                <button type="button" className={kindFilter === "all" ? "is-active" : ""} onClick={() => setKindFilter("all")}>
                  All<span className="kind-toggle-count">{tag.books.length}</span>
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
              <p className="management-empty">No books with this tag yet.</p>
            ) : (
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
