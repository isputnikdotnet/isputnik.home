import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { BookOpen, Headphones, Heart, Image as ImageIcon, Trash2 } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { UserAreaNav } from "./UserAreaNav";
import { navigate } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import { MediaKindBadge } from "../../shared/MediaKindBadge";
import type { SavedBook } from "../audiobooks/types";

export function LikesPage({
  user,
  logout
}: {
  user: PublicUser;
  logout: () => Promise<void>;
}) {
  const { t } = useTranslation(["common", "user"]);
  const [books, setBooks] = useState<SavedBook[] | null>(null);
  const [error, setError] = useState("");
  const [removingIds, setRemovingIds] = useState<string[]>([]);

  useEffect(() => {
    api<{ books: SavedBook[] }>("/api/library/saved")
      .then((payload) => setBooks(payload.books))
      .catch((err) => setError(err instanceof Error ? err.message : t("user:likes.loadFailed")));
  }, []);

  const removeBook = async (bookId: string) => {
    setRemovingIds((current) => [...current, bookId]);
    setError("");
    try {
      await api(`/api/library/books/${bookId}/save`, { method: "DELETE" });
      setBooks((current) => current?.filter((book) => book.id !== bookId) ?? current);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("user:likes.unlikeFailed"));
    } finally {
      setRemovingIds((current) => current.filter((id) => id !== bookId));
    }
  };

  return (
    <DashboardShell active="user" user={user} logout={logout} sideNav={<UserAreaNav active="likes" />}>
      <section className="work-area audiobook-area">
        <div className="section-head audiobook-head">
          <div>
            <p className="eyebrow">{t("user:area.eyebrow")}</p>
            <h1>{t("common:nav.likes")}</h1>
          </div>
          {/* "items", not "books": this list is cross-type — the gallery heart puts
              photos and videos in here too (see the kind switch below). */}
          {books && books.length > 0 && (
            <span>{t("user:count.items", { count: books.length })}</span>
          )}
        </div>

        {error && <MessageBox tone="error" title={t("user:likes.errorTitle")}>{error}</MessageBox>}

        {books && books.length === 0 ? (
          <div className="empty-state library-empty">
            <Heart size={58} aria-hidden="true" />
            <h2>{t("user:likes.emptyHeading")}</h2>
            <p className="muted">{t("user:likes.empty")}</p>
          </div>
        ) : (
          <div className="audiobook-grid">
            {(books ?? []).map((book) => {
              const removing = removingIds.includes(book.id);
              const FallbackIcon = book.kind === "ebook" ? BookOpen : book.kind === "gallery" ? ImageIcon : Headphones;
              const href = book.kind === "ebook" ? `/ebooks/books/${book.id}`
                : book.kind === "gallery" ? `/gallery/assets/${book.id}`
                : `/audiobooks/books/${book.id}`;
              return (
                <article className="saved-audiobook-card" key={book.id}>
                  <button className="audiobook-card" onClick={() => navigate(href)}>
                    <div className="audiobook-cover" aria-hidden="true">
                      {book.coverUrl ? (
                        <img src={book.coverUrl} alt="" />
                      ) : (
                        <>
                          <FallbackIcon size={13} />
                          <strong>{book.title.slice(0, 2).toUpperCase()}</strong>
                        </>
                      )}
                      <MediaKindBadge kind={book.kind} overlay />
                    </div>
                    <div className="audiobook-card-body">
                      <strong>{book.title}</strong>
                      {book.kind !== "gallery" && (
                        <span>{book.authors.length > 0 ? book.authors.join(", ") : t("user:feed.unknownAuthor")}</span>
                      )}
                      {book.note && <p className="audiobook-card-note">{book.note}</p>}
                    </div>
                  </button>
                  <button
                    className="icon-button danger saved-audiobook-remove"
                    onClick={() => removeBook(book.id)}
                    disabled={removing}
                    aria-label={t("user:likes.unlikeAria", { title: book.title })}
                    title={t("user:likes.unlike")}
                  >
                    <Trash2 size={16} />
                  </button>
                </article>
              );
            })}
            {books === null && <p className="management-empty">{t("user:likes.loading")}</p>}
          </div>
        )}
      </section>
    </DashboardShell>
  );
}
