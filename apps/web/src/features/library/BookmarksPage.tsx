import { useEffect, useMemo, useState } from "react";
import { Bookmark, BookOpen, ChevronDown, Headphones, Play, Trash2 } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { LibraryNavTabs } from "./LibraryNavTabs";
import { navigate } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import { MediaKindBadge } from "../../shared/MediaKindBadge";
import { formatDuration, relativeTime } from "../../shared/utils";
import type { SavedBookmark } from "../audiobooks/types";

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

// Real stored position — a listen timestamp or a read percentage. (We don't store
// page numbers, so the progress position stands in for "where in the book".)
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

interface BookmarkGroup {
  bookId: string;
  bookTitle: string;
  bookAuthors: string[];
  coverUrl: string | null;
  libraryType: SavedBookmark["libraryType"];
  items: SavedBookmark[];
}

// Group bookmarks under their book, newest bookmark first within a group, and
// groups ordered by their most recent bookmark.
function groupByBook(bookmarks: SavedBookmark[]): BookmarkGroup[] {
  const map = new Map<string, BookmarkGroup>();
  for (const bookmark of bookmarks) {
    const group = map.get(bookmark.bookId);
    if (group) {
      group.items.push(bookmark);
    } else {
      map.set(bookmark.bookId, {
        bookId: bookmark.bookId,
        bookTitle: bookmark.bookTitle,
        bookAuthors: bookmark.bookAuthors,
        coverUrl: bookmark.coverUrl,
        libraryType: bookmark.libraryType,
        items: [bookmark]
      });
    }
  }
  const groups = [...map.values()];
  for (const group of groups) {
    group.items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  groups.sort((a, b) => b.items[0].createdAt.localeCompare(a.items[0].createdAt));
  return groups;
}

function Cover({ url, title, libraryType }: { url: string | null; title: string; libraryType: SavedBookmark["libraryType"] }) {
  const FallbackIcon = libraryType === "ebook" ? BookOpen : Headphones;
  return url ? (
    <img src={url} alt="" />
  ) : (
    <>
      <FallbackIcon size={16} />
      <strong>{title.slice(0, 2).toUpperCase()}</strong>
    </>
  );
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
  // Groups start collapsed; the reader expands only the books they want.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    api<{ bookmarks: SavedBookmark[] }>("/api/library/bookmarks")
      .then((payload) => setBookmarks(payload.bookmarks))
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load your bookmarks"));
  }, []);

  const groups = useMemo(() => groupByBook(bookmarks ?? []), [bookmarks]);
  const total = bookmarks?.length ?? 0;

  const toggleGroup = (bookId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(bookId)) next.delete(bookId);
      else next.add(bookId);
      return next;
    });
  };

  // Read bookmarks open straight into the reader (the detail page auto-opens it on
  // ?read); listen bookmarks pop out the player, matching the book page's Play action.
  const openBookmark = (bookmark: SavedBookmark) => {
    if (bookmark.kind === "read") {
      navigate(`${detailHref(bookmark)}?read=1`);
    } else {
      window.open(`/player/${bookmark.bookId}`, "isputnik-player", "width=500,height=700,resizable=yes,scrollbars=yes");
    }
  };

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
          {total > 0 && (
            <span className="bookmark-total">
              <Bookmark size={15} aria-hidden="true" />
              {total} {total === 1 ? "Bookmark" : "Bookmarks"}
            </span>
          )}
        </div>

        {error && <MessageBox tone="error" title="Bookmarks error">{error}</MessageBox>}

        {bookmarks === null ? (
          <p className="management-empty">Loading your bookmarks…</p>
        ) : bookmarks.length === 0 ? (
          <div className="empty-state library-empty">
            <Bookmark size={58} aria-hidden="true" />
            <h2>No bookmarks yet</h2>
            <p className="muted">While reading or listening, tap the bookmark button to save your spot here.</p>
          </div>
        ) : (
          <>
            <div className="bookmark-groups">
              {groups.map((group) => {
                const open = expanded.has(group.bookId);
                const count = group.items.length;
                return (
                  <section className="bookmark-group" key={group.bookId}>
                    <button
                      type="button"
                      className="bookmark-group-head"
                      onClick={() => toggleGroup(group.bookId)}
                      aria-expanded={open}
                    >
                      <span className="bookmark-group-cover" aria-hidden="true">
                        <Cover url={group.coverUrl} title={group.bookTitle} libraryType={group.libraryType} />
                        <MediaKindBadge kind={group.libraryType} overlay />
                      </span>
                      <span className="bookmark-group-meta">
                        <strong>{group.bookTitle}</strong>
                        {group.bookAuthors.length > 0 && <span>{group.bookAuthors.join(", ")}</span>}
                      </span>
                      <span className="bookmark-count">{count} {count === 1 ? "bookmark" : "bookmarks"}</span>
                      <ChevronDown className={`bookmark-chevron${open ? " is-open" : ""}`} size={20} aria-hidden="true" />
                    </button>

                    {open && (
                      <div className="bookmark-list">
                        {group.items.map((bookmark, index) => {
                          const removing = removingIds.includes(bookmark.id);
                          return (
                            <article className="bookmark-row" key={bookmark.id}>
                              <span className="bookmark-index" aria-hidden="true">{index + 1}</span>
                              <button className="bookmark-row-open" onClick={() => navigate(detailHref(bookmark))}>
                                <span className="bookmark-row-cover" aria-hidden="true">
                                  <Cover url={bookmark.coverUrl} title={bookmark.bookTitle} libraryType={bookmark.libraryType} />
                                </span>
                                <span className="bookmark-row-body">
                                  <strong className="bookmark-chapter">{bookmark.label || "Bookmark"}</strong>
                                  <span className="bookmark-meta">
                                    {positionLabel(bookmark)}
                                    <span className="bookmark-meta-dot" aria-hidden="true">•</span>
                                    {bookmark.note
                                      ? <span className="bookmark-note">{bookmark.note}</span>
                                      : relativeTime(bookmark.createdAt)}
                                  </span>
                                </span>
                              </button>
                              <div className="bookmark-row-actions">
                                <button
                                  className="icon-button bookmark-open"
                                  onClick={() => openBookmark(bookmark)}
                                  aria-label={bookmark.kind === "read" ? `Read ${bookmark.bookTitle}` : `Play ${bookmark.bookTitle}`}
                                  title={bookmark.kind === "read" ? "Read" : "Play"}
                                >
                                  {bookmark.kind === "read" ? <BookOpen size={16} /> : <Play size={16} />}
                                </button>
                                <button
                                  className="icon-button danger bookmark-remove"
                                  onClick={() => removeBookmark(bookmark)}
                                  disabled={removing}
                                  aria-label={`Remove bookmark from ${bookmark.bookTitle}`}
                                  title="Remove bookmark"
                                >
                                  <Trash2 size={16} />
                                </button>
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>

            <p className="bookmark-footer">
              Showing {groups.length} {groups.length === 1 ? "book" : "books"} with {total} {total === 1 ? "bookmark" : "bookmarks"}
            </p>
          </>
        )}
      </section>
    </DashboardShell>
  );
}
