import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { BookOpen, Check, CheckCheck, CheckCircle2, CheckSquare, ChevronDown, Compass, Download, Heart, Layers, LayoutGrid, Library, LibraryBig, ListMusic, Loader2, Mic2, MoreHorizontal, Pencil, Play, RotateCcw, Shapes, Square, Trash2, UploadCloud, UserRound, X } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { activeFilterCount, FilterButton, FilterChips, getSortOptions, type SortKey } from "./BookFilter";
import { useAudiobookCatalog, readCatalogView, writeCatalogView, getDensityOptions, type CatalogDensity, type CatalogScope } from "./useAudiobookCatalog";
import { DashboardShell } from "../../app/DashboardShell";
import { AddToCollectionModal } from "../collections/AddToCollectionModal";
import { EditMetadataModal } from "./EditMetadataModal";
import { DEFAULT_COVERS } from "./covers";
import { PeopleCombobox } from "./PeopleCombobox";
import { followRoute, navigate } from "../../router";
import { SectionNav } from "../../shared/SectionNav";
import { audiobookNavItems } from "./sectionNavItems";
import { useIsMobile } from "../../shared/useIsMobile";
import { CatalogRowMobile } from "./CatalogRowMobile";
import { listDownloads } from "../../offline/downloads";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { Button } from "../../shared/Button";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { FileUpload } from "../../shared/FileUpload";
import { formatDuration } from "../../shared/utils";
import { Field } from "../../shared/Field";
import { LibraryPageHeader } from "../../shared/LibraryPageHeader";
import { LibraryPageToolbar } from "../../shared/LibraryPageToolbar";
import { AlphabetBar } from "../../shared/AlphabetBar";
import { SortMenu } from "../../shared/SortMenu";
import { Trans, useTranslation } from "react-i18next";
import type { AudiobookBook, AudiobookBookDetail, AudiobookLibrary, CategorySummary, SeriesSummary } from "./types";


type AudiobookViewMode = "grid" | "list";

export function formatCount(value: number) {
  return new Intl.NumberFormat().format(value);
}

// The book pages' sort control. The control itself is shared/SortMenu — this is
// the audiobook-flavoured signature (SortKey, the audiobook option list) kept for
// the several pages that already call it this way.
export function AudiobookHeaderSort({
  value,
  onChange,
  options,
  ariaLabel,
  compact = false
}: {
  value: SortKey;
  onChange: (sort: SortKey) => void;
  options?: { value: SortKey; label: string }[];
  ariaLabel?: string;
  compact?: boolean;
}) {
  const { t } = useTranslation(["common", "book"]);
  return (
    <SortMenu
      value={value}
      options={options ?? getSortOptions()}
      onChange={onChange}
      ariaLabel={ariaLabel ?? t("book:catalog.sortAudiobooksAria")}
      presentation={compact ? "icon" : "inline"}
    />
  );
}

type BookStatus = "finished" | "in_progress" | "none";

function initialStatus(book: AudiobookBook): BookStatus {
  if (book.progress?.completedAt != null) return "finished";
  if ((book.progress?.percentComplete ?? 0) > 0) return "in_progress";
  return "none";
}

function openPlayer(bookId: string) {
  window.open(`/player/${bookId}`, "isputnik-player", "width=500,height=700,resizable=yes,scrollbars=yes");
}

export function CatalogAdminMenu({
  book,
  canEdit,
  canDelete,
  onEdit,
  onDelete
}: {
  book: AudiobookBook;
  canEdit: boolean;
  canDelete: boolean;
  onEdit: (book: AudiobookBook) => void;
  onDelete: (book: AudiobookBook) => void;
}) {
  const { t } = useTranslation(["common", "book"]);
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", dismiss);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", dismiss);
    };
  }, [open]);

  if (!canEdit && !canDelete) return null;

  return (
    <div
      ref={menuRef}
      className="audiobook-catalog-menu-wrap"
      onClick={(event) => event.stopPropagation()}
    >
      <button
        className="audiobook-catalog-action admin"
        type="button"
        onClick={() => setOpen((isOpen) => !isOpen)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("book:catalog.moreActionsAria", { title: book.title })}
        title={t("book:catalog.moreActionsTitle")}
      >
        <MoreHorizontal size={16} aria-hidden="true" />
        <span>{t("book:catalog.moreActionsTitle")}</span>
      </button>
      {open && (
        <div
          className="book-detail-action-menu book-progress-menu audiobook-catalog-admin-menu"
          role="menu"
          aria-label={t("book:catalog.moreActionsAria", { title: book.title })}
        >
          {canEdit && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onEdit(book);
              }}
            >
              <Pencil size={16} aria-hidden="true" />
              <span>{t("book:catalog.editDetails")}</span>
            </button>
          )}
          {canDelete && (
            <button
              type="button"
              role="menuitem"
              className="danger"
              onClick={() => {
                setOpen(false);
                onDelete(book);
              }}
            >
              <Trash2 size={16} aria-hidden="true" />
              <span>{t("book:catalog.delete")}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function CatalogBookCard({
  book,
  viewMode,
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
  viewMode: AudiobookViewMode;
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
  const [liked, setLiked] = useState(book.saved);
  const [likeBusy, setLikeBusy] = useState(false);
  const [status, setStatus] = useState<BookStatus>(() => initialStatus(book));
  const [statusBusy, setStatusBusy] = useState(false);

  // Re-seed from the server shape when the catalog refreshes.
  useEffect(() => { setLiked(book.saved); }, [book.saved]);
  useEffect(() => { setStatus(initialStatus(book)); }, [book.progress?.completedAt, book.progress?.percentComplete]);

  const activate = () => {
    if (selectionMode) onToggleSelect(book.id);
    else navigate(`/audiobooks/books/${book.id}`);
  };

  const toggleLike = async () => {
    if (likeBusy) return;
    const next = !liked;
    setLiked(next);
    setLikeBusy(true);
    try {
      if (next) await api(`/api/library/books/${book.id}/save`, { method: "PUT", body: JSON.stringify({ note: null }) });
      else await api(`/api/library/books/${book.id}/save`, { method: "DELETE" });
    } catch {
      setLiked(!next);
    } finally {
      setLikeBusy(false);
    }
  };

  const toggleFinished = async () => {
    if (statusBusy) return;
    const wasFinished = status === "finished";
    setStatus(wasFinished ? "none" : "finished");
    setStatusBusy(true);
    try {
      if (wasFinished) await api(`/api/library/books/${book.id}/progress`, { method: "DELETE" });
      else await api(`/api/library/books/${book.id}/progress/complete`, { method: "POST", body: "{}" });
    } catch {
      setStatus(initialStatus(book));
    } finally {
      setStatusBusy(false);
    }
  };

  const metaParts = [
    book.durationSeconds != null ? formatDuration(book.durationSeconds) : "",
    book.seriesPosition != null ? `#${book.seriesPosition}` : ""
  ].filter(Boolean);
  const percent = Math.round((book.progress?.percentComplete ?? 0) * 100);

  return (
    <article
      className={`audiobook-catalog-card ${viewMode}${selectionMode ? " selectable" : ""}${selected ? " selected" : ""}`}
    >
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
                <button
                  className={`audiobook-catalog-action${liked ? " on" : ""}`}
                  type="button"
                  onClick={(event) => { event.stopPropagation(); toggleLike(); }}
                  aria-pressed={liked}
                  aria-label={liked ? t("book:detail.unlike") : t("book:detail.like")}
                  title={liked ? t("book:detail.liked") : t("book:detail.like")}
                  disabled={likeBusy}
                >
                  <Heart size={16} fill={liked ? "currentColor" : "none"} aria-hidden="true" />
                  <span>{liked ? t("book:detail.liked") : t("book:detail.like")}</span>
                </button>
                <button
                  className="audiobook-catalog-action"
                  type="button"
                  onClick={(event) => { event.stopPropagation(); void toggleFinished(); }}
                  disabled={statusBusy}
                  aria-label={status === "finished" ? t("book:catalog.markUnfinishedAria") : t("book:catalog.markFinishedAria")}
                  title={status === "finished" ? t("book:catalog.markUnfinishedAria") : t("book:catalog.markFinishedAria")}
                >
                  {status === "finished" ? <RotateCcw size={16} aria-hidden="true" /> : <CheckCircle2 size={16} aria-hidden="true" />}
                  <span>{status === "finished" ? t("book:catalog.markUnplayedLabel") : t("book:catalog.markAsPlayedLabel")}</span>
                </button>
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
                  <small>{book.authors.length > 0 ? book.authors.join(", ") : t("book:metadata.unknownAuthor")}</small>
                  {metaParts.length > 0 && <span>{metaParts.join(" · ")}</span>}
                </div>
                <button
                  className="audiobook-catalog-action primary"
                  type="button"
                  onClick={(event) => { event.stopPropagation(); openPlayer(book.id); }}
                  aria-label={t("book:catalog.playAria", { title: book.title })}
                  title={t("book:detail.play")}
                >
                  <Play size={22} fill="currentColor" aria-hidden="true" />
                </button>
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

// Bottom-of-grid loader: an IntersectionObserver sentinel for infinite scroll
// plus an explicit "Load more" button as a fallback.
export function CatalogTail({
  hasMore, loadingMore, loadMore, sentinelRef
}: {
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  sentinelRef: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useTranslation(["common", "book"]);
  if (!hasMore) return null;
  return (
    <div className="audiobook-load-more" ref={sentinelRef}>
      <button className="secondary-button" type="button" onClick={loadMore} disabled={loadingMore}>
        {loadingMore ? t("book:detail.loading") : t("book:catalog.loadMore")}
      </button>
    </div>
  );
}

// Bulk-edit dialog: overwrite shared metadata across the selected books. Any
// field left blank is skipped (keeps each book's existing value); Tags replace
// the existing tags on every selected book.
export function BulkEditModal({
  count,
  categories,
  peopleSuggestions,
  tagSuggestions,
  showNarrator = true,
  onClose,
  onSubmit
}: {
  count: number;
  categories: CategorySummary[];
  peopleSuggestions: string[];
  tagSuggestions: string[];
  // Audiobooks edit narrators; ebooks have none, so that field is hidden there.
  showNarrator?: boolean;
  onClose: () => void;
  onSubmit: (fields: Record<string, unknown>) => Promise<void>;
}) {
  const { t } = useTranslation(["common", "book"]);
  const [authors, setAuthors] = useState<string[]>([]);
  const [narrators, setNarrators] = useState<string[]>([]);
  const [categoryKey, setCategoryKey] = useState("");
  const [language, setLanguage] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [description, setDescription] = useState("");
  const [tab, setTab] = useState<"details" | "tags">("details");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const payload: Record<string, unknown> = {};
    if (authors.length) payload.authors = authors;
    if (narrators.length) payload.narrators = narrators;
    if (categoryKey) payload.categoryKey = categoryKey;
    if (language.trim()) payload.language = language.trim();
    if (tags.length) payload.tags = tags;
    if (description.trim()) payload.description = description.trim();

    if (Object.keys(payload).length === 0) {
      setError(t("book:catalog.bulkNeedField"));
      return;
    }

    setSaving(true);
    setError("");
    try {
      await onSubmit(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("book:catalog.unableUpdateBooks"));
      setSaving(false);
    }
  };

  return (
    <Modal
      title={t("book:catalog.bulkEditTitle", { count })}
      className="bulk-edit-modal"
      busy={saving}
      onClose={onClose}
      onSubmit={submit}
    >
        <p className="muted">{t("book:catalog.bulkEditIntro")}</p>
        <div className="modal-tabs" role="tablist" aria-label={t("book:catalog.bulkEditSectionsAria")}>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "details"}
            className={`modal-tab${tab === "details" ? " active" : ""}`}
            onClick={() => setTab("details")}
          >
            {t("book:catalog.tabDetails")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "tags"}
            className={`modal-tab${tab === "tags" ? " active" : ""}`}
            onClick={() => setTab("tags")}
          >
            {t("book:catalog.tabTags")}
          </button>
        </div>
        <div className="modal-tab-content">
          {tab === "details" && (
            <div className="override-grid">
              <div className="field">
                <span>{t("book:catalog.fieldAuthor")}</span>
                <PeopleCombobox value={authors} onChange={setAuthors} suggestions={peopleSuggestions} placeholder={t("book:metadata.addAuthor")} />
              </div>
              {showNarrator && (
                <div className="field">
                  <span>{t("book:catalog.fieldNarrator")}</span>
                  <PeopleCombobox value={narrators} onChange={setNarrators} suggestions={peopleSuggestions} placeholder={t("book:metadata.addNarrator")} />
                </div>
              )}
              <label className="field">
                <span>{t("book:metadata.fieldCategory")}</span>
                <select value={categoryKey} onChange={(event) => setCategoryKey(event.target.value)}>
                  <option value="">{t("book:catalog.keepCurrent")}</option>
                  {categories.map((category) => (
                    <option key={category.key} value={category.key}>{category.name}</option>
                  ))}
                </select>
              </label>
              <Field label={t("book:catalog.fieldLanguageExample")} value={language} onChange={setLanguage} required={false} />
              <label className="field override-desc">
                <span>{t("book:metadata.fieldDescription")}</span>
                <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} />
              </label>
            </div>
          )}
          {tab === "tags" && (
            <div className="bulk-tags-tab">
              <div className="field">
                <span>{t("book:metadata.fieldTags")}</span>
                <PeopleCombobox value={tags} onChange={setTags} suggestions={tagSuggestions} placeholder={t("book:metadata.addTag")} />
              </div>
              <p className="muted bulk-tags-note">{t("book:catalog.bulkTagsNote")}</p>
            </div>
          )}
        </div>
        {error && <MessageBox tone="error" title={t("common:errors.unableToSave")}>{error}</MessageBox>}
        <div className="modal-actions">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {t("common:common.cancel")}
          </Button>
          <Button variant="primary" type="submit" disabled={saving}>
            {saving ? t("book:detail.saving") : t("book:catalog.overwriteButton", { count })}
          </Button>
        </div>
    </Modal>
  );
}

// Bulk "Add to series": pick an existing series in the current library or create
// a new one on the spot. Selected books are appended after the series' current
// last position (the server handles ordering).
export function AddToSeriesModal({
  libraryId,
  count,
  kind = "audiobook",
  onClose,
  onSubmit
}: {
  libraryId: string;
  count: number;
  kind?: "audiobook" | "ebook";
  onClose: () => void;
  onSubmit: (target: { seriesId: string } | { newName: string }) => Promise<void>;
}) {
  const { t } = useTranslation(["common", "book"]);
  const [series, setSeries] = useState<SeriesSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [seriesId, setSeriesId] = useState("");
  const [newName, setNewName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setLoading(true);
    api<{ series: SeriesSummary[] }>(`/api/library/${kind}-libraries/${libraryId}/series`)
      .then((payload) => {
        setSeries(payload.series);
        if (payload.series.length === 0) setMode("new");
      })
      .catch(() => setSeries([]))
      .finally(() => setLoading(false));
  }, [libraryId, kind]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const target = mode === "new"
      ? (newName.trim() ? { newName: newName.trim() } : null)
      : (seriesId ? { seriesId } : null);
    if (!target) {
      setError(mode === "new" ? t("book:catalog.enterNewSeriesNameError") : t("book:catalog.chooseSeriesError"));
      return;
    }
    setSaving(true);
    setError("");
    try {
      await onSubmit(target);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("book:catalog.unableAddToSeries"));
      setSaving(false);
    }
  };

  return (
    <Modal
      title={t("book:catalog.addToSeriesModalTitle", { count })}
      style={{ width: "min(100%, 480px)" }}
      busy={saving}
      onClose={onClose}
      onSubmit={submit}
    >
        <p className="muted">{t("book:catalog.addToSeriesIntro")}</p>

        {loading ? (
          <p className="management-empty">{t("book:catalog.loadingSeries")}</p>
        ) : (
          <>
            {series.length > 0 && (
              <div className="field" style={{ marginBottom: 12 }}>
                <span>{t("book:detail.rows.series")}</span>
                <select
                  value={mode === "existing" ? seriesId : "__new__"}
                  onChange={(event) => {
                    if (event.target.value === "__new__") {
                      setMode("new");
                    } else {
                      setMode("existing");
                      setSeriesId(event.target.value);
                    }
                  }}
                >
                  <option value="">{t("book:catalog.chooseSeriesPlaceholder")}</option>
                  {series.map((item) => (
                    <option key={item.id} value={item.id}>{item.name} ({item.bookCount})</option>
                  ))}
                  <option value="__new__">{t("book:catalog.createNewSeriesOption")}</option>
                </select>
              </div>
            )}

            {mode === "new" && (
              <div className="field" style={{ marginBottom: 12 }}>
                <span>{t("book:catalog.newSeriesNameLabel")}</span>
                <input
                  autoFocus
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                  placeholder={t("book:series.namePlaceholder")}
                />
              </div>
            )}
          </>
        )}

        {error && <MessageBox tone="error" title={t("book:catalog.unableToAddTitle")}>{error}</MessageBox>}

        <div className="modal-actions">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {t("common:common.cancel")}
          </Button>
          <Button variant="primary" type="submit" disabled={saving || loading}>
            {saving ? t("book:catalog.adding") : t("book:catalog.addToSeriesButton")}
          </Button>
        </div>
    </Modal>
  );
}

// Bulk "Group as editions": fold the selected books into one work (= editions of
// the same title). The chosen primary supplies the browse card; the rest become
// alternate editions reachable from the detail page. Selection is same-type in
// practice since you pick from one catalog.
export interface EditionCandidate {
  id: string;
  title: string;
  authors: string[];
  coverUrl: string | null;
  publisher?: string | null;
  format?: string | null;
}

export function GroupAsEditionsModal({
  books,
  kind,
  onClose,
  onSubmit
}: {
  books: EditionCandidate[];
  kind: "audiobook" | "ebook";
  onClose: () => void;
  onSubmit: (primaryItemId: string) => Promise<void>;
}) {
  const { t } = useTranslation(["common", "book"]);
  // Default the primary to the richest-looking edition: prefer one with a cover and
  // a known author, else the first with a cover, else the first selected.
  const [primaryId, setPrimaryId] = useState(() =>
    books.find((book) => book.coverUrl && book.authors.length > 0)?.id
    ?? books.find((book) => book.coverUrl)?.id
    ?? books[0]?.id
    ?? ""
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!primaryId) {
      setError(t("book:catalog.choosePrimaryError"));
      return;
    }
    setSaving(true);
    setError("");
    try {
      await onSubmit(primaryId);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("book:catalog.unableGroupEditions"));
      setSaving(false);
    }
  };

  const metaFor = (book: EditionCandidate) =>
    [book.format ? book.format.toUpperCase() : null, book.publisher].filter(Boolean).join(" · ");

  return (
    <Modal
      title={t(kind === "ebook" ? "book:catalog.groupTitleEbooks" : "book:catalog.groupTitleBooks", { count: books.length })}
      style={{ width: "min(100%, 480px)" }}
      busy={saving}
      onClose={onClose}
      onSubmit={submit}
    >
      <p className="muted">{t("book:catalog.groupIntro")}</p>
      <div className="editions-pick-list">
        {books.map((book) => {
          const meta = metaFor(book);
          const byline = book.authors.length > 0 ? book.authors.join(", ") : t("book:metadata.unknownAuthor");
          return (
            <label key={book.id} className={`editions-pick-row${primaryId === book.id ? " selected" : ""}`}>
              <input
                type="radio"
                name="primary-edition"
                checked={primaryId === book.id}
                onChange={() => setPrimaryId(book.id)}
              />
              <img src={book.coverUrl ?? DEFAULT_COVERS[kind]} alt="" />
              <span className="editions-pick-text">
                <strong>{book.title}</strong>
                <small>{meta ? `${byline} · ${meta}` : byline}</small>
              </span>
              {primaryId === book.id && <span className="editions-pick-flag">{t("book:editions.primary")}</span>}
            </label>
          );
        })}
      </div>
      {error && <MessageBox tone="error" title={t("book:catalog.unableToGroupTitle")}>{error}</MessageBox>}
      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose} disabled={saving}>
          {t("common:common.cancel")}
        </Button>
        <Button variant="primary" type="submit" disabled={saving}>
          {saving ? t("book:catalog.grouping") : t("book:catalog.groupEditionsButton", { count: books.length })}
        </Button>
      </div>
    </Modal>
  );
}

// Upload one audiobook: pick the target library (when more than one allows
// uploads), optionally name the book, then drop the audio files — or a whole
// book folder. All files of one upload become a single book; the server scans it
// immediately and the new title appears in the catalog when the modal closes.
function UploadBookModal({
  libraries,
  initialLibraryId,
  onClose,
  onUploaded
}: {
  libraries: AudiobookLibrary[];
  initialLibraryId: string;
  onClose: () => void;
  onUploaded: (book: AudiobookBookDetail | null, libraryName: string) => void;
}) {
  const { t } = useTranslation(["common", "book"]);
  const [libraryId, setLibraryId] = useState(() => (
    libraries.some((library) => library.id === initialLibraryId) ? initialLibraryId : libraries[0]?.id ?? ""
  ));
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const library = libraries.find((item) => item.id === libraryId);

  return (
    <Modal
      title={t("book:catalog.uploadAudiobookTitle")}
      className="book-upload-modal"
      busy={busy}
      onClose={onClose}
      headerAction={
        <button type="button" className="modal-close" onClick={onClose} disabled={busy} aria-label={t("common:common.close")}>
          <X size={18} aria-hidden="true" />
        </button>
      }
    >
      {libraries.length > 1 && (
        <label className="field" style={{ marginBottom: 12 }}>
          <span>{t("book:detail.rows.library")}</span>
          <select value={libraryId} onChange={(event) => setLibraryId(event.target.value)} disabled={busy}>
            {libraries.map((item) => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
          </select>
        </label>
      )}

      <label className="field" style={{ marginBottom: 12 }}>
        <span><Trans i18nKey="catalog.uploadTitleLabel" ns="book" components={{ muted: <span className="muted" /> }} /></span>
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={t("book:catalog.uploadTitlePlaceholder")}
          disabled={busy}
        />
      </label>

      {library && (
        <FileUpload
          endpoint={(batch) => {
            const folder = title.trim() || batch.folderName || "";
            return `/api/library/audiobook-libraries/${library.id}/books/upload${folder ? `?folder=${encodeURIComponent(folder)}` : ""}`;
          }}
          accept={library.uploadExtensions}
          maxBytes={library.maxUploadMB != null ? library.maxUploadMB * 1024 * 1024 : null}
          multiple
          folders
          maxFiles={500} // mirrors MAX_BOOK_UPLOAD_FILES on the server
          hint={library.maxUploadMB != null
            ? t("book:catalog.acceptedHintWithSize", { types: library.uploadExtensions.map((ext) => `.${ext}`).join(", "), mb: library.maxUploadMB })
            : t("book:catalog.acceptedHint", { types: library.uploadExtensions.map((ext) => `.${ext}`).join(", ") })}
          onUploaded={(response) => {
            const payload = response as { book?: AudiobookBookDetail };
            onUploaded(payload.book ?? null, library.name);
          }}
          onBusyChange={setBusy}
        />
      )}

    </Modal>
  );
}

export function AudiobooksPage({
  user,
  logout
}: {
  user: PublicUser;
  logout: () => Promise<void>;
}) {
  const { t } = useTranslation(["common", "book"]);
  const [libraries, setLibraries] = useState<AudiobookLibrary[]>([]);
  // Derived, not chosen: exactly one library in the filter behaves as a scope,
  // anything else is "all". Keeps one source of truth for what's in view.
  const [selectedLibraryId, setSelectedLibraryId] = useState("all");
  const [sort, setSort] = useState<SortKey>("recent");
  const [librariesError, setLibrariesError] = useState("");
  const viewMode: AudiobookViewMode = "grid";
  const [density, setDensity] = useState<CatalogDensity>(() => readCatalogView("audiobooks:main").density);
  // Mobile-only "Browse" dropdown that collapses the Authors / Narrators / Series tabs.
  const [browseOpen, setBrowseOpen] = useState(false);
  const [browsePos, setBrowsePos] = useState<{ top: number; left: number | null; right: number | null } | null>(null);
  const browseTriggerRef = useRef<HTMLButtonElement>(null);
  const browseMenuRef = useRef<HTMLDivElement>(null);

  // Multi-select bulk editing (admins / library owners only).
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [seriesModalOpen, setSeriesModalOpen] = useState(false);
  const [editionsModalOpen, setEditionsModalOpen] = useState(false);
  const [categories, setCategories] = useState<CategorySummary[]>([]);
  const [bulkNotice, setBulkNotice] = useState("");
  // Per-tile actions that need page-level UI.
  const [collectionBook, setCollectionBook] = useState<AudiobookBook | null>(null);
  // The full metadata editor needs the book detail shape; fetch it on demand
  // when a tile's "Edit metadata" is chosen.
  const [editDetail, setEditDetail] = useState<AudiobookBookDetail | null>(null);
  const [editLoadError, setEditLoadError] = useState("");
  // Source-writing actions (policy-gated): upload new books, delete existing ones.
  const [uploadOpen, setUploadOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AudiobookBook | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  // Mobile / PWA: render the catalog as homepage-style rows (with a live download
  // banner + toast) instead of the desktop card grid. Desktop is untouched.
  const isMobile = useIsMobile();
  const [downloadedIds, setDownloadedIds] = useState<Set<string>>(new Set());
  const [activeDownload, setActiveDownload] = useState<{ title: string; progress: number } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = (message: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = setTimeout(() => setToast(null), 2500);
  };

  const handleDownloaded = (id: string) => setDownloadedIds((prev) => new Set([...prev, id]));

  useEffect(() => {
    if (!isMobile) return;
    let alive = true;
    listDownloads().then((downloads) => {
      if (alive) setDownloadedIds(new Set(downloads.map((d) => d.bookId)));
    }).catch(() => {});
    return () => { alive = false; };
  }, [isMobile]);

  // Which shelves the list is drawn from is a filter now, like every other way of
  // narrowing it — there is no scope picker of its own. One library chosen still
  // resolves to the library-scoped query, so the facets and the A–Z letters stay
  // honest to what is actually on screen; anything else is the whole catalog.
  const scope: CatalogScope = selectedLibraryId === "all"
    ? { kind: "all" }
    : { kind: "library", libraryId: selectedLibraryId };
  const cat = useAudiobookCatalog(scope, sort, "audiobooks:main");

  // One library in the filter is a scope; none or several is the whole catalog.
  // Following it here (rather than deriving `scope` inline) keeps the hook's
  // filters the single source of truth without the two referring to each other.
  useEffect(() => {
    setSelectedLibraryId(cat.filters.libraries.length === 1 ? cat.filters.libraries[0] : "all");
  }, [cat.filters.libraries]);

  // The libraries the filter is narrowing to — everything accessible when it is
  // left empty.
  const scopedLibraries = cat.filters.libraries.length
    ? libraries.filter((library) => cat.filters.libraries.includes(library.id))
    : libraries;

  // Can the user edit books in what's on screen? Drives the bulk-edit controls.
  const canEditScope = scopedLibraries.some((library) => library.canWrite);

  // Libraries accepting uploads (drives the Upload button + modal choices) and
  // whether anything in view allows deleting source files.
  const uploadLibraries = libraries.filter((library) => library.canUpload);
  const canDeleteScope = scopedLibraries.some((library) => library.canDelete);

  // Existing authors/narrators in the current scope, for the bulk-edit comboboxes.
  const peopleSuggestions = Array.from(new Set([...cat.facets.authors, ...cat.facets.narrators]));

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const exitSelection = () => {
    setSelectionMode(false);
    setSelectedIds(new Set());
    setBulkOpen(false);
    setSeriesModalOpen(false);
    setEditionsModalOpen(false);
    setBulkDeleteOpen(false);
  };

  // Group the selected books into one work (editions of the same title).
  const submitGroupEditions = async (primaryItemId: string) => {
    const result = await api<{ work: { id: string }; count: number }>(
      "/api/library/works",
      { method: "POST", body: JSON.stringify({ itemIds: [...selectedIds], primaryItemId }) }
    );
    setBulkNotice(t("book:catalog.groupedEditionsNotice", { count: result.count }));
    cat.refresh();
    exitSelection();
  };

  // Series live in a single library, so bulk "Add to series" is only offered when
  // the list is down to one — which now means one library picked in Filter.
  const canAddToSeries = canEditScope && selectedLibraryId !== "all";

  const submitAddToSeries = async (target: { seriesId: string } | { newName: string }) => {
    let seriesId: string;
    if ("seriesId" in target) {
      seriesId = target.seriesId;
    } else {
      const created = await api<{ series: { id: string } }>(
        `/api/library/audiobook-libraries/${selectedLibraryId}/series`,
        { method: "POST", body: JSON.stringify({ name: target.newName }) }
      );
      seriesId = created.series.id;
    }
    const result = await api<{ added: number; skipped: number }>(
      `/api/library/series/${seriesId}/books`,
      { method: "POST", body: JSON.stringify({ bookIds: [...selectedIds] }) }
    );
    const parts = [t("book:catalog.addedToSeriesNotice", { count: result.added })];
    if (result.skipped > 0) parts.push(t("book:catalog.skippedAlreadyInSeries", { count: result.skipped }));
    setBulkNotice(parts.join(" · "));
    cat.refresh();
    exitSelection();
  };

  // Drop selection when the scope changes or selection is disallowed.
  useEffect(() => {
    exitSelection();
  }, [selectedLibraryId]);

  useEffect(() => {
    if (!canEditScope) exitSelection();
  }, [canEditScope]);

  const runBulk = async (ids: string[], fields: Record<string, unknown>) => {
    const result = await api<{ updated: number; forbidden: number; missing: number }>(
      "/api/library/books/bulk-metadata",
      { method: "POST", body: JSON.stringify({ bookIds: ids, ...fields }) }
    );
    const parts = [t("book:catalog.updatedBooksNotice", { count: result.updated })];
    if (result.forbidden > 0) parts.push(t("book:catalog.skippedNoWriteAccess", { count: result.forbidden }));
    if (result.missing > 0) parts.push(t("book:catalog.skippedNotFound", { count: result.missing }));
    setBulkNotice(parts.join(" · "));
    cat.refresh();
  };

  const submitBulk = async (fields: Record<string, unknown>) => {
    await runBulk([...selectedIds], fields);
    exitSelection();
  };

  const handleUploaded = (book: AudiobookBookDetail | null, libraryName: string) => {
    setUploadOpen(false);
    setBulkNotice(book
      ? t("book:catalog.uploadedBookNotice", { title: book.title, library: libraryName })
      : t("book:catalog.uploadCompleteNotice", { library: libraryName }));
    cat.refresh();
  };

  const confirmDeleteOne = async () => {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    setDeleteError("");
    try {
      await api(`/api/library/books/${deleteTarget.id}`, { method: "DELETE" });
      setBulkNotice(t("book:catalog.movedOneToRecycleNotice", { title: deleteTarget.title }));
      setDeleteTarget(null);
      cat.refresh();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : t("book:catalog.unableMoveAudiobookToRecycle"));
    } finally {
      setDeleteBusy(false);
    }
  };

  const confirmBulkDelete = async () => {
    setDeleteBusy(true);
    setDeleteError("");
    try {
      const result = await api<{ deleted: number; forbidden: number; missing: number; failed: number; error?: string }>(
        "/api/library/books/bulk-delete",
        { method: "POST", body: JSON.stringify({ bookIds: [...selectedIds] }) }
      );
      const parts = [t("book:catalog.movedToRecycleNotice", { count: result.deleted })];
      if (result.forbidden > 0) parts.push(t("book:catalog.skippedNoDeleteAccess", { count: result.forbidden }));
      if (result.missing > 0) parts.push(t("book:catalog.skippedNotFound", { count: result.missing }));
      if (result.failed > 0) parts.push(result.error
        ? t("book:catalog.failedWithReason", { count: result.failed, error: result.error })
        : t("book:catalog.failed", { count: result.failed }));
      setBulkNotice(parts.join(" · "));
      exitSelection();
      cat.refresh();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : t("book:catalog.unableMoveSelectedAudiobooksToRecycle"));
    } finally {
      setDeleteBusy(false);
    }
  };

  // Open the same full metadata editor used on the book detail page. The grid
  // only has the catalog shape, so fetch the detail before opening.
  const openEditDetail = async (book: AudiobookBook) => {
    setEditLoadError("");
    try {
      const payload = await api<{ book: AudiobookBookDetail }>(`/api/library/books/${book.id}`);
      setEditDetail(payload.book);
    } catch (err) {
      setEditLoadError(err instanceof Error ? err.message : t("book:catalog.unableLoadBookDetails"));
    }
  };

  useEffect(() => {
    api<{ categories: CategorySummary[] }>("/api/library/categories")
      .then((payload) => setCategories(payload.categories))
      .catch(() => setCategories([]));
  }, []);

  useEffect(() => {
    // The chosen libraries ride along in `filters`, which the hook persists.
    writeCatalogView("audiobooks:main", { sort, density });
  }, [sort, density]);

  useEffect(() => {
    api<{ libraries: AudiobookLibrary[] }>("/api/library/audiobook-libraries")
      .then((payload) => setLibraries(payload.libraries))
      .catch((err) => setLibrariesError(err instanceof Error ? err.message : t("book:catalog.unableLoadLibraries")));
  }, []);

  // While a library is scanning, refresh both the library status and the catalog
  // so new books appear without a manual reload.
  useEffect(() => {
    if (!libraries.some((library) => library.scanStatus === "scanning")) return;
    const timer = window.setInterval(() => {
      api<{ libraries: AudiobookLibrary[] }>("/api/library/audiobook-libraries")
        .then((payload) => setLibraries(payload.libraries))
        .catch(() => {});
      cat.refresh();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [libraries, cat.refresh]);

  const toggleBrowse = () => {
    setBrowseOpen((open) => {
      if (!open && browseTriggerRef.current) {
        const rect = browseTriggerRef.current.getBoundingClientRect();
        const alignRight = rect.left + 200 > window.innerWidth;
        setBrowsePos({
          top: rect.bottom + 8,
          left: alignRight ? null : rect.left,
          right: alignRight ? window.innerWidth - rect.right : null
        });
      }
      return !open;
    });
  };

  useEffect(() => {
    if (!browseOpen) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (browseTriggerRef.current?.contains(target)) return;
      if (browseMenuRef.current?.contains(target)) return;
      setBrowseOpen(false);
    };
    const dismiss = () => setBrowseOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [browseOpen]);

  // How many books the chosen shelves hold at all — the difference between "your
  // libraries are empty" and "nothing matched what you asked for".
  const selectedScopeBookCount = scopedLibraries.reduce((sum, library) => sum + library.bookCount, 0);
  const selectedLibraryLabel = scopedLibraries.length === 1 ? scopedLibraries[0].name : t("book:catalog.yourLibraries");
  const hasActiveCatalogQuery = cat.search.trim().length > 0 || activeFilterCount(cat.filters) > 0 || cat.letter != null;
  const emptyCatalogMessage = selectedScopeBookCount === 0
    ? t("book:catalog.emptyNoneInLibraryAudiobooks", { library: selectedLibraryLabel })
    : hasActiveCatalogQuery
      ? t("book:catalog.emptyNoMatchAudiobooks")
      : t("book:catalog.emptyNoneAudiobooks");
  const error = librariesError || cat.error || editLoadError;

  return (
    <DashboardShell
      active="audiobooks"
      user={user}
      logout={logout}
      sideNav={<SectionNav ariaLabel={t("common:nav.audiobooks")} groupLabel={t("common:nav.audiobooks")} items={audiobookNavItems()} activeKey="books" />}
    >
      <section className="audiobook-main-page">
        <LibraryPageHeader
          title={t("book:catalog.audiobooksTitle")}
          subtitle={`${t("book:catalog.counts.audiobook", { count: cat.total })} • ${t("book:catalog.counts.author", { count: cat.facets.authors.length })} • ${t("book:catalog.counts.narrator", { count: cat.facets.narrators.length })}`}
          search={cat.search}
          onSearchChange={cat.setSearch}
          searchPlaceholder={t("book:catalog.searchAudiobooksPlaceholder")}
          // Every control lives in the toolbar below, Upload included: the header
          // is the page's name and its search box, nothing else.
        />

        {error && <MessageBox tone="error" title={t("book:catalog.audiobooksErrorTitle")}>{error}</MessageBox>}
        {bulkNotice && <MessageBox tone="success" title={t("book:catalog.libraryUpdatedTitle")}>{bulkNotice}</MessageBox>}

        {libraries.length === 0 ? (
          <div className="empty-state library-empty">
            <BookOpen size={58} aria-hidden="true" />
            <h2>{t("book:catalog.noAudiobookLibraries")}</h2>
            {user.role === "admin" ? (
              <>
                <p className="muted">
                  {t("book:catalog.createLibraryHintAudiobooks")}
                </p>
                <a
                  className="primary-button"
                  href="/control/libraries"
                  onClick={(event) => followRoute(event, "/control/libraries")}
                >
                  <LibraryBig size={16} aria-hidden="true" />
                  {t("book:catalog.createLibrary")}
                </a>
              </>
            ) : (
              <p className="muted">{t("book:catalog.adminAddLibraries")}</p>
            )}
          </div>
        ) : (
          <>
            <LibraryPageToolbar
              // No library picker of its own: choosing shelves is one of the ways
              // this list is narrowed, so it lives in Filter with the rest. The
              // active choice reads back as a chip under the toolbar.
              scope={
                <>
                  {isMobile && (
                    <div className="audiobook-library-shortcuts">
                      <button
                        ref={browseTriggerRef}
                        type="button"
                        className="audiobook-library-tab"
                        onClick={toggleBrowse}
                        aria-haspopup="menu"
                        aria-expanded={browseOpen}
                        aria-label={t("book:catalog.browseAudiobooksAria")}
                      >
                        <Compass size={19} aria-hidden="true" />
                        <span>{t("book:catalog.browse")}</span>
                        <ChevronDown size={16} aria-hidden="true" />
                      </button>
                      {browseOpen && browsePos && createPortal(
                        <div
                          ref={browseMenuRef}
                          className="book-detail-action-menu audiobook-library-menu"
                          role="menu"
                          aria-label={t("book:catalog.browse")}
                          style={{ position: "fixed", top: browsePos.top, left: browsePos.left ?? undefined, right: browsePos.right ?? undefined }}
                        >
                          <button type="button" role="menuitem" onClick={() => { setBrowseOpen(false); navigate("/authors"); }}>
                            <UserRound size={16} aria-hidden="true" />
                            <span>{t("book:catalog.browseAuthors")}</span>
                          </button>
                          <button type="button" role="menuitem" onClick={() => { setBrowseOpen(false); navigate("/audiobooks/narrators"); }}>
                            <Mic2 size={16} aria-hidden="true" />
                            <span>{t("book:catalog.browseNarrators")}</span>
                          </button>
                          <button type="button" role="menuitem" onClick={() => { setBrowseOpen(false); navigate("/audiobooks/series"); }}>
                            <Library size={16} aria-hidden="true" />
                            <span>{t("book:catalog.browseSeries")}</span>
                          </button>
                          <button type="button" role="menuitem" onClick={() => { setBrowseOpen(false); navigate("/categories"); }}>
                            <Shapes size={16} aria-hidden="true" />
                            <span>{t("book:catalog.browseCategories")}</span>
                          </button>
                        </div>,
                        document.body
                      )}
                    </div>
                  )}
                </>
              }
              // Left to right: what narrows the list, a divider, then what acts on
              // it. Each control says what it is doing — the sort prints the order
              // it is in, the filter its count — because neither is visible in the
              // grid itself.
              tools={
                <>
                  <FilterButton
                    facets={cat.facets}
                    value={cat.filters}
                    onChange={cat.setFilters}
                    libraries={libraries}
                  />
                  <SortMenu value={sort} options={getSortOptions()} onChange={setSort} ariaLabel={t("book:catalog.sortAudiobooksAria")} presentation="labelled" />
                  {/* Desktop only: View sets the grid's tile size, and the phone
                      doesn't render the grid — it renders rows. A control that
                      can't change anything doesn't belong on that screen. */}
                  {!isMobile && (
                    <SortMenu
                      value={density}
                      options={getDensityOptions()}
                      onChange={setDensity}
                      ariaLabel={t("book:catalog.view")}
                      presentation="labelled"
                      icon={<LayoutGrid size={18} aria-hidden="true" />}
                      // The layout is on screen already; the name reads better than
                      // printing back what you can see.
                      label={t("book:catalog.view")}
                    />
                  )}
                  <span className="library-toolbar-divider" aria-hidden="true" />
                  {!isMobile && canEditScope && (
                    <button type="button" className="library-toolbar-button" onClick={() => { setSelectionMode(true); setBulkNotice(""); }}>
                      <CheckSquare size={18} aria-hidden="true" />
                      <span className="toolbar-label">{t("book:catalog.select")}</span>
                    </button>
                  )}
                  {uploadLibraries.length > 0 && (
                    <button type="button" className="library-toolbar-button primary" onClick={() => { setUploadOpen(true); setBulkNotice(""); }}>
                      <UploadCloud size={18} aria-hidden="true" />
                      <span className="toolbar-label">{t("book:catalog.upload")}</span>
                    </button>
                  )}
                </>
              }
              selection={!isMobile && selectionMode ? {
                count: selectedIds.size,
                // Labelled, like the standard row: an unlabelled trash icon is
                // exactly where hesitation costs the most.
                actions: (
                  <>
                    <button
                      type="button"
                      className="library-toolbar-button"
                      onClick={() => setSelectedIds(new Set(cat.books.map((book) => book.id)))}
                      disabled={cat.books.length === 0}
                      title={t("book:catalog.selectAllLoadedAudiobooks")}
                    >
                      <CheckCheck size={18} aria-hidden="true" />
                      <span className="toolbar-label">{t("book:catalog.all")}</span>
                    </button>
                    <button
                      type="button"
                      className="library-toolbar-button"
                      onClick={() => setBulkOpen(true)}
                      disabled={selectedIds.size === 0}
                      title={t("book:detail.editMetadata")}
                    >
                      <Pencil size={18} aria-hidden="true" />
                      <span className="toolbar-label">{t("book:catalog.edit")}</span>
                    </button>
                    <button
                      type="button"
                      className="library-toolbar-button"
                      onClick={() => setEditionsModalOpen(true)}
                      disabled={selectedIds.size < 2}
                      title={t("book:catalog.groupSelectedAudiobooksTitle")}
                    >
                      <Layers size={18} aria-hidden="true" />
                      <span className="toolbar-label">{t("book:catalog.group")}</span>
                    </button>
                    {canAddToSeries && (
                      <button
                        type="button"
                        className="library-toolbar-button"
                        onClick={() => setSeriesModalOpen(true)}
                        disabled={selectedIds.size === 0}
                        title={t("book:catalog.addToSeriesTitle")}
                      >
                        <Library size={18} aria-hidden="true" />
                        <span className="toolbar-label">{t("book:catalog.seriesShort")}</span>
                      </button>
                    )}
                    {canDeleteScope && (
                      <button
                        type="button"
                        className="library-toolbar-button danger"
                        onClick={() => { setDeleteError(""); setBulkDeleteOpen(true); }}
                        disabled={selectedIds.size === 0}
                        title={t("book:catalog.deleteSelectedAudiobooksTitle")}
                      >
                        <Trash2 size={18} aria-hidden="true" />
                        <span className="toolbar-label">{t("book:catalog.delete")}</span>
                      </button>
                    )}
                    <span className="library-toolbar-divider" aria-hidden="true" />
                    <button type="button" className="library-toolbar-button" onClick={exitSelection} title={t("book:catalog.leaveSelection")}>
                      <X size={18} aria-hidden="true" />
                      <span className="toolbar-label">{t("common:common.done")}</span>
                    </button>
                  </>
                )
              } : null}
              // Desktop only. On a phone the letters are a 30-target row nobody
              // can hit accurately, competing with the list they're meant to
              // reach — scrolling and search do that job better there.
              strip={!isMobile && (
                <AlphabetBar available={cat.facets.letters} value={cat.letter} onChange={cat.setLetter} ariaLabel={t("book:catalog.filterAudiobooksByLetterAria")} />
              )}
            />

            <FilterChips value={cat.filters} onChange={cat.setFilters} libraries={libraries} />

            {libraries.some((library) => library.scanStatus === "scanning") && (
              <MessageBox tone="info" title={t("book:catalog.scanningAudiobooksTitle")}>
                {t("book:catalog.scanningBody")}
              </MessageBox>
            )}

            {isMobile ? (
              <div className="home-feed-list">
                {cat.books.map((book) => {
                  const lib = libraries.find((library) => library.id === book.libraryId);
                  return (
                    <CatalogRowMobile
                      key={book.id}
                      book={book}
                      kind="audiobook"
                      canEdit={lib?.canWrite ?? false}
                      canDownload={lib?.canDownload ?? false}
                      canDelete={lib?.canDelete ?? false}
                      onEdit={openEditDetail}
                      onDelete={(target) => { setDeleteError(""); setDeleteTarget(target); }}
                      onAddToCollection={setCollectionBook}
                      downloaded={downloadedIds.has(book.id)}
                      onDownload={setActiveDownload}
                      onDownloaded={handleDownloaded}
                      onToast={showToast}
                    />
                  );
                })}
                {!cat.loading && cat.books.length === 0 && <p className="management-empty">{emptyCatalogMessage}</p>}
              </div>
            ) : (
              <div className={`audiobook-catalog ${viewMode} ${density}`}>
                {cat.books.map((book) => (
                  <CatalogBookCard
                    key={book.id}
                    book={book}
                    viewMode={viewMode}
                    selectionMode={selectionMode}
                    selected={selectedIds.has(book.id)}
                    onToggleSelect={toggleSelect}
                    canEdit={libraries.find((library) => library.id === book.libraryId)?.canWrite ?? false}
                    canDownload={libraries.find((library) => library.id === book.libraryId)?.canDownload ?? false}
                    canDelete={libraries.find((library) => library.id === book.libraryId)?.canDelete ?? false}
                    onEdit={openEditDetail}
                    onAddToCollection={setCollectionBook}
                    onDelete={(target) => { setDeleteError(""); setDeleteTarget(target); }}
                  />
                ))}
                {!cat.loading && cat.books.length === 0 && <p className="management-empty">{emptyCatalogMessage}</p>}
              </div>
            )}

            <CatalogTail hasMore={cat.hasMore} loadingMore={cat.loadingMore} loadMore={cat.loadMore} sentinelRef={cat.sentinelRef} />
          </>
        )}

        {bulkOpen && (
          <BulkEditModal
            count={selectedIds.size}
            categories={categories}
            peopleSuggestions={peopleSuggestions}
            tagSuggestions={cat.facets.tags}
            onClose={() => setBulkOpen(false)}
            onSubmit={submitBulk}
          />
        )}

        {seriesModalOpen && selectedLibraryId !== "all" && (
          <AddToSeriesModal
            libraryId={selectedLibraryId}
            count={selectedIds.size}
            onClose={() => setSeriesModalOpen(false)}
            onSubmit={submitAddToSeries}
          />
        )}

        {editionsModalOpen && (
          <GroupAsEditionsModal
            kind="audiobook"
            books={cat.books.filter((book) => selectedIds.has(book.id))}
            onClose={() => setEditionsModalOpen(false)}
            onSubmit={submitGroupEditions}
          />
        )}

        {uploadOpen && uploadLibraries.length > 0 && (
          <UploadBookModal
            libraries={uploadLibraries}
            initialLibraryId={selectedLibraryId}
            onClose={() => setUploadOpen(false)}
            onUploaded={handleUploaded}
          />
        )}

        {deleteTarget && (
          <ConfirmDialog
            title={t("book:catalog.deleteToRecycleBinTitle", { title: deleteTarget.title })}
            confirmLabel={t("book:detail.moveToRecycleBin")}
            busyLabel={t("book:detail.moving")}
            busy={deleteBusy}
            error={deleteError}
            onConfirm={() => void confirmDeleteOne()}
            onCancel={() => { if (!deleteBusy) setDeleteTarget(null); }}
          >
            {t("book:catalog.deleteOneAudiobookBody", { files: t("book:catalog.counts.audioFile", { count: deleteTarget.fileCount }) })}
          </ConfirmDialog>
        )}

        {bulkDeleteOpen && (
          <ConfirmDialog
            title={t("book:catalog.bulkDeleteTitleAudiobooks", { count: selectedIds.size })}
            confirmLabel={t("book:catalog.bulkDeleteButtonAudiobooks", { count: selectedIds.size })}
            busyLabel={t("book:detail.moving")}
            busy={deleteBusy}
            error={deleteError}
            onConfirm={() => void confirmBulkDelete()}
            onCancel={() => { if (!deleteBusy) setBulkDeleteOpen(false); }}
          >
            {t("book:catalog.bulkDeleteBodyAudiobooks")}
          </ConfirmDialog>
        )}

        {editDetail && (
          <EditMetadataModal
            book={editDetail}
            onBookUpdated={(updated) => { setEditDetail(updated); cat.refresh(); }}
            onClose={() => setEditDetail(null)}
          />
        )}

        {collectionBook && (
          <AddToCollectionModal
            entityType="audiobook"
            entityId={collectionBook.id}
            title={collectionBook.title}
            onClose={() => setCollectionBook(null)}
          />
        )}

        {activeDownload && createPortal(
          <div className="home-dl-banner" role="status" aria-live="polite">
            <Loader2 size={16} className="home-feed-spin" aria-hidden="true" />
            <div className="home-dl-banner-body">
              <span className="home-dl-banner-label">{t("common:home.downloadingTitle", { title: activeDownload.title })}</span>
              <span className="home-dl-banner-track">
                <span style={{ width: `${Math.round(activeDownload.progress * 100)}%` }} />
              </span>
            </div>
            <span className="home-dl-banner-pct">{Math.round(activeDownload.progress * 100)}%</span>
          </div>,
          document.body
        )}

        {toast && createPortal(
          <div className="home-toast" role="status" aria-live="polite">{toast}</div>,
          document.body
        )}
      </section>
    </DashboardShell>
  );
}
