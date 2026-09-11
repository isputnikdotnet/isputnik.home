import { useTranslation } from "react-i18next";
import { BookOpen, Check, CheckCircle2, CheckSquare, Download, Heart, Layers, ListMusic, RotateCcw, Square } from "lucide-react";
import { navigate } from "../../../router";
import { cx } from "../../../shared/cx";
import { formatBytes } from "../../../shared/utils";
import { DEFAULT_COVERS } from "../covers";
import type { AudiobookBook } from "../types";
import type { EbookBook } from "./catalogKinds";
import { CatalogAdminMenu } from "./CatalogAdminMenu";
import { useBookLike } from "./useBookLike";

// One ebook in the desktop catalog grid. The audiobook card's shape, with formats
// and size where an audiobook shows its length, and Read where it has Play.
export function EbookCatalogCard({
  book,
  selectionMode,
  selected,
  onToggleSelect,
  canDownload,
  canEdit,
  canDelete,
  onEdit,
  onAddToCollection,
  onDelete,
  onRead
}: {
  book: EbookBook;
  selectionMode: boolean;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  canDownload: boolean;
  canEdit: boolean;
  canDelete: boolean;
  onEdit: (book: AudiobookBook) => void;
  onAddToCollection: (book: EbookBook) => void;
  onDelete: (book: AudiobookBook) => void;
  onRead: (book: EbookBook) => void;
}) {
  const { t } = useTranslation(["common", "book"]);
  const { liked, likeBusy, toggleLike, status, statusBusy, toggleFinished } = useBookLike(book, "reading");

  const activate = () => {
    if (selectionMode) onToggleSelect(book.id);
    else navigate(`/ebooks/books/${book.id}`);
  };

  const percent = Math.round((book.progress?.percentComplete ?? 0) * 100);
  const finished = status === "finished";
  const inProgress = status === "in_progress" && percent > 0;

  const formatLabel = book.formats && book.formats.length > 0
    ? book.formats.map((fmt) => fmt.toUpperCase()).join(" · ")
    : book.format ? book.format.toUpperCase() : t("common:mediaKind.ebook").toUpperCase();
  const metaParts = [
    formatLabel,
    book.totalSize ? formatBytes(book.totalSize) : ""
  ].filter(Boolean);
  const byline = book.authors.length > 0 ? book.authors.join(", ") : t("book:metadata.unknownAuthor");

  return (
    <article className={cx("audiobook-catalog-card", "grid", selectionMode && "selectable", selected && "selected")}>
      <div
        className="audiobook-catalog-cover"
        role="button"
        tabIndex={0}
        aria-pressed={selectionMode ? selected : undefined}
        aria-label={selectionMode ? t("book:catalog.selectAria", { title: book.title }) : t("book:catalog.openAria", { title: book.title })}
        onClick={activate}
        onKeyDown={(event) => {
          if (event.currentTarget !== event.target) return;
          if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(); }
        }}
      >
        <img src={book.coverUrl ?? DEFAULT_COVERS.ebook} alt="" />
        {book.editionCount > 1 && (
          <span className="audiobook-catalog-editions" title={t("book:catalog.counts.edition", { count: book.editionCount })}>
            <Layers size={11} aria-hidden="true" />{book.editionCount}
          </span>
        )}
        {selectionMode ? (
          <span className="audiobook-catalog-check" aria-hidden="true">
            {selected ? <CheckSquare size={20} /> : <Square size={20} />}
          </span>
        ) : (
          <>
            {finished && (
              <span className="audiobook-catalog-finished" title={t("book:editions.finished")}><Check size={14} /></span>
            )}
            {inProgress && (
              <>
                <span className="audiobook-catalog-pct" title={t("book:catalog.percentReadTitle", { percent })}>
                  <BookOpen size={9} aria-hidden="true" />{percent}%
                </span>
                <span className="audiobook-catalog-progress" aria-hidden="true">
                  <span style={{ width: `${percent}%` }} />
                </span>
              </>
            )}
            <div className="audiobook-catalog-actions" aria-label={t("book:catalog.actionsAria", { title: book.title })}>
              <div className="audiobook-catalog-action-row">
                <button
                  className={cx("audiobook-catalog-action", liked && "on")}
                  type="button"
                  onClick={(event) => { event.stopPropagation(); void toggleLike(); }}
                  aria-pressed={liked}
                  aria-label={liked ? t("book:detail.unlike") : t("book:detail.like")}
                  title={liked ? t("book:detail.liked") : t("book:detail.like")}
                  disabled={likeBusy}
                >
                  <Heart size={16} fill={liked ? "currentColor" : "none"} aria-hidden="true" />
                  <span>{liked ? t("book:detail.liked") : t("book:detail.like")}</span>
                </button>
                {book.documentId && (
                  <button
                    className="audiobook-catalog-action"
                    type="button"
                    onClick={(event) => { event.stopPropagation(); void toggleFinished(); }}
                    disabled={statusBusy}
                    aria-label={finished ? t("book:catalog.markAsUnreadAria") : t("book:catalog.markAsReadAria")}
                    title={finished ? t("book:catalog.markAsUnreadAria") : t("book:catalog.markAsReadAria")}
                  >
                    {finished ? <RotateCcw size={16} aria-hidden="true" /> : <CheckCircle2 size={16} aria-hidden="true" />}
                    <span>{finished ? t("book:catalog.markUnreadLabel") : t("book:catalog.markAsReadLabel")}</span>
                  </button>
                )}
                {canDownload && book.documentId && (
                  <a
                    className="audiobook-catalog-action"
                    href={`/api/library/books/${book.id}/documents/${book.documentId}?download`}
                    download
                    onClick={(event) => event.stopPropagation()}
                    aria-label={t("book:catalog.downloadAria", { title: book.title })}
                    title={t("book:detail.download")}
                  >
                    <Download size={16} aria-hidden="true" />
                    <span>{t("book:detail.download")}</span>
                  </a>
                )}
                <button
                  className="audiobook-catalog-action"
                  type="button"
                  onClick={(event) => { event.stopPropagation(); onAddToCollection(book); }}
                  aria-label={t("book:detail.addToCollection")}
                  title={t("book:detail.addToCollection")}
                >
                  <ListMusic size={16} aria-hidden="true" />
                  <span>{t("book:detail.addToCollection")}</span>
                </button>
                <CatalogAdminMenu
                  book={book}
                  canEdit={canEdit}
                  canDelete={canDelete}
                  onEdit={onEdit}
                  onDelete={onDelete}
                />
              </div>
              <div className="audiobook-catalog-hover-info">
                <div className="audiobook-catalog-hover-text">
                  <strong>{book.title}</strong>
                  <small>{byline}</small>
                  {metaParts.length > 0 && <span>{metaParts.join(" · ")}</span>}
                </div>
                <button
                  className="audiobook-catalog-action primary"
                  type="button"
                  onClick={(event) => { event.stopPropagation(); onRead(book); }}
                  aria-label={t("book:catalog.readAria", { title: book.title })}
                  title={t("book:detail.read")}
                >
                  <BookOpen size={22} aria-hidden="true" />
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      <div className="audiobook-catalog-copy" onClick={activate}>
        <strong>{book.title}</strong>
        <small>{byline}</small>
        {metaParts.length > 0 && <span className="audiobook-catalog-meta">{metaParts.join(" · ")}</span>}
      </div>
    </article>
  );
}
