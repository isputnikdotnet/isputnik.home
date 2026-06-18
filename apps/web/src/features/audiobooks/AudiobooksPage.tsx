import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { BookOpen, Check, CheckCircle2, CheckSquare, ChevronDown, Download, Heart, Library, ListMusic, Mic2, MoreVertical, Pencil, Play, RotateCcw, Search, Square, Trash2, UploadCloud, UserRound, X } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { activeFilterCount, FilterButton, FilterChips, SORT_OPTIONS, type SortKey } from "./BookFilter";
import { useAudiobookCatalog, readCatalogView, writeCatalogView, type CatalogScope } from "./useAudiobookCatalog";
import { DashboardShell } from "../../app/DashboardShell";
import { AddToCollectionModal } from "../collections/AddToCollectionModal";
import { EditMetadataModal } from "./EditMetadataModal";
import { PeopleCombobox } from "./PeopleCombobox";
import { navigate } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { Button } from "../../shared/Button";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { FileUpload } from "../../shared/FileUpload";
import { formatDuration } from "../../shared/utils";
import { Field } from "../../shared/Field";
import type { AudiobookBook, AudiobookBookDetail, AudiobookLibrary, CategorySummary, SeriesSummary } from "./types";


export function formatCount(value: number) {
  return new Intl.NumberFormat().format(value);
}

export function AudiobookTabs({
  active,
  includeBooks = true
}: {
  active: "books" | "authors" | "narrators" | "series";
  includeBooks?: boolean;
}) {
  const tabs = [
    { id: "books", label: "All Libraries", href: "/audiobooks", icon: BookOpen },
    { id: "authors", label: "Authors", href: "/audiobooks/authors", icon: UserRound },
    { id: "narrators", label: "Narrators", href: "/audiobooks/narrators", icon: Mic2 },
    { id: "series", label: "Series", href: "/audiobooks/series", icon: Library }
  ] as const;
  const visibleTabs = includeBooks ? tabs : tabs.filter((tab) => tab.id !== "books");

  return (
    <nav className="audiobook-page-tabs" aria-label="Audiobook views">
      {visibleTabs.map((tab) => {
        const Icon = tab.icon;
        return (
          <a
            key={tab.id}
            className={active === tab.id ? "active" : ""}
            href={tab.href}
            onClick={(event) => {
              event.preventDefault();
              navigate(tab.href);
            }}
          >
            <Icon size={19} aria-hidden="true" />
            <span>{tab.label}</span>
          </a>
        );
      })}
    </nav>
  );
}

export function AudiobookPageHeader({
  title,
  subtitle,
  search,
  onSearchChange,
  searchPlaceholder,
  actions
}: {
  title: string;
  subtitle?: string;
  search?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="audiobook-page-header">
      <div className="audiobook-page-title">
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {(onSearchChange || actions) && (
        <div className="audiobook-page-actions">
          {onSearchChange && (
            <label className="audiobook-page-search">
              <span className="sr-only">{searchPlaceholder ?? "Search audiobooks"}</span>
              <Search size={15} aria-hidden="true" />
              <input
                type="search"
                value={search ?? ""}
                onChange={(event) => onSearchChange(event.target.value)}
                placeholder={searchPlaceholder ?? "Search audiobooks..."}
              />
            </label>
          )}
          {actions}
        </div>
      )}
    </header>
  );
}

export function AudiobookHeaderSort({
  value,
  onChange,
  options = SORT_OPTIONS,
  ariaLabel = "Sort audiobooks"
}: {
  value: SortKey;
  onChange: (sort: SortKey) => void;
  options?: { value: SortKey; label: string }[];
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const currentLabel = options.find((option) => option.value === value)?.label ?? "";

  const toggle = () => {
    setOpen((isOpen) => {
      if (!isOpen && triggerRef.current) {
        const rect = triggerRef.current.getBoundingClientRect();
        setPos({ top: rect.bottom + 8, left: rect.left, width: rect.width });
      }
      return !isOpen;
    });
  };

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const dismiss = () => setOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [open]);

  return (
    <div className="audiobook-sort-control">
      <span>Sort by</span>
      <button
        ref={triggerRef}
        type="button"
        className="audiobook-sort-trigger"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        <span>{currentLabel}</span>
      </button>
      <ChevronDown size={16} aria-hidden="true" />
      {open && pos && createPortal(
        <div
          ref={menuRef}
          className="book-detail-action-menu audiobook-library-menu audiobook-sort-menu"
          role="menu"
          aria-label={ariaLabel}
          style={{ position: "fixed", top: pos.top, left: pos.left, right: "auto", minWidth: pos.width }}
        >
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="menuitem"
              className={value === option.value ? "active" : ""}
              onClick={() => { onChange(option.value); setOpen(false); }}
            >
              <span>{option.label}</span>
            </button>
          ))}
        </div>,
        document.body
      )}
    </div>
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
        aria-label={`More actions for ${book.title}`}
        title="More actions"
      >
        <MoreVertical size={16} aria-hidden="true" />
        <span>More actions</span>
      </button>
      {open && (
        <div
          className="book-detail-action-menu book-progress-menu audiobook-catalog-admin-menu"
          role="menu"
          aria-label={`More actions for ${book.title}`}
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
              <span>Edit details</span>
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
              <span>Delete</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function AudiobookCatalogRow({
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
  const [fav, setFav] = useState(book.saved);
  const [favBusy, setFavBusy] = useState(false);
  const [status, setStatus] = useState<BookStatus>(() => initialStatus(book));
  const [statusBusy, setStatusBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setFav(book.saved); }, [book.saved]);
  useEffect(() => { setStatus(initialStatus(book)); }, [book.progress?.completedAt, book.progress?.percentComplete]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node) && !menuBtnRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const dismiss = (e: KeyboardEvent) => { if (e.key === "Escape") setMenuOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", dismiss);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", dismiss); };
  }, [menuOpen]);

  const toggleMenu = () => {
    if (!menuOpen && menuBtnRef.current) {
      const rect = menuBtnRef.current.getBoundingClientRect();
      setMenuPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    }
    setMenuOpen((prev) => !prev);
  };

  const toggleFav = async () => {
    if (favBusy) return;
    const next = !fav;
    setFav(next);
    setFavBusy(true);
    try {
      if (next) await api(`/api/library/books/${book.id}/save`, { method: "PUT", body: JSON.stringify({ note: null }) });
      else await api(`/api/library/books/${book.id}/save`, { method: "DELETE" });
    } catch { setFav(!next); }
    finally { setFavBusy(false); }
  };

  const toggleFinished = async () => {
    if (statusBusy) return;
    const wasFinished = status === "finished";
    setStatus(wasFinished ? "none" : "finished");
    setStatusBusy(true);
    try {
      if (wasFinished) await api(`/api/library/books/${book.id}/progress`, { method: "DELETE" });
      else await api(`/api/library/books/${book.id}/progress/complete`, { method: "POST", body: "{}" });
    } catch { setStatus(initialStatus(book)); }
    finally { setStatusBusy(false); }
  };

  const percent = Math.round((book.progress?.percentComplete ?? 0) * 100);
  const inProgress = status === "in_progress" && percent > 0;
  const metaParts = [
    book.durationSeconds != null ? formatDuration(book.durationSeconds) : "",
    book.seriesPosition != null ? `#${book.seriesPosition}` : ""
  ].filter(Boolean);
  const byline = book.authors.length > 0 ? book.authors.join(", ") : "Unknown author";

  const activate = () => {
    if (selectionMode) onToggleSelect(book.id);
    else navigate(`/audiobooks/books/${book.id}`);
  };

  return (
    <article className={`catalog-row${selectionMode ? " selectable" : ""}${selected ? " selected" : ""}`}>
      <div
        className="catalog-row-cover"
        role="button"
        tabIndex={0}
        aria-pressed={selectionMode ? selected : undefined}
        aria-label={selectionMode ? `${selected ? "Deselect" : "Select"} ${book.title}` : `Open ${book.title}`}
        onClick={activate}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(); } }}
      >
        {book.coverUrl
          ? <img src={book.coverUrl} alt="" loading="lazy" />
          : <><BookOpen size={20} aria-hidden="true" /><strong>{book.title.slice(0, 2).toUpperCase()}</strong></>
        }
        {selectionMode && (
          <span className="catalog-row-check" aria-hidden="true">
            {selected ? <CheckSquare size={18} /> : <Square size={18} />}
          </span>
        )}
        {!selectionMode && status === "finished" && (
          <span className="catalog-row-finished" title="Finished"><Check size={10} /></span>
        )}
      </div>

      <div className="catalog-row-info" onClick={activate}>
        <strong className="catalog-row-title">{book.title}</strong>
        <small className="catalog-row-author">{byline}</small>
        {metaParts.length > 0 && <span className="catalog-row-meta">{metaParts.join(" · ")}</span>}
        {inProgress && (
          <span className="catalog-row-bar" aria-label={`${percent}% complete`}>
            <span style={{ width: `${percent}%` }} />
          </span>
        )}
      </div>

      <div className="catalog-row-actions">
        {!selectionMode && (
          <button
            type="button"
            className="catalog-row-play"
            onClick={(e) => { e.stopPropagation(); openPlayer(book.id); }}
            aria-label={`Play ${book.title}`}
            title="Play"
          >
            <Play size={14} fill="currentColor" aria-hidden="true" />
          </button>
        )}
        <button
          ref={menuBtnRef}
          type="button"
          className="catalog-row-menu"
          onClick={(e) => { e.stopPropagation(); toggleMenu(); }}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={`More options for ${book.title}`}
          title="More options"
        >
          <MoreVertical size={16} aria-hidden="true" />
        </button>
        {menuOpen && menuPos && createPortal(
          <div
            ref={menuRef}
            className="catalog-row-dropdown"
            role="menu"
            aria-label={`Options for ${book.title}`}
            style={{ position: "fixed", top: menuPos.top, right: menuPos.right }}
          >
            <button type="button" role="menuitem" className={fav ? "fav" : ""} onClick={() => { setMenuOpen(false); void toggleFav(); }} disabled={favBusy}>
              <Heart size={15} fill={fav ? "currentColor" : "none"} aria-hidden="true" />
              <span>{fav ? "Favorited" : "Add to favorites"}</span>
            </button>
            <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); void toggleFinished(); }} disabled={statusBusy}>
              {status === "finished" ? <RotateCcw size={15} aria-hidden="true" /> : <CheckCircle2 size={15} aria-hidden="true" />}
              <span>{status === "finished" ? "Mark as unplayed" : "Mark as played"}</span>
            </button>
            {canDownload && (
              <a role="menuitem" href={`/api/library/books/${book.id}/download`} download onClick={() => setMenuOpen(false)}>
                <Download size={15} aria-hidden="true" />
                <span>Download</span>
              </a>
            )}
            <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onAddToCollection(book); }}>
              <ListMusic size={15} aria-hidden="true" />
              <span>Add to collection</span>
            </button>
            <div className="catalog-row-dropdown-sep" role="separator" />
            <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); navigate(`/audiobooks/books/${book.id}`); }}>
              <BookOpen size={15} aria-hidden="true" />
              <span>View details</span>
            </button>
            {canEdit && (
              <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onEdit(book); }}>
                <Pencil size={15} aria-hidden="true" />
                <span>Edit details</span>
              </button>
            )}
            {canDelete && (
              <button type="button" role="menuitem" className="danger" onClick={() => { setMenuOpen(false); onDelete(book); }}>
                <Trash2 size={15} aria-hidden="true" />
                <span>Delete</span>
              </button>
            )}
          </div>,
          document.body
        )}
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
  if (!hasMore) return null;
  return (
    <div className="audiobook-load-more" ref={sentinelRef}>
      <button className="secondary-button" type="button" onClick={loadMore} disabled={loadingMore}>
        {loadingMore ? "Loading…" : "Load more"}
      </button>
    </div>
  );
}

// Bulk-edit dialog: overwrite shared metadata across the selected books. Any
// field left blank is skipped (keeps each book's existing value); Tags replace
// the existing tags on every selected book.
function BulkEditModal({
  count,
  categories,
  peopleSuggestions,
  tagSuggestions,
  onClose,
  onSubmit
}: {
  count: number;
  categories: CategorySummary[];
  peopleSuggestions: string[];
  tagSuggestions: string[];
  onClose: () => void;
  onSubmit: (fields: Record<string, unknown>) => Promise<void>;
}) {
  const [authors, setAuthors] = useState<string[]>([]);
  const [narrators, setNarrators] = useState<string[]>([]);
  const [categoryKey, setCategoryKey] = useState("");
  const [language, setLanguage] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [description, setDescription] = useState("");
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
      setError("Fill at least one field to overwrite.");
      return;
    }

    setSaving(true);
    setError("");
    try {
      await onSubmit(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update books");
      setSaving(false);
    }
  };

  return (
    <Modal
      title={`Edit ${count} ${count === 1 ? "book" : "books"}`}
      className="edit-library-modal"
      busy={saving}
      onClose={onClose}
      onSubmit={submit}
    >
        <p className="muted">Overwrites scanned metadata for every selected book. Leave a field blank to keep each book's current value. Tags replace existing tags.</p>
        <div className="override-grid">
          <div className="field">
            <span>Author</span>
            <PeopleCombobox value={authors} onChange={setAuthors} suggestions={peopleSuggestions} placeholder="Add author…" />
          </div>
          <div className="field">
            <span>Narrator</span>
            <PeopleCombobox value={narrators} onChange={setNarrators} suggestions={peopleSuggestions} placeholder="Add narrator…" />
          </div>
          <label className="field">
            <span>Category</span>
            <select value={categoryKey} onChange={(event) => setCategoryKey(event.target.value)}>
              <option value="">Keep current</option>
              {categories.map((category) => (
                <option key={category.key} value={category.key}>{category.name}</option>
              ))}
            </select>
          </label>
          <Field label="Language (e.g. en)" value={language} onChange={setLanguage} required={false} />
          <div className="field">
            <span>Tags <span className="muted">(replace existing)</span></span>
            <PeopleCombobox value={tags} onChange={setTags} suggestions={tagSuggestions} placeholder="Add tag…" />
          </div>
          <label className="field override-desc">
            <span>Description</span>
            <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} />
          </label>
        </div>
        {error && <MessageBox tone="error" title="Unable to save">{error}</MessageBox>}
        <div className="modal-actions">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={saving}>
            {saving ? "Saving…" : `Overwrite ${count} ${count === 1 ? "book" : "books"}`}
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
      setError(mode === "new" ? "Enter a name for the new series." : "Choose a series.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await onSubmit(target);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to add to series");
      setSaving(false);
    }
  };

  return (
    <Modal
      title={`Add ${count} ${count === 1 ? "book" : "books"} to series`}
      style={{ width: "min(100%, 480px)" }}
      busy={saving}
      onClose={onClose}
      onSubmit={submit}
    >
        <p className="muted">Selected books are appended to the end of the series. You can fine-tune the order afterwards on the series page.</p>

        {loading ? (
          <p className="management-empty">Loading series…</p>
        ) : (
          <>
            {series.length > 0 && (
              <div className="field" style={{ marginBottom: 12 }}>
                <span>Series</span>
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
                  <option value="">Choose a series…</option>
                  {series.map((item) => (
                    <option key={item.id} value={item.id}>{item.name} ({item.bookCount})</option>
                  ))}
                  <option value="__new__">+ Create new series…</option>
                </select>
              </div>
            )}

            {mode === "new" && (
              <div className="field" style={{ marginBottom: 12 }}>
                <span>New series name</span>
                <input
                  autoFocus
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                  placeholder="e.g. The Stormlight Archive"
                />
              </div>
            )}
          </>
        )}

        {error && <MessageBox tone="error" title="Unable to add">{error}</MessageBox>}

        <div className="modal-actions">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={saving || loading}>
            {saving ? "Adding…" : "Add to series"}
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
  const [libraryId, setLibraryId] = useState(() => (
    libraries.some((library) => library.id === initialLibraryId) ? initialLibraryId : libraries[0]?.id ?? ""
  ));
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const library = libraries.find((item) => item.id === libraryId);

  return (
    <Modal title="Upload audiobook" className="book-upload-modal" busy={busy} onClose={onClose}>
      <p className="muted">All files in one upload become a single audiobook (multi-part books: drop every track together, or the whole book folder). The book is scanned and appears in the catalog right away.</p>

      {libraries.length > 1 && (
        <label className="field" style={{ marginBottom: 12 }}>
          <span>Library</span>
          <select value={libraryId} onChange={(event) => setLibraryId(event.target.value)} disabled={busy}>
            {libraries.map((item) => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
          </select>
        </label>
      )}

      <label className="field" style={{ marginBottom: 12 }}>
        <span>Title <span className="muted">(leave blank to use the file or folder name)</span></span>
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="e.g. The Martian"
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
          hint={`Accepted: ${library.uploadExtensions.map((ext) => `.${ext}`).join(", ")}${library.maxUploadMB != null ? ` · up to ${library.maxUploadMB} MB per file` : ""}`}
          onUploaded={(response) => {
            const payload = response as { book?: AudiobookBookDetail };
            onUploaded(payload.book ?? null, library.name);
          }}
          onBusyChange={setBusy}
        />
      )}

      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          Close
        </Button>
      </div>
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
  const [libraries, setLibraries] = useState<AudiobookLibrary[]>([]);
  const [selectedLibraryId, setSelectedLibraryId] = useState(() => readCatalogView("audiobooks:main").selectedLibraryId);
  const [sort, setSort] = useState<SortKey>("recent");
  const [librariesError, setLibrariesError] = useState("");

  // Multi-select bulk editing (admins / library owners only).
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [seriesModalOpen, setSeriesModalOpen] = useState(false);
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

  const scope: CatalogScope = selectedLibraryId === "all" ? { kind: "all" } : { kind: "library", libraryId: selectedLibraryId };
  const cat = useAudiobookCatalog(scope, sort, "audiobooks:main");

  // Can the user edit books in the current scope? Drives the bulk-edit controls.
  const canEditScope = selectedLibraryId === "all"
    ? libraries.some((library) => library.canWrite)
    : libraries.find((library) => library.id === selectedLibraryId)?.canWrite ?? false;

  // Libraries accepting uploads (drives the Upload button + modal choices) and
  // whether anything in the current scope allows deleting source files.
  const uploadLibraries = libraries.filter((library) => library.canUpload);
  const canDeleteScope = selectedLibraryId === "all"
    ? libraries.some((library) => library.canDelete)
    : libraries.find((library) => library.id === selectedLibraryId)?.canDelete ?? false;

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
    setBulkDeleteOpen(false);
  };

  // Series live in a single library, so bulk "Add to series" is only offered
  // when the catalog is scoped to one library (not the "All Libraries" view).
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
    const parts = [`Added ${result.added} ${result.added === 1 ? "book" : "books"} to series`];
    if (result.skipped > 0) parts.push(`${result.skipped} already in series or skipped`);
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
    const parts = [`Updated ${result.updated} ${result.updated === 1 ? "book" : "books"}`];
    if (result.forbidden > 0) parts.push(`${result.forbidden} skipped (no write access)`);
    if (result.missing > 0) parts.push(`${result.missing} not found`);
    setBulkNotice(parts.join(" · "));
    cat.refresh();
  };

  const submitBulk = async (fields: Record<string, unknown>) => {
    await runBulk([...selectedIds], fields);
    exitSelection();
  };

  const handleUploaded = (book: AudiobookBookDetail | null, libraryName: string) => {
    setUploadOpen(false);
    setBulkNotice(book ? `Uploaded "${book.title}" to ${libraryName}` : `Upload to ${libraryName} complete`);
    cat.refresh();
  };

  const confirmDeleteOne = async () => {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    setDeleteError("");
    try {
      await api(`/api/library/books/${deleteTarget.id}`, { method: "DELETE" });
      setBulkNotice(`Moved "${deleteTarget.title}" to the Recycle Bin`);
      setDeleteTarget(null);
      cat.refresh();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Unable to move the audiobook to the Recycle Bin");
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
      const parts = [`Moved ${result.deleted} ${result.deleted === 1 ? "book" : "books"} to the Recycle Bin`];
      if (result.forbidden > 0) parts.push(`${result.forbidden} skipped (no delete access)`);
      if (result.missing > 0) parts.push(`${result.missing} not found`);
      if (result.failed > 0) parts.push(`${result.failed} failed${result.error ? ` (${result.error})` : ""}`);
      setBulkNotice(parts.join(" · "));
      exitSelection();
      cat.refresh();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Unable to move the selected books to the Recycle Bin");
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
      setEditLoadError(err instanceof Error ? err.message : "Unable to load book details");
    }
  };

  useEffect(() => {
    api<{ categories: CategorySummary[] }>("/api/library/categories")
      .then((payload) => setCategories(payload.categories))
      .catch(() => setCategories([]));
  }, []);

  useEffect(() => {
    writeCatalogView("audiobooks:main", { selectedLibraryId, sort });
  }, [selectedLibraryId, sort]);

  useEffect(() => {
    api<{ libraries: AudiobookLibrary[] }>("/api/library/audiobook-libraries")
      .then((payload) => setLibraries(payload.libraries))
      .catch((err) => setLibrariesError(err instanceof Error ? err.message : "Unable to load libraries"));
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


  const selectedLibrary = selectedLibraryId === "all"
    ? null
    : libraries.find((library) => library.id === selectedLibraryId) ?? null;
  const selectedLibraryLabel = selectedLibraryId === "all"
    ? "All Libraries"
    : selectedLibrary?.name ?? "All Libraries";
  const selectedScopeBookCount = selectedLibraryId === "all"
    ? libraries.reduce((sum, library) => sum + library.bookCount, 0)
    : selectedLibrary?.bookCount ?? 0;
  const hasActiveCatalogQuery = cat.search.trim().length > 0 || activeFilterCount(cat.filters) > 0;
  const emptyCatalogMessage = selectedScopeBookCount === 0
    ? selectedLibraryId === "all"
      ? "No audiobooks in your libraries yet."
      : `No audiobooks in ${selectedLibraryLabel} yet.`
    : hasActiveCatalogQuery
      ? "No audiobooks match this search or filter."
      : "No audiobooks to show.";
  const error = librariesError || cat.error || editLoadError;

  return (
    <DashboardShell active="audiobooks" user={user} logout={logout}>
      <section className="audiobook-main-page">
        <AudiobookPageHeader
          title="Audiobooks"
          subtitle={`${formatCount(cat.total)} audiobooks • ${formatCount(cat.facets.authors.length)} authors • ${formatCount(cat.facets.narrators.length)} narrators`}
          search={cat.search}
          onSearchChange={cat.setSearch}
          searchPlaceholder="Search audiobooks..."
          actions={
            <>
              <FilterButton facets={cat.facets} value={cat.filters} onChange={cat.setFilters} />
              <AudiobookHeaderSort value={sort} onChange={setSort} />
              {uploadLibraries.length > 0 && !selectionMode && (
                <button type="button" className="secondary-button" onClick={() => { setUploadOpen(true); setBulkNotice(""); }}>
                  <UploadCloud size={17} aria-hidden="true" />
                  <span>Upload</span>
                </button>
              )}
            </>
          }
        />

        {error && <MessageBox tone="error" title="Audiobooks error">{error}</MessageBox>}
        {bulkNotice && <MessageBox tone="success" title="Library updated">{bulkNotice}</MessageBox>}

        {libraries.length === 0 ? (
          <div className="empty-state library-empty">
            <BookOpen size={58} aria-hidden="true" />
            <h2>No audiobook libraries yet</h2>
            <p className="muted">An administrator can add libraries from the control panel.</p>
          </div>
        ) : (
          <>
            <div className="audiobook-page-nav-row audiobook-main-nav-row">
              <div className="audiobook-page-tabs-with-library">
                <div className="audiobook-library-shortcuts" role="tablist" aria-label="Select library">
                  <button
                    type="button"
                    role="tab"
                    className={`audiobook-library-tab${selectedLibraryId === "all" ? " active" : ""}`}
                    aria-selected={selectedLibraryId === "all"}
                    onClick={() => setSelectedLibraryId("all")}
                  >
                    <span>All</span>
                  </button>
                  {libraries.map((library) => (
                    <button
                      key={library.id}
                      type="button"
                      role="tab"
                      className={`audiobook-library-tab${selectedLibraryId === library.id ? " active" : ""}`}
                      aria-selected={selectedLibraryId === library.id}
                      onClick={() => setSelectedLibraryId(library.id)}
                    >
                      <span>{library.name}</span>
                    </button>
                  ))}
                </div>
                <AudiobookTabs active="books" includeBooks={false} />
              </div>
            </div>

            {selectionMode && (
              <div className="audiobook-bulk-bar">
                <span className="audiobook-bulk-count">{selectedIds.size} selected</span>
                <div className="row-actions">
                  <button
                    type="button"
                    className="secondary-button compact-button"
                    onClick={() => setSelectedIds(new Set(cat.books.map((book) => book.id)))}
                    disabled={cat.books.length === 0}
                  >
                    Select all loaded
                  </button>
                  <button
                    type="button"
                    className="primary-button compact-button"
                    onClick={() => setBulkOpen(true)}
                    disabled={selectedIds.size === 0}
                  >
                    Edit metadata
                  </button>
                  {canAddToSeries && (
                    <button
                      type="button"
                      className="primary-button compact-button accent-mint"
                      onClick={() => setSeriesModalOpen(true)}
                      disabled={selectedIds.size === 0}
                    >
                      <Library size={15} aria-hidden="true" /> Add to series
                    </button>
                  )}
                  {canDeleteScope && (
                    <button
                      type="button"
                      className="danger-button compact-button"
                      onClick={() => { setDeleteError(""); setBulkDeleteOpen(true); }}
                      disabled={selectedIds.size === 0}
                    >
                      <Trash2 size={15} aria-hidden="true" /> Delete
                    </button>
                  )}
                  <button type="button" className="icon-button" onClick={exitSelection} aria-label="Cancel selection">
                    <X size={16} aria-hidden="true" />
                  </button>
                </div>
              </div>
            )}

            <FilterChips value={cat.filters} onChange={cat.setFilters} />

            {libraries.some((library) => library.scanStatus === "scanning") && (
              <MessageBox tone="info" title="Scanning audiobooks">
                New metadata and covers will appear as the scan finishes.
              </MessageBox>
            )}

            <div className="audiobook-catalog-list">
              {cat.books.map((book) => (
                <AudiobookCatalogRow
                  key={book.id}
                  book={book}
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
            title={`Move "${deleteTarget.title}" to the Recycle Bin?`}
            confirmLabel="Move to Recycle Bin"
            busyLabel="Moving…"
            busy={deleteBusy}
            error={deleteError}
            onConfirm={() => void confirmDeleteOne()}
            onCancel={() => { if (!deleteBusy) setDeleteTarget(null); }}
          >
            Its {deleteTarget.fileCount === 1 ? "audio file" : `${formatCount(deleteTarget.fileCount)} audio files`} move
            into the Recycle Bin and the book leaves the library for everyone (any shares stop working). You can restore
            it from the Recycle Bin, or delete it permanently from there.
          </ConfirmDialog>
        )}

        {bulkDeleteOpen && (
          <ConfirmDialog
            title={`Move ${formatCount(selectedIds.size)} ${selectedIds.size === 1 ? "book" : "books"} to the Recycle Bin?`}
            confirmLabel={`Move ${formatCount(selectedIds.size)} ${selectedIds.size === 1 ? "book" : "books"}`}
            busyLabel="Moving…"
            busy={deleteBusy}
            error={deleteError}
            onConfirm={() => void confirmBulkDelete()}
            onCancel={() => { if (!deleteBusy) setBulkDeleteOpen(false); }}
          >
            The selected books move into the Recycle Bin and leave the library for everyone. Books you lack delete
            access to are skipped. You can restore them from the Recycle Bin anytime.
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
      </section>
    </DashboardShell>
  );
}
