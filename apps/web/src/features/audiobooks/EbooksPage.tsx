import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BookMarked, BookOpen, Check, ChevronDown, Download, Heart, ListMusic, UserRound } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { navigate } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { formatBytes } from "../../shared/utils";
import { AddToCollectionModal } from "../collections/AddToCollectionModal";
import { EditMetadataModal } from "./EditMetadataModal";
import { AudiobookPageHeader, AudiobookHeaderSort, CatalogAdminMenu, CatalogTail, formatCount } from "./AudiobooksPage";
import { useMediaCatalog, readCatalogView, writeCatalogView, type CatalogScope } from "./useAudiobookCatalog";
import {
  EBOOK_SORT_OPTIONS, FilterButton, FilterChips, activeFilterCount,
  type BookFilters, type SortKey
} from "./BookFilter";
import type { AudiobookBook, AudiobookBookDetail } from "./types";

// The shared book shape plus the primary document's format/id (for the format
// chip and the direct download link) — what /api/library/ebooks/catalog returns.
type EbookBook = AudiobookBook & { format?: string | null; documentId?: string | null };

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
  bookCount: number;
  scanStatus: "idle" | "scanning" | "error";
}

function EbookCatalogCard({
  book,
  canDownload,
  canEdit,
  canDelete,
  onEdit,
  onAddToCollection,
  onDelete
}: {
  book: EbookBook;
  canDownload: boolean;
  canEdit: boolean;
  canDelete: boolean;
  onEdit: (book: AudiobookBook) => void;
  onAddToCollection: (book: EbookBook) => void;
  onDelete: (book: AudiobookBook) => void;
}) {
  const [fav, setFav] = useState(book.saved);
  const [favBusy, setFavBusy] = useState(false);

  // Re-seed from the server shape when the catalog refreshes.
  useEffect(() => { setFav(book.saved); }, [book.saved]);

  const open = () => navigate(`/ebooks/books/${book.id}`);

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

  const finished = book.progress?.completedAt != null;
  const percent = Math.round((book.progress?.percentComplete ?? 0) * 100);
  const inProgress = !finished && percent > 0;

  const metaParts = [
    book.format ? book.format.toUpperCase() : "EBOOK",
    book.totalSize ? formatBytes(book.totalSize) : ""
  ].filter(Boolean);
  const byline = book.authors.length > 0 ? book.authors.join(", ") : "Unknown author";

  return (
    <article className="audiobook-catalog-card grid">
      <div
        className="audiobook-catalog-cover"
        role="button"
        tabIndex={0}
        aria-label={`Open ${book.title}`}
        onClick={open}
        onKeyDown={(event) => {
          if (event.currentTarget !== event.target) return;
          if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); }
        }}
      >
        {book.coverUrl ? (
          <img src={book.coverUrl} alt="" />
        ) : (
          <>
            <BookMarked size={34} aria-hidden="true" />
            <strong>{book.title.slice(0, 2).toUpperCase()}</strong>
          </>
        )}
        {finished && (
          <span className="audiobook-catalog-finished" title="Finished"><Check size={14} /></span>
        )}
        {inProgress && (
          <>
            <span className="audiobook-catalog-pct" title={`${percent}% read`}>
              <BookOpen size={9} aria-hidden="true" />{percent}%
            </span>
            <span className="audiobook-catalog-progress" aria-hidden="true">
              <span style={{ width: `${percent}%` }} />
            </span>
          </>
        )}
        <div className="audiobook-catalog-actions" aria-label={`Actions for ${book.title}`}>
          <div className="audiobook-catalog-action-row">
            <button
              className={`audiobook-catalog-action${fav ? " on" : ""}`}
              type="button"
              onClick={(event) => { event.stopPropagation(); void toggleFav(); }}
              aria-pressed={fav}
              aria-label={fav ? "Remove from favorites" : "Add to favorites"}
              title={fav ? "Favorited" : "Add to favorites"}
              disabled={favBusy}
            >
              <Heart size={16} fill={fav ? "currentColor" : "none"} aria-hidden="true" />
              <span>{fav ? "Favorited" : "Favorite"}</span>
            </button>
            {canDownload && book.documentId && (
              <a
                className="audiobook-catalog-action"
                href={`/api/library/books/${book.id}/documents/${book.documentId}?download`}
                download
                onClick={(event) => event.stopPropagation()}
                aria-label={`Download ${book.title}`}
                title="Download"
              >
                <Download size={16} aria-hidden="true" />
                <span>Download</span>
              </a>
            )}
            <button
              className="audiobook-catalog-action"
              type="button"
              onClick={(event) => { event.stopPropagation(); onAddToCollection(book); }}
              aria-label="Add to collection"
              title="Add to collection"
            >
              <ListMusic size={16} aria-hidden="true" />
              <span>Add to Collection</span>
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
              onClick={(event) => { event.stopPropagation(); open(); }}
              aria-label={`Read ${book.title}`}
              title="Read"
            >
              <BookOpen size={22} aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>

      <div className="audiobook-catalog-copy" onClick={open}>
        <strong>{book.title}</strong>
        <small>{byline}</small>
        {metaParts.length > 0 && <span className="audiobook-catalog-meta">{metaParts.join(" · ")}</span>}
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

  // Per-tile actions that need page-level UI.
  const [collectionBook, setCollectionBook] = useState<EbookBook | null>(null);
  const [editDetail, setEditDetail] = useState<AudiobookBookDetail | null>(null);
  const [editLoadError, setEditLoadError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<AudiobookBook | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const scope: CatalogScope = selectedLibraryId === "all"
    ? { kind: "all" }
    : { kind: "library", libraryId: selectedLibraryId };
  const cat = useMediaCatalog<EbookBook>(scope, sort, "ebooks:main", EBOOK_ENDPOINTS);

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
                </nav>
              </div>
            </div>

            <FilterChips value={cat.filters} onChange={cat.setFilters} />

            {scanning && (
              <MessageBox tone="info" title="Scanning ebooks">
                New metadata and covers will appear as the scan finishes.
              </MessageBox>
            )}

            <div className="audiobook-catalog grid">
              {cat.books.map((book) => (
                <EbookCatalogCard
                  key={book.id}
                  book={book}
                  canDownload={libraryFor(book.libraryId)?.canDownload ?? false}
                  canEdit={libraryFor(book.libraryId)?.canWrite ?? false}
                  canDelete={libraryFor(book.libraryId)?.canDelete ?? false}
                  onEdit={openEditDetail}
                  onAddToCollection={setCollectionBook}
                  onDelete={(target) => { setDeleteError(""); setDeleteTarget(target); }}
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

        {collectionBook && (
          <AddToCollectionModal
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
      </section>
    </DashboardShell>
  );
}
