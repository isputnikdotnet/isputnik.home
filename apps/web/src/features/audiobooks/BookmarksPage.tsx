import { useEffect, useState } from "react";
import { Bookmark, BookOpen, Headphones, Trash2 } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { LibraryNavTabs } from "./LibraryNavTabs";
import { navigate } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import { MediaKindBadge } from "../../shared/MediaKindBadge";
import { formatDuration } from "../../shared/utils";
import type { SavedBookmark } from "./types";

function percentLabel(value: number | null): number {
  if (value == null || !Number.isFinite(value)) return 0;
  return Math.round(Math.max(0, Math.min(1, value)) * 100);
}

// Bookmarks route to the right detail page by their parent library's media type,
// not by the bookmark kind — an epub reader bookmark can live on a book in an
// audiobook library (an audio title with an epub companion).
function detailHref(bookmark: SavedBookmark): string {
  const base = bookmark.libraryType === "ebook" ? "/ebooks" : "/audiobooks";
  return `${base}/books/${bookmark.bookId}`;
}

function positionLabel(bookmark: SavedBookmark): string {
  if (bookmark.kind === "listen") {
    return `At ${formatDuration(bookmark.bookPositionSeconds ?? bookmark.positionSeconds)}`;
  }
  return bookmark.percentComplete != null ? `At ${percentLabel(bookmark.percentComplete)}%` : "Saved spot";
}

function removeEndpoint(bookmark: SavedBookmark): string {
  return bookmark.kind === "read"
    ? `/api/library/books/${bookmark.bookId}/ebook-bookmarks/${bookmark.id}`
    : `/api/library/books/${bookmark.bookId}/bookmarks/${bookmark.id}`;
}

export function BookmarksPage({
  user,
  logout
}: {
  user: PublicUser;
  logout: () => Promise<void>;
}) {
  const [bookmarks, setBookmarks] = useState<SavedBookmark[] | null>(null);
  const [error, setError] = useState("");
  const [removingIds, setRemovingIds] = useState<string[]>([]);

  useEffect(() => {
    api<{ bookmarks: SavedBookmark[] }>("/api/library/bookmarks")
      .then((payload) => setBookmarks(payload.bookmarks))
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load your bookmarks"));
  }, []);

  const removeBookmark = async (bookmark: SavedBookmark) => {
    setRemovingIds((current) => [...current, bookmark.id]);
    setError("");
    try {
      await api(removeEndpoint(bookmark), { method: "DELETE" });
      setBookmarks((current) => current?.filter((item) => item.id !== bookmark.id) ?? current);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to remove this bookmark");
    } finally {
      setRemovingIds((current) => current.filter((id) => id !== bookmark.id));
    }
  };

  return (
    <DashboardShell active="audiobooks" user={user} logout={logout}>
      <section className="work-area audiobook-area">
        <LibraryNavTabs active="bookmarks" />

        <div className="section-head audiobook-head">
          <div>
            <p className="eyebrow">Digital Library</p>
            <h1>Bookmarks</h1>
          </div>
          {bookmarks && bookmarks.length > 0 && (
            <span>{bookmarks.length} {bookmarks.length === 1 ? "bookmark" : "bookmarks"}</span>
          )}
        </div>

        {error && <MessageBox tone="error" title="Bookmarks error">{error}</MessageBox>}

        {bookmarks && bookmarks.length === 0 ? (
          <div className="empty-state library-empty">
            <Bookmark size={58} aria-hidden="true" />
            <h2>No bookmarks yet</h2>
            <p className="muted">While reading or listening, tap the bookmark button to save your spot here.</p>
          </div>
        ) : (
          <div className="audiobook-grid">
            {(bookmarks ?? []).map((bookmark) => {
              const removing = removingIds.includes(bookmark.id);
              const FallbackIcon = bookmark.libraryType === "ebook" ? BookOpen : Headphones;
              return (
                <article className="saved-audiobook-card" key={bookmark.id}>
                  <button className="audiobook-card" onClick={() => navigate(detailHref(bookmark))}>
                    <div className="audiobook-cover" aria-hidden="true">
                      {bookmark.coverUrl ? (
                        <img src={bookmark.coverUrl} alt="" />
                      ) : (
                        <>
                          <FallbackIcon size={13} />
                          <strong>{bookmark.bookTitle.slice(0, 2).toUpperCase()}</strong>
                        </>
                      )}
                      <MediaKindBadge kind={bookmark.libraryType} overlay />
                    </div>
                    <div className="audiobook-card-body">
                      <strong>{bookmark.label || bookmark.bookTitle}</strong>
                      <span>{bookmark.bookAuthors.length > 0 ? bookmark.bookAuthors.join(", ") : bookmark.bookTitle}</span>
                      <small>{positionLabel(bookmark)}</small>
                      {bookmark.note && <p className="audiobook-card-note">{bookmark.note}</p>}
                    </div>
                  </button>
                  <button
                    className="icon-button danger saved-audiobook-remove"
                    onClick={() => removeBookmark(bookmark)}
                    disabled={removing}
                    aria-label={`Remove bookmark from ${bookmark.bookTitle}`}
                    title="Remove bookmark"
                  >
                    <Trash2 size={16} />
                  </button>
                </article>
              );
            })}
            {bookmarks === null && <p className="management-empty">Loading your bookmarks...</p>}
          </div>
        )}
      </section>
    </DashboardShell>
  );
}
