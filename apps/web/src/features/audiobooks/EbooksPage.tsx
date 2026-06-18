import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BookMarked, BookOpen, Check, CheckCircle2, CheckSquare, ChevronDown, Download, Heart, Library, ListMusic, MoreVertical, Pencil, RotateCcw, Square, Trash2, UploadCloud, UserRound, X } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { navigate } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { Modal } from "../../shared/Modal";
import { Button } from "../../shared/Button";
import { FileUpload } from "../../shared/FileUpload";
import { formatBytes } from "../../shared/utils";
import { AddToCollectionModal } from "../collections/AddToCollectionModal";
import { EditMetadataModal } from "./EditMetadataModal";
import { EbookReader } from "./reader/EbookReader";
import { AddToSeriesModal, AudiobookPageHeader, AudiobookHeaderSort, CatalogTail, formatCount } from "./AudiobooksPage";
import { useMediaCatalog, readCatalogView, writeCatalogView, type CatalogScope } from "./useAudiobookCatalog";
import {
  EBOOK_SORT_OPTIONS, FilterButton, FilterChips, activeFilterCount,
  type BookFilters, type SortKey
} from "./BookFilter";
import type { AudiobookBook, AudiobookBookDetail } from "./types";

// The shared book shape plus the primary document's format/id (for the format
// chip and the direct download link) — what /api/library/ebooks/catalog returns.
type EbookBook = AudiobookBook & { format?: string | null; documentId?: string | null };

type BookStatus = "finished" | "in_progress" | "none";
function bookStatus(book: EbookBook): BookStatus {
  if (book.progress?.completedAt != null) return "finished";
  if ((book.progress?.percentComplete ?? 0) > 0) return "in_progress";
  return "none";
}

const EBOOK_ENDPOINTS = {
  catalog: "/api/library/ebooks/catalog",
  facets: "/api/library/ebooks/facets"
};

// Ebooks only expose the facets that apply — no narrators/series/length.
const EBOOK_FILTER_FIELDS: (keyof BookFilters)[] = ["status", "authors", "categories", "tags", "languages"];

interface EbookLibrary {
  id: string;
  name: string;
  canWrite: boolean;
  canDownload: boolean;
  canDelete: boolean;
  canUpload: boolean;
  uploadExtensions: string[];
  maxUploadMB: number | null;
  bookCount: number;
  scanStatus: "idle" | "scanning" | "error";
}

// Upload one or more ebooks: pick the target library (when more than one accepts
// uploads), then drop the files. Each file becomes its own ebook; the server scans
// each immediately so new titles appear in the catalog when the modal closes.
function EbookUploadModal({
  libraries,
  initialLibraryId,
  onClose,
  onUploaded
}: {
  libraries: EbookLibrary[];
  initialLibraryId: string;
  onClose: () => void;
  onUploaded: (count: number, libraryName: string) => void;
}) {
  const [libraryId, setLibraryId] = useState(() => (
    libraries.some((library) => library.id === initialLibraryId) ? initialLibraryId : libraries[0]?.id ?? ""
  ));
  const [busy, setBusy] = useState(false);
  const library = libraries.find((item) => item.id === libraryId);

  return (
    <Modal title="Upload ebooks" className="book-upload-modal" busy={busy} onClose={onClose}>
      <p className="muted">Each file becomes its own ebook — drop several at once. Books are scanned and appear in the catalog right away.</p>

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

      {library && (
        <FileUpload
          endpoint={`/api/library/ebook-libraries/${library.id}/books/upload`}
          accept={library.uploadExtensions}
          maxBytes={library.maxUploadMB != null ? library.maxUploadMB * 1024 * 1024 : null}
          multiple
          maxFiles={100} // mirrors MAX_EBOOK_UPLOAD_FILES on the server
          hint={`Accepted: ${library.uploadExtensions.map((ext) => `.${ext}`).join(", ")}${library.maxUploadMB != null ? ` · up to ${library.maxUploadMB} MB per file` : ""}`}
          onUploaded={(response) => {
            const payload = response as { uploaded?: number };
            onUploaded(payload.uploaded ?? 0, library.name);
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

function EbookCatalogRow({
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
  const [fav, setFav] = useState(book.saved);
  const [favBusy, setFavBusy] = useState(false);
  const [status, setStatus] = useState<BookStatus>(() => bookStatus(book));
  const [statusBusy, setStatusBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setFav(book.saved); }, [book.saved]);
  useEffect(() => { setStatus(bookStatus(book)); }, [book.progress]);

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
    if (statusBusy || !book.documentId) return;
    const wasFinished = status === "finished";
    setStatus(wasFinished ? "none" : "finished");
    setStatusBusy(true);
    try {
      if (wasFinished) {
        await api(`/api/library/books/${book.id}/reading-progress?documentId=${encodeURIComponent(book.documentId)}`, { method: "DELETE" });
      } else {
        await api(`/api/library/books/${book.id}/reading-progress/complete`, { method: "POST", body: JSON.stringify({ documentId: book.documentId }) });
      }
    } catch { setStatus(bookStatus(book)); }
    finally { setStatusBusy(false); }
  };

  const percent = Math.round((book.progress?.percentComplete ?? 0) * 100);
  const inProgress = status === "in_progress" && percent > 0;
  const metaParts = [
    book.format ? book.format.toUpperCase() : "EBOOK",
    book.totalSize ? formatBytes(book.totalSize) : ""
  ].filter(Boolean);
  const byline = book.authors.length > 0 ? book.authors.join(", ") : "Unknown author";

  const activate = () => {
    if (selectionMode) onToggleSelect(book.id);
    else navigate(`/ebooks/books/${book.id}`);
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
          : <><BookMarked size={20} aria-hidden="true" /><strong>{book.title.slice(0, 2).toUpperCase()}</strong></>
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
          <span className="catalog-row-bar" aria-label={`${percent}% read`}>
            <span style={{ width: `${percent}%` }} />
          </span>
        )}
      </div>

      <div className="catalog-row-actions">
        {!selectionMode && (
          <button
            type="button"
            className="catalog-row-play"
            onClick={(e) => { e.stopPropagation(); onRead(book); }}
            aria-label={`Read ${book.title}`}
            title="Read"
          >
            <BookOpen size={14} aria-hidden="true" />
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
            {book.documentId && (
              <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); void toggleFinished(); }} disabled={statusBusy}>
                {status === "finished" ? <RotateCcw size={15} aria-hidden="true" /> : <CheckCircle2 size={15} aria-hidden="true" />}
                <span>{status === "finished" ? "Mark as unread" : "Mark as read"}</span>
              </button>
            )}
            {canDownload && book.documentId && (
              <a role="menuitem" href={`/api/library/books/${book.id}/documents/${book.documentId}?download`} download onClick={() => setMenuOpen(false)}>
                <Download size={15} aria-hidden="true" />
                <span>Download</span>
              </a>
            )}
            <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onAddToCollection(book); }}>
              <ListMusic size={15} aria-hidden="true" />
              <span>Add to collection</span>
            </button>
            <div className="catalog-row-dropdown-sep" role="separator" />
            <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); navigate(`/ebooks/books/${book.id}`); }}>
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

export function EbooksPage({ user, logout }: { user: PublicUser; logout: () => Promise<void> }) {
  const [libraries, setLibraries] = useState<EbookLibrary[]>([]);
  const [selectedLibraryId, setSelectedLibraryId] = useState(() => readCatalogView("ebooks:main").selectedLibraryId);
  const [sort, setSort] = useState<SortKey>(() => readCatalogView("ebooks:main").sort);
  const [librariesError, setLibrariesError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState("");

  // Library selector dropdown (mirrors the audiobooks main page).
  const [libraryMenuOpen, setLibraryMenuOpen] = useState(false);
  const [libraryMenuPos, setLibraryMenuPos] = useState<{ top: number; left: number } | null>(null);
  const libraryTriggerRef = useRef<HTMLButtonElement>(null);
  const libraryMenuRef = useRef<HTMLDivElement>(null);

  // Source-writing actions: upload new ebooks, plus multi-select bulk add-to-series / delete.
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [seriesModalOpen, setSeriesModalOpen] = useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);

  // Per-tile actions that need page-level UI.
  const [collectionBook, setCollectionBook] = useState<EbookBook | null>(null);
  const [readerBook, setReaderBook] = useState<EbookBook | null>(null);
  const [editDetail, setEditDetail] = useState<AudiobookBookDetail | null>(null);
  const [editLoadError, setEditLoadError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<AudiobookBook | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const scope: CatalogScope = selectedLibraryId === "all"
    ? { kind: "all" }
    : { kind: "library", libraryId: selectedLibraryId };
  const cat = useMediaCatalog<EbookBook>(scope, sort, "ebooks:main", EBOOK_ENDPOINTS);

  // Curate access in the current scope drives the multi-select bulk controls.
  const canEditScope = selectedLibraryId === "all"
    ? libraries.some((library) => library.canWrite)
    : libraries.find((library) => library.id === selectedLibraryId)?.canWrite ?? false;
  // Series live in a single library, so bulk "Add to series" needs a single-library scope.
  const canAddToSeries = canEditScope && selectedLibraryId !== "all";
  // Delete access in the current scope drives bulk delete (works across "all" too).
  const canDeleteScope = selectedLibraryId === "all"
    ? libraries.some((library) => library.canDelete)
    : libraries.find((library) => library.id === selectedLibraryId)?.canDelete ?? false;
  // Libraries accepting uploads drive the Upload button + modal choices.
  const uploadLibraries = libraries.filter((library) => library.canUpload);

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
    setSeriesModalOpen(false);
    setBulkDeleteOpen(false);
  };

  const submitAddToSeries = async (target: { seriesId: string } | { newName: string }) => {
    let seriesId: string;
    if ("seriesId" in target) {
      seriesId = target.seriesId;
    } else {
      const created = await api<{ series: { id: string } }>(
        `/api/library/ebook-libraries/${selectedLibraryId}/series`,
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
    setNotice(parts.join(" · "));
    cat.refresh();
    exitSelection();
  };

  const loadLibraries = useCallback(async () => {
    try {
      const payload = await api<{ libraries: EbookLibrary[] }>("/api/library/ebook-libraries");
      setLibraries(payload.libraries);
      setLoaded(true);
    } catch (err) {
      setLibrariesError(err instanceof Error ? err.message : "Unable to load ebook libraries");
    }
  }, []);

  useEffect(() => { void loadLibraries(); }, [loadLibraries]);

  useEffect(() => {
    writeCatalogView("ebooks:main", { selectedLibraryId, sort });
  }, [selectedLibraryId, sort]);

  // Drop selection when the scope changes or all bulk access is lost.
  useEffect(() => { exitSelection(); }, [selectedLibraryId]);
  useEffect(() => { if (!canEditScope && !canDeleteScope) exitSelection(); }, [canEditScope, canDeleteScope]);

  // While a library is scanning, refresh both the library list and the catalog so
  // new books/covers appear without a manual reload.
  useEffect(() => {
    if (!libraries.some((library) => library.scanStatus === "scanning")) return;
    const timer = window.setInterval(() => {
      void loadLibraries();
      cat.refresh();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [libraries, loadLibraries, cat.refresh]);

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

  // The tile's read button opens EPUBs straight into the reader; other formats
  // (PDF) fall back to the detail page, which has the right viewer for them.
  const openReader = (book: EbookBook) => {
    if (book.format === "epub" && book.documentId) setReaderBook(book);
    else navigate(`/ebooks/books/${book.id}`);
  };

  const openEditDetail = async (book: AudiobookBook) => {
    setEditLoadError("");
    try {
      const payload = await api<{ book: AudiobookBookDetail }>(`/api/library/books/${book.id}`);
      setEditDetail(payload.book);
    } catch (err) {
      setEditLoadError(err instanceof Error ? err.message : "Unable to load book details");
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    setDeleteError("");
    try {
      await api(`/api/library/books/${deleteTarget.id}`, { method: "DELETE" });
      setNotice(`Moved "${deleteTarget.title}" to the Recycle Bin`);
      setDeleteTarget(null);
      void loadLibraries();
      cat.refresh();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Unable to move the ebook to the Recycle Bin");
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
      const parts = [`Moved ${result.deleted} ${result.deleted === 1 ? "ebook" : "ebooks"} to the Recycle Bin`];
      if (result.forbidden > 0) parts.push(`${result.forbidden} skipped (no delete access)`);
      if (result.missing > 0) parts.push(`${result.missing} not found`);
      if (result.failed > 0) parts.push(`${result.failed} failed${result.error ? ` (${result.error})` : ""}`);
      setNotice(parts.join(" · "));
      exitSelection();
      void loadLibraries();
      cat.refresh();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Unable to move the selected ebooks to the Recycle Bin");
    } finally {
      setDeleteBusy(false);
    }
  };

  const handleUploaded = (count: number, libraryName: string) => {
    setUploadOpen(false);
    setNotice(count > 0
      ? `Uploaded ${count} ${count === 1 ? "ebook" : "ebooks"} to ${libraryName}`
      : `Upload to ${libraryName} complete`);
    void loadLibraries();
    cat.refresh();
  };

  const libraryFor = (libraryId: string) => libraries.find((library) => library.id === libraryId);

  const selectedLibrary = selectedLibraryId === "all" ? null : libraryFor(selectedLibraryId) ?? null;
  const selectedLibraryLabel = selectedLibraryId === "all" ? "All Libraries" : selectedLibrary?.name ?? "All Libraries";
  const selectedScopeBookCount = selectedLibraryId === "all"
    ? libraries.reduce((sum, library) => sum + library.bookCount, 0)
    : selectedLibrary?.bookCount ?? 0;
  const scanning = libraries.some((library) => library.scanStatus === "scanning");
  const hasActiveQuery = cat.search.trim().length > 0 || activeFilterCount(cat.filters) > 0;
  const emptyMessage = selectedScopeBookCount === 0
    ? selectedLibraryId === "all"
      ? "No ebooks in your libraries yet."
      : `No ebooks in ${selectedLibraryLabel} yet.`
    : hasActiveQuery
      ? "No ebooks match this search or filter."
      : "No ebooks to show.";
  const error = librariesError || cat.error || editLoadError;

  return (
    <DashboardShell active="ebooks" user={user} logout={logout}>
      <section className="audiobook-main-page">
        <AudiobookPageHeader
          title="Ebooks"
          subtitle={`${formatCount(cat.total)} ebooks • ${formatCount(cat.facets.authors.length)} authors`}
          search={cat.search}
          onSearchChange={cat.setSearch}
          searchPlaceholder="Search ebooks..."
          actions={
            <>
              <FilterButton facets={cat.facets} value={cat.filters} onChange={cat.setFilters} fields={EBOOK_FILTER_FIELDS} />
              <AudiobookHeaderSort value={sort} onChange={setSort} options={EBOOK_SORT_OPTIONS} ariaLabel="Sort ebooks" />
              {uploadLibraries.length > 0 && !selectionMode && (
                <button type="button" className="secondary-button" onClick={() => { setUploadOpen(true); setNotice(""); }}>
                  <UploadCloud size={17} aria-hidden="true" />
                  <span>Upload</span>
                </button>
              )}
              {(canAddToSeries || canDeleteScope) && !selectionMode && (
                <button type="button" className="secondary-button" onClick={() => { setSelectionMode(true); setNotice(""); }}>
                  <CheckSquare size={17} aria-hidden="true" />
                  <span>Select</span>
                </button>
              )}
            </>
          }
        />

        {error && <MessageBox tone="error" title="Ebooks error">{error}</MessageBox>}
        {notice && <MessageBox tone="success" title="Library updated">{notice}</MessageBox>}

        {loaded && libraries.length === 0 ? (
          <div className="empty-state library-empty">
            <BookMarked size={58} aria-hidden="true" />
            <h2>No ebook libraries yet</h2>
            <p className="muted">An administrator can add an ebook library from the control panel.</p>
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
                    <BookMarked size={19} aria-hidden="true" />
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
                <nav className="audiobook-page-tabs" aria-label="Ebook views">
                  <a
                    href="/ebooks/authors"
                    onClick={(event) => { event.preventDefault(); navigate("/ebooks/authors"); }}
                  >
                    <UserRound size={19} aria-hidden="true" />
                    <span>Authors</span>
                  </a>
                  <a
                    href="/ebooks/series"
                    onClick={(event) => { event.preventDefault(); navigate("/ebooks/series"); }}
                  >
                    <Library size={19} aria-hidden="true" />
                    <span>Series</span>
                  </a>
                </nav>
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

            {scanning && (
              <MessageBox tone="info" title="Scanning ebooks">
                New metadata and covers will appear as the scan finishes.
              </MessageBox>
            )}

            <div className="audiobook-catalog-list">
              {cat.books.map((book) => (
                <EbookCatalogRow
                  key={book.id}
                  book={book}
                  selectionMode={selectionMode}
                  selected={selectedIds.has(book.id)}
                  onToggleSelect={toggleSelect}
                  canDownload={libraryFor(book.libraryId)?.canDownload ?? false}
                  canEdit={libraryFor(book.libraryId)?.canWrite ?? false}
                  canDelete={libraryFor(book.libraryId)?.canDelete ?? false}
                  onEdit={openEditDetail}
                  onAddToCollection={setCollectionBook}
                  onDelete={(target) => { setDeleteError(""); setDeleteTarget(target); }}
                  onRead={openReader}
                />
              ))}
              {!cat.loading && cat.books.length === 0 && <p className="management-empty">{emptyMessage}</p>}
            </div>

            <CatalogTail hasMore={cat.hasMore} loadingMore={cat.loadingMore} loadMore={cat.loadMore} sentinelRef={cat.sentinelRef} />
          </>
        )}

        {editDetail && (
          <EditMetadataModal
            book={editDetail}
            onBookUpdated={(updated) => { setEditDetail(updated); cat.refresh(); }}
            onClose={() => setEditDetail(null)}
          />
        )}

        {seriesModalOpen && selectedLibraryId !== "all" && (
          <AddToSeriesModal
            libraryId={selectedLibraryId}
            kind="ebook"
            count={selectedIds.size}
            onClose={() => setSeriesModalOpen(false)}
            onSubmit={submitAddToSeries}
          />
        )}

        {uploadOpen && uploadLibraries.length > 0 && (
          <EbookUploadModal
            libraries={uploadLibraries}
            initialLibraryId={selectedLibraryId}
            onClose={() => setUploadOpen(false)}
            onUploaded={handleUploaded}
          />
        )}

        {collectionBook && (
          <AddToCollectionModal
            entityType="ebook"
            entityId={collectionBook.id}
            title={collectionBook.title}
            onClose={() => setCollectionBook(null)}
          />
        )}

        {deleteTarget && (
          <ConfirmDialog
            title={`Move "${deleteTarget.title}" to the Recycle Bin?`}
            confirmLabel="Move to Recycle Bin"
            busyLabel="Moving…"
            busy={deleteBusy}
            error={deleteError}
            onConfirm={() => void confirmDelete()}
            onCancel={() => { if (!deleteBusy) setDeleteTarget(null); }}
          >
            This ebook moves into the Recycle Bin and leaves the library for everyone. You can restore it
            from the Recycle Bin, or delete it permanently from there.
          </ConfirmDialog>
        )}

        {bulkDeleteOpen && (
          <ConfirmDialog
            title={`Move ${formatCount(selectedIds.size)} ${selectedIds.size === 1 ? "ebook" : "ebooks"} to the Recycle Bin?`}
            confirmLabel={`Move ${formatCount(selectedIds.size)} ${selectedIds.size === 1 ? "ebook" : "ebooks"}`}
            busyLabel="Moving…"
            busy={deleteBusy}
            error={deleteError}
            onConfirm={() => void confirmBulkDelete()}
            onCancel={() => { if (!deleteBusy) setBulkDeleteOpen(false); }}
          >
            The selected ebooks move into the Recycle Bin and leave the library for everyone. Ebooks you lack
            delete access to are skipped. You can restore them from the Recycle Bin anytime.
          </ConfirmDialog>
        )}

        {readerBook?.documentId && createPortal(
          <EbookReader
            bookId={readerBook.id}
            documentId={readerBook.documentId}
            url={`/api/library/books/${readerBook.id}/documents/${readerBook.documentId}`}
            storageKey={`isputnik:epub-progress:${user.id}:${readerBook.id}:${readerBook.documentId}`}
            initialProgress={null}
            title={readerBook.title}
            author={readerBook.authors.join(", ")}
            coverUrl={readerBook.coverUrl}
            downloadUrl={`/api/library/books/${readerBook.id}/documents/${readerBook.documentId}?download`}
            onExit={() => { setReaderBook(null); cat.refresh(); }}
          />,
          document.body
        )}
      </section>
    </DashboardShell>
  );
}
