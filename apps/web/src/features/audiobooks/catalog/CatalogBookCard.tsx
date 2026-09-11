import { useTranslation } from "react-i18next";
import { Check, CheckCircle2, CheckSquare, Download, Heart, Layers, ListMusic, Play, RotateCcw, Square } from "lucide-react";
import { navigate } from "../../../router";
import { cx } from "../../../shared/cx";
import { formatDuration } from "../../../shared/utils";
import { DEFAULT_COVERS } from "../covers";
import type { AudiobookBook } from "../types";
import { CatalogAdminMenu } from "./CatalogAdminMenu";
import { useBookLike } from "./useBookLike";
import { Button } from "../../../shared/Button";

function openPlayer(bookId: string) {
  window.open(`/player/${bookId}`, "isputnik-player", "width=500,height=700,resizable=yes,scrollbars=yes");
}

// One audiobook in the desktop catalog grid: the cover (click to open, or to tick
// in select mode) with its hover actions, and the title block underneath.
export function CatalogBookCard({
  book,
  selectionMode,
  selected,
  onToggleSelect,
  canEdit,
  canDownload,
  canDelete,
  onEdit,
  onAddToCollection,
  onDelete
}: {
  book: AudiobookBook;
  selectionMode: boolean;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  canEdit: boolean;
  canDownload: boolean;
  canDelete: boolean;
  onEdit: (book: AudiobookBook) => void;
  onAddToCollection: (book: AudiobookBook) => void;
  onDelete: (book: AudiobookBook) => void;
}) {
  const { t } = useTranslation(["common", "book"]);
  const { liked, likeBusy, toggleLike, status, statusBusy, toggleFinished } = useBookLike(book);

  const activate = () => {
    if (selectionMode) onToggleSelect(book.id);
    else navigate(`/audiobooks/books/${book.id}`);
  };

  const metaParts = [
    book.durationSeconds != null ? formatDuration(book.durationSeconds) : "",
    book.seriesPosition != null ? `#${book.seriesPosition}` : ""
  ].filter(Boolean);
  const percent = Math.round((book.progress?.percentComplete ?? 0) * 100);

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
        <img src={book.coverUrl ?? DEFAULT_COVERS.audiobook} alt="" />
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
            {status === "finished" && (
              <span className="audiobook-catalog-finished" title={t("book:editions.finished")}><Check size={14} /></span>
            )}
            {status === "in_progress" && percent > 0 && (
              <>
                <span className="audiobook-catalog-pct" title={t("book:catalog.percentListenedTitle", { percent })}>
                  <Play size={9} fill="currentColor" aria-hidden="true" />{percent}%
                </span>
                <span className="audiobook-catalog-progress" aria-hidden="true">
                  <span style={{ width: `${percent}%` }} />
                </span>
              </>
            )}
            <div className="audiobook-catalog-actions" aria-label={t("book:catalog.actionsAria", { title: book.title })}>
              <div className="audiobook-catalog-action-row">
                <Button
                  variant="bare"
                  className={cx("audiobook-catalog-action", liked && "on")}
                  onClick={(event) => { event.stopPropagation(); toggleLike(); }}
                  aria-pressed={liked}
                  aria-label={liked ? t("book:detail.unlike") : t("book:detail.like")}
                  title={liked ? t("book:detail.liked") : t("book:detail.like")}
                  disabled={likeBusy}
                >
                  <Heart size={16} fill={liked ? "currentColor" : "none"} aria-hidden="true" />
                  <span>{liked ? t("book:detail.liked") : t("book:detail.like")}</span>
                </Button>
                <Button
                  variant="bare"
                  className="audiobook-catalog-action"
                  onClick={(event) => { event.stopPropagation(); void toggleFinished(); }}
                  disabled={statusBusy}
                  aria-label={status === "finished" ? t("book:catalog.markUnfinishedAria") : t("book:catalog.markFinishedAria")}
                  title={status === "finished" ? t("book:catalog.markUnfinishedAria") : t("book:catalog.markFinishedAria")}
                >
                  {status === "finished" ? <RotateCcw size={16} aria-hidden="true" /> : <CheckCircle2 size={16} aria-hidden="true" />}
                  <span>{status === "finished" ? t("book:catalog.markUnplayedLabel") : t("book:catalog.markAsPlayedLabel")}</span>
                </Button>
                {canDownload && (
                  <a
                    className="audiobook-catalog-action"
                    href={`/api/library/books/${book.id}/download`}
                    download
                    onClick={(event) => event.stopPropagation()}
                    aria-label={t("book:catalog.downloadAria", { title: book.title })}
                    title={t("book:detail.download")}
                  >
                    <Download size={16} aria-hidden="true" />
                    <span>{t("book:detail.download")}</span>
                  </a>
                )}
                <Button
                  variant="bare"
                  className="audiobook-catalog-action"
                  onClick={(event) => { event.stopPropagation(); onAddToCollection(book); }}
                  aria-label={t("book:detail.addToCollection")}
                  title={t("book:detail.addToCollection")}
                >
                  <ListMusic size={16} aria-hidden="true" />
                  <span>{t("book:detail.addToCollection")}</span>
                </Button>
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
                  <small>{book.authors.length > 0 ? book.authors.join(", ") : t("book:metadata.unknownAuthor")}</small>
                  {metaParts.length > 0 && <span>{metaParts.join(" · ")}</span>}
                </div>
                <Button
                  variant="bare"
                  className="audiobook-catalog-action primary"
                  onClick={(event) => { event.stopPropagation(); openPlayer(book.id); }}
                  aria-label={t("book:catalog.playAria", { title: book.title })}
                  title={t("book:detail.play")}
                >
                  <Play size={22} fill="currentColor" aria-hidden="true" />
                </Button>
              </div>
            </div>
          </>
        )}
      </div>

      <div className="audiobook-catalog-copy" onClick={activate}>
        <strong>{book.title}</strong>
        <small>{book.authors.length > 0 ? book.authors.join(", ") : t("book:metadata.unknownAuthor")}</small>
        {metaParts.length > 0 && <span className="audiobook-catalog-meta">{metaParts.join(" · ")}</span>}
      </div>
    </article>
  );
}
