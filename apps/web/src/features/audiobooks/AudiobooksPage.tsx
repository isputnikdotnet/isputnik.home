import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { BookOpen, Check, CheckCircle2, CheckSquare, ChevronDown, Download, Heart, Library, Mic2, MoreVertical, Pencil, Play, RotateCcw, Search, Share2, Square, UserRound, X } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { FilterButton, FilterChips, SORT_OPTIONS, type SortKey } from "./BookFilter";
import { useAudiobookCatalog, readCatalogView, writeCatalogView, type CatalogScope } from "./useAudiobookCatalog";
import { DashboardShell } from "../../app/DashboardShell";
import { ShareModal } from "../share/ShareModal";
import { PeopleCombobox } from "./PeopleCombobox";
import { navigate } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import { formatDuration } from "../../shared/utils";
import { Field } from "../../shared/Field";
import type { AudiobookBook, AudiobookLibrary, CategorySummary } from "./types";


type AudiobookViewMode = "grid" | "list";

export function formatCount(value: number) {
  return new Intl.NumberFormat().format(value);
}

export function AudiobookTabs({
  active,
  includeBooks = true
}: {
  active: "books" | "authors" | "narrators" | "series" | "categories";
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
              <Search size={22} aria-hidden="true" />
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

function AudiobookHeaderSort({ value, onChange }: { value: SortKey; onChange: (sort: SortKey) => void }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const currentLabel = SORT_OPTIONS.find((option) => option.value === value)?.label ?? "";

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
        aria-label="Sort audiobooks"
      >
        <span>{currentLabel}</span>
      </button>
      <ChevronDown size={16} aria-hidden="true" />
      {open && pos && createPortal(
        <div
          ref={menuRef}
          className="book-detail-action-menu audiobook-library-menu audiobook-sort-menu"
          role="menu"
          aria-label="Sort audiobooks"
          style={{ position: "fixed", top: pos.top, left: pos.left, right: "auto", minWidth: pos.width }}
        >
          {SORT_OPTIONS.map((option) => (
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
  if (book.progress?.completedAt != null || (book.progress?.percentComplete ?? 0) >= 0.98) return "finished";
  if ((book.progress?.percentComplete ?? 0) > 0) return "in_progress";
  return "none";
}

function openPlayer(bookId: string) {
  window.open(`/player/${bookId}`, "isputnik-player", "width=500,height=700,resizable=yes,scrollbars=yes");
}

function CatalogBookCard({
  book,
  viewMode,
  selectionMode,
  selected,
  onToggleSelect,
  canEdit,
  onShare,
  onEdit
}: {
  book: AudiobookBook;
  viewMode: AudiobookViewMode;
  selectionMode: boolean;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  canEdit: boolean;
  onShare: (book: AudiobookBook) => void;
  onEdit: (book: AudiobookBook) => void;
}) {
  const [fav, setFav] = useState(book.saved);
  const [favBusy, setFavBusy] = useState(false);
  const [status, setStatus] = useState<BookStatus>(() => initialStatus(book));
  const [statusBusy, setStatusBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLElement>(null);

  // Re-seed from the server shape when the catalog refreshes.
  useEffect(() => { setFav(book.saved); }, [book.saved]);
  useEffect(() => { setStatus(initialStatus(book)); }, [book.progress?.completedAt, book.progress?.percentComplete]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menuOpen]);

  const activate = () => {
    if (selectionMode) onToggleSelect(book.id);
    else navigate(`/audiobooks/books/${book.id}`);
  };

  const toggleFav = async () => {
    if (favBusy) return;
    const next = !fav;
    setFav(next);
    setFavBusy(true);
    try {
      if (next) await api(`/api/library/books/${book.id}/save`, { method: "PUT", body: JSON.stringify({ note: null }) });
      else await api(`/api/library/books/${book.id}/save`, { method: "DELETE" });
    } catch {
      setFav(!next);
    } finally {
      setFavBusy(false);
    }
  };

  const toggleFinished = async () => {
    setMenuOpen(false);
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
      ref={rootRef}
      className={`audiobook-catalog-card ${viewMode}${selectionMode ? " selectable" : ""}${selected ? " selected" : ""}${menuOpen ? " menu-open" : ""}`}
    >
      <div
        className="audiobook-catalog-cover"
        role="button"
        tabIndex={0}
        aria-pressed={selectionMode ? selected : undefined}
        aria-label={selectionMode ? `Select ${book.title}` : `Open ${book.title}`}
        onClick={activate}
        onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(); } }}
      >
        {book.coverUrl ? (
          <img src={book.coverUrl} alt="" />
        ) : (
          <>
            <BookOpen size={34} aria-hidden="true" />
            <strong>{book.title.slice(0, 2).toUpperCase()}</strong>
          </>
        )}
        {selectionMode ? (
          <span className="audiobook-catalog-check" aria-hidden="true">
            {selected ? <CheckSquare size={20} /> : <Square size={20} />}
          </span>
        ) : (
          <>
            {status === "finished" && (
              <span className="audiobook-catalog-finished" title="Finished"><Check size={14} /></span>
            )}
            {status === "in_progress" && percent > 0 && (
              <span className="audiobook-catalog-progress"><i style={{ width: `${percent}%` }} /></span>
            )}
            <button
              className={`audiobook-catalog-fav${fav ? " on" : ""}`}
              type="button"
              onClick={(event) => { event.stopPropagation(); toggleFav(); }}
              aria-pressed={fav}
              aria-label={fav ? "Remove from favorites" : "Add to favorites"}
              title={fav ? "Favorited" : "Add to favorites"}
            >
              <Heart size={16} fill={fav ? "currentColor" : "none"} aria-hidden="true" />
            </button>
            <button
              className="audiobook-catalog-play"
              type="button"
              onClick={(event) => { event.stopPropagation(); openPlayer(book.id); }}
              aria-label={`Play ${book.title}`}
              title="Play"
            >
              <Play size={18} fill="currentColor" aria-hidden="true" />
            </button>
          </>
        )}
      </div>

      <div className="audiobook-catalog-copy" onClick={activate}>
        <strong>{book.title}</strong>
        <small>{book.authors.length > 0 ? book.authors.join(", ") : "Unknown author"}</small>
        {metaParts.length > 0 && <span className="audiobook-catalog-meta">{metaParts.join(" · ")}</span>}
      </div>

      {!selectionMode && (
        <>
          <button
            className="audiobook-catalog-menu"
            type="button"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`More options for ${book.title}`}
            onClick={(event) => { event.stopPropagation(); setMenuOpen((open) => !open); }}
          >
            <MoreVertical size={18} aria-hidden="true" />
          </button>
          {menuOpen && (
            <div className="audiobook-card-menu" role="menu" aria-label={`Actions for ${book.title}`}>
              <button role="menuitem" type="button" onClick={() => { setMenuOpen(false); openPlayer(book.id); }}>
                <Play size={15} aria-hidden="true" /> <span>Play</span>
              </button>
              <button role="menuitem" type="button" onClick={toggleFinished} disabled={statusBusy}>
                {status === "finished"
                  ? <><RotateCcw size={15} aria-hidden="true" /> <span>Mark unfinished</span></>
                  : <><CheckCircle2 size={15} aria-hidden="true" /> <span>Mark finished</span></>}
              </button>
              <hr />
              <a
                role="menuitem"
                className="audiobook-card-menu-link"
                href={`/api/library/books/${book.id}/download`}
                download
                onClick={() => setMenuOpen(false)}
              >
                <Download size={15} aria-hidden="true" /> <span>Download</span>
              </a>
              <button role="menuitem" type="button" onClick={() => { setMenuOpen(false); onShare(book); }}>
                <Share2 size={15} aria-hidden="true" /> <span>Share</span>
              </button>
              {canEdit && (
                <>
                  <hr />
                  <button role="menuitem" type="button" className="admin" onClick={() => { setMenuOpen(false); onEdit(book); }}>
                    <Pencil size={15} aria-hidden="true" /> <span>Edit metadata</span>
                  </button>
                </>
              )}
            </div>
          )}
        </>
      )}
    </article>
  );
}

// Bottom-of-grid loader: an IntersectionObserver sentinel for infinite scroll
// plus an explicit "Load more" button as a fallback.
function CatalogTail({
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
    <div className="modal-backdrop" onMouseDown={() => !saving && onClose()}>
      <form
        className="confirm-modal edit-library-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bulk-edit-title"
        onSubmit={submit}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div>
          <h2 id="bulk-edit-title">Edit {count} {count === 1 ? "book" : "books"}</h2>
          <p className="muted">Overwrites scanned metadata for every selected book. Leave a field blank to keep each book's current value. Tags replace existing tags.</p>
        </div>
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
          <button className="secondary-button" type="button" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="primary-button" type="submit" disabled={saving}>
            {saving ? "Saving…" : `Overwrite ${count} ${count === 1 ? "book" : "books"}`}
          </button>
        </div>
      </form>
    </div>
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
  const viewMode: AudiobookViewMode = "grid";
  const [libraryMenuOpen, setLibraryMenuOpen] = useState(false);
  const [libraryMenuPos, setLibraryMenuPos] = useState<{ top: number; left: number } | null>(null);
  const libraryTriggerRef = useRef<HTMLButtonElement>(null);
  const libraryMenuRef = useRef<HTMLDivElement>(null);

  // Multi-select bulk editing (admins / library owners only).
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [categories, setCategories] = useState<CategorySummary[]>([]);
  const [bulkNotice, setBulkNotice] = useState("");
  // Per-tile actions that need page-level UI.
  const [shareBook, setShareBook] = useState<AudiobookBook | null>(null);
  const [editBook, setEditBook] = useState<AudiobookBook | null>(null);

  const scope: CatalogScope = selectedLibraryId === "all" ? { kind: "all" } : { kind: "library", libraryId: selectedLibraryId };
  const cat = useAudiobookCatalog(scope, sort, "audiobooks:main");

  // Can the user edit books in the current scope? Drives the bulk-edit controls.
  const canEditScope = selectedLibraryId === "all"
    ? libraries.some((library) => library.canWrite)
    : libraries.find((library) => library.id === selectedLibraryId)?.canWrite ?? false;

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

  const submitSingleEdit = async (fields: Record<string, unknown>) => {
    if (!editBook) return;
    await runBulk([editBook.id], fields);
    setEditBook(null);
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

  const toggleLibraryMenu = () => {
    setLibraryMenuOpen((open) => {
      if (!open && libraryTriggerRef.current) {
        const rect = libraryTriggerRef.current.getBoundingClientRect();
        setLibraryMenuPos({ top: rect.bottom + 8, left: rect.left });
      }
      return !open;
    });
  };

  useEffect(() => {
    if (!libraryMenuOpen) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (libraryTriggerRef.current?.contains(target)) return;
      if (libraryMenuRef.current?.contains(target)) return;
      setLibraryMenuOpen(false);
    };
    const dismiss = () => setLibraryMenuOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [libraryMenuOpen]);

  const selectedLibraryLabel = selectedLibraryId === "all"
    ? "All Libraries"
    : libraries.find((library) => library.id === selectedLibraryId)?.name ?? "All Libraries";
  const error = librariesError || cat.error;

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
              {canEditScope && !selectionMode && (
                <button type="button" className="secondary-button" onClick={() => { setSelectionMode(true); setBulkNotice(""); }}>
                  <CheckSquare size={17} aria-hidden="true" />
                  <span>Select</span>
                </button>
              )}
            </>
          }
        />

        {error && <MessageBox tone="error" title="Audiobooks error">{error}</MessageBox>}
        {bulkNotice && <MessageBox tone="success" title="Books updated">{bulkNotice}</MessageBox>}

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
                <div className="audiobook-library-shortcuts">
                  <button
                    ref={libraryTriggerRef}
                    type="button"
                    className="audiobook-library-tab"
                    onClick={toggleLibraryMenu}
                    aria-haspopup="menu"
                    aria-expanded={libraryMenuOpen}
                    aria-label="Select library"
                  >
                    <BookOpen size={19} aria-hidden="true" />
                    <span>{selectedLibraryLabel}</span>
                    <ChevronDown size={16} aria-hidden="true" />
                  </button>
                  {libraryMenuOpen && libraryMenuPos && createPortal(
                    <div
                      ref={libraryMenuRef}
                      className="book-detail-action-menu audiobook-library-menu"
                      role="menu"
                      aria-label="Select library"
                      style={{ position: "fixed", top: libraryMenuPos.top, left: libraryMenuPos.left, right: "auto" }}
                    >
                      <button
                        type="button"
                        role="menuitem"
                        className={selectedLibraryId === "all" ? "active" : ""}
                        onClick={() => { setSelectedLibraryId("all"); setLibraryMenuOpen(false); }}
                      >
                        <span>All Libraries</span>
                      </button>
                      {libraries.map((library) => (
                        <button
                          key={library.id}
                          type="button"
                          role="menuitem"
                          className={selectedLibraryId === library.id ? "active" : ""}
                          onClick={() => { setSelectedLibraryId(library.id); setLibraryMenuOpen(false); }}
                        >
                          <span>{library.name}</span>
                        </button>
                      ))}
                    </div>,
                    document.body
                  )}
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

            <div className={`audiobook-catalog ${viewMode}`}>
              {cat.books.map((book) => (
                <CatalogBookCard
                  key={book.id}
                  book={book}
                  viewMode={viewMode}
                  selectionMode={selectionMode}
                  selected={selectedIds.has(book.id)}
                  onToggleSelect={toggleSelect}
                  canEdit={libraries.find((library) => library.id === book.libraryId)?.canWrite ?? false}
                  onShare={setShareBook}
                  onEdit={setEditBook}
                />
              ))}
              {!cat.loading && cat.books.length === 0 && <p className="management-empty">No audiobooks match this filter.</p>}
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

        {editBook && (
          <BulkEditModal
            count={1}
            categories={categories}
            peopleSuggestions={peopleSuggestions}
            tagSuggestions={cat.facets.tags}
            onClose={() => setEditBook(null)}
            onSubmit={submitSingleEdit}
          />
        )}

        {shareBook && (
          <ShareModal bookId={shareBook.id} bookTitle={shareBook.title} onClose={() => setShareBook(null)} />
        )}
      </section>
    </DashboardShell>
  );
}
