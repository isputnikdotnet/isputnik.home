import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { BookMarked, BookOpen, Check, CheckCheck, CheckCircle2, CheckSquare, ChevronDown, Compass, Download, Heart, Layers, LayoutGrid, Library, LibraryBig, ListMusic, Loader2, Pencil, RotateCcw, Shapes, Square, Trash2, UploadCloud, UserRound, X } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { followRoute, navigate } from "../../router";
import { SectionNav } from "../../shared/SectionNav";
import { ebookNavItems } from "./sectionNavItems";
import { useIsMobile } from "../../shared/useIsMobile";
import { CatalogRowMobile } from "./CatalogRowMobile";
import { DEFAULT_COVERS } from "./covers";
import { listEbookDownloads } from "../../offline/downloads";
import { MessageBox } from "../../shared/MessageBox";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { Modal } from "../../shared/Modal";
import { Button } from "../../shared/Button";
import { FileUpload } from "../../shared/FileUpload";
import { formatBytes, isFoliateFormat } from "../../shared/utils";
import { AddToCollectionModal } from "../collections/AddToCollectionModal";
import { EditMetadataModal } from "./EditMetadataModal";
import { EbookReader } from "./reader/EbookReader";
import { AddToSeriesModal, GroupAsEditionsModal, BulkEditModal, AudiobookHeaderSort, CatalogAdminMenu, CatalogTail } from "./AudiobooksPage";
import { LibraryPageHeader } from "../../shared/LibraryPageHeader";
import { LibraryPageToolbar } from "../../shared/LibraryPageToolbar";
import { AlphabetBar } from "../../shared/AlphabetBar";
import { SortMenu } from "../../shared/SortMenu";
import { useMediaCatalog, readCatalogView, writeCatalogView, getDensityOptions, type CatalogDensity, type CatalogScope } from "./useAudiobookCatalog";
import {
  getEbookSortOptions, FilterButton, FilterChips, activeFilterCount,
  type BookFilters, type SortKey
} from "./BookFilter";
import type { AudiobookBook, AudiobookBookDetail, CategorySummary } from "./types";

// The shared book shape plus the primary document's format/id (for the Read button
// and the direct download link) and the full list of available formats (for the
// format chips) — what /api/library/ebooks/catalog returns.
type EbookBook = AudiobookBook & { format?: string | null; documentId?: string | null; formats?: string[] };

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
const EBOOK_FILTER_FIELDS: (keyof BookFilters)[] = ["libraries", "status", "authors", "categories", "tags", "languages"];

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
  const { t } = useTranslation(["common", "book"]);
  const [libraryId, setLibraryId] = useState(() => (
    libraries.some((library) => library.id === initialLibraryId) ? initialLibraryId : libraries[0]?.id ?? ""
  ));
  const [busy, setBusy] = useState(false);
  const library = libraries.find((item) => item.id === libraryId);

  return (
    <Modal
      title={t("book:catalog.uploadEbooksTitle")}
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

      {library && (
        <FileUpload
          endpoint={`/api/library/ebook-libraries/${library.id}/books/upload`}
          accept={library.uploadExtensions}
          maxBytes={library.maxUploadMB != null ? library.maxUploadMB * 1024 * 1024 : null}
          multiple
          maxFiles={100} // mirrors MAX_EBOOK_UPLOAD_FILES on the server
          hint={library.maxUploadMB != null
            ? t("book:catalog.acceptedHintWithSize", { types: library.uploadExtensions.map((ext) => `.${ext}`).join(", "), mb: library.maxUploadMB })
            : t("book:catalog.acceptedHint", { types: library.uploadExtensions.map((ext) => `.${ext}`).join(", ") })}
          onUploaded={(response) => {
            const payload = response as { uploaded?: number };
            onUploaded(payload.uploaded ?? 0, library.name);
          }}
          onBusyChange={setBusy}
        />
      )}

    </Modal>
  );
}

function EbookCatalogCard({
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
  const [liked, setLiked] = useState(book.saved);
  const [likeBusy, setLikeBusy] = useState(false);

  // Re-seed from the server shape when the catalog refreshes.
  useEffect(() => { setLiked(book.saved); }, [book.saved]);

  const activate = () => {
    if (selectionMode) onToggleSelect(book.id);
    else navigate(`/ebooks/books/${book.id}`);
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

  const [status, setStatus] = useState<BookStatus>(() => bookStatus(book));
  const [statusBusy, setStatusBusy] = useState(false);
  useEffect(() => { setStatus(bookStatus(book)); }, [book.progress]);

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
    } catch {
      setStatus(bookStatus(book));
    } finally {
      setStatusBusy(false);
    }
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
    <article className={`audiobook-catalog-card grid${selectionMode ? " selectable" : ""}${selected ? " selected" : ""}`}>
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
                  className={`audiobook-catalog-action${liked ? " on" : ""}`}
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

export function EbooksPage({ user, logout }: { user: PublicUser; logout: () => Promise<void> }) {
  const { t } = useTranslation(["common", "book"]);
  const [libraries, setLibraries] = useState<EbookLibrary[]>([]);
  // Derived from the library filter below, not chosen: one library behaves as a
  // scope, none or several is the whole catalog.
  const [selectedLibraryId, setSelectedLibraryId] = useState("all");
  const [sort, setSort] = useState<SortKey>(() => readCatalogView("ebooks:main").sort);
  const [density, setDensity] = useState<CatalogDensity>(() => readCatalogView("ebooks:main").density);
  const [librariesError, setLibrariesError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState("");

  // Source-writing actions: upload new ebooks, plus multi-select bulk add-to-series / delete.
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [categories, setCategories] = useState<CategorySummary[]>([]);
  const [seriesModalOpen, setSeriesModalOpen] = useState(false);
  const [editionsModalOpen, setEditionsModalOpen] = useState(false);
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

  // Mobile / PWA: homepage-style rows, compact header, Browse dropdown + a live
  // download banner. Desktop is unchanged.
  const isMobile = useIsMobile();
  const [downloadedIds, setDownloadedIds] = useState<Set<string>>(new Set());
  const [activeDownload, setActiveDownload] = useState<{ title: string; progress: number } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [browsePos, setBrowsePos] = useState<{ top: number; left: number | null; right: number | null } | null>(null);
  const browseTriggerRef = useRef<HTMLButtonElement>(null);
  const browseMenuRef = useRef<HTMLDivElement>(null);

  const showToast = (message: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = setTimeout(() => setToast(null), 2500);
  };

  const handleDownloaded = (id: string) => setDownloadedIds((prev) => new Set([...prev, id]));

  useEffect(() => {
    if (!isMobile) return;
    let alive = true;
    listEbookDownloads().then((downloads) => {
      if (alive) setDownloadedIds(new Set(downloads.map((d) => d.bookId)));
    }).catch(() => {});
    return () => { alive = false; };
  }, [isMobile]);

  // Cross-type category taxonomy, for the bulk-edit category picker.
  useEffect(() => {
    api<{ categories: CategorySummary[] }>("/api/library/categories")
      .then((payload) => setCategories(payload.categories))
      .catch(() => setCategories([]));
  }, []);

  // Which shelves the list is drawn from is a filter, like every other way of
  // narrowing it — see the audiobooks page for the same wiring. One library
  // chosen still resolves to the library-scoped query so facets and letters stay
  // honest to what's on screen.
  const scope: CatalogScope = selectedLibraryId === "all"
    ? { kind: "all" }
    : { kind: "library", libraryId: selectedLibraryId };
  const cat = useMediaCatalog<EbookBook>(scope, sort, "ebooks:main", EBOOK_ENDPOINTS);

  useEffect(() => {
    setSelectedLibraryId(cat.filters.libraries.length === 1 ? cat.filters.libraries[0] : "all");
  }, [cat.filters.libraries]);

  // The libraries the filter is narrowing to — everything accessible when empty.
  const scopedLibraries = cat.filters.libraries.length
    ? libraries.filter((library) => cat.filters.libraries.includes(library.id))
    : libraries;

  // Curate access in what's on screen drives the multi-select bulk controls.
  const canEditScope = scopedLibraries.some((library) => library.canWrite);
  // Series live in a single library, so bulk "Add to series" needs one picked.
  const canAddToSeries = canEditScope && selectedLibraryId !== "all";
  // Delete access in view drives bulk delete (works across several libraries too).
  const canDeleteScope = scopedLibraries.some((library) => library.canDelete);
  // Libraries accepting uploads drive the Upload button + modal choices.
  const uploadLibraries = libraries.filter((library) => library.canUpload);

  // Existing authors in the current scope, for the bulk-edit author combobox.
  const peopleSuggestions = cat.facets.authors;

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

  // Group the selected ebooks into one work (editions of the same title).
  const submitGroupEditions = async (primaryItemId: string) => {
    const result = await api<{ work: { id: string }; count: number }>(
      "/api/library/works",
      { method: "POST", body: JSON.stringify({ itemIds: [...selectedIds], primaryItemId }) }
    );
    setNotice(t("book:catalog.groupedEditionsNotice", { count: result.count }));
    cat.refresh();
    exitSelection();
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
    const parts = [t("book:catalog.addedToSeriesNotice", { count: result.added })];
    if (result.skipped > 0) parts.push(t("book:catalog.skippedAlreadyInSeries", { count: result.skipped }));
    setNotice(parts.join(" · "));
    cat.refresh();
    exitSelection();
  };

  const runBulk = async (ids: string[], fields: Record<string, unknown>) => {
    const result = await api<{ updated: number; forbidden: number; missing: number }>(
      "/api/library/books/bulk-metadata",
      { method: "POST", body: JSON.stringify({ bookIds: ids, ...fields }) }
    );
    const parts = [t("book:catalog.updatedEbooksNotice", { count: result.updated })];
    if (result.forbidden > 0) parts.push(t("book:catalog.skippedNoWriteAccess", { count: result.forbidden }));
    if (result.missing > 0) parts.push(t("book:catalog.skippedNotFound", { count: result.missing }));
    setNotice(parts.join(" · "));
    cat.refresh();
  };

  const submitBulk = async (fields: Record<string, unknown>) => {
    await runBulk([...selectedIds], fields);
    exitSelection();
  };

  const loadLibraries = useCallback(async () => {
    try {
      const payload = await api<{ libraries: EbookLibrary[] }>("/api/library/ebook-libraries");
      setLibraries(payload.libraries);
      setLoaded(true);
    } catch (err) {
      setLibrariesError(err instanceof Error ? err.message : t("book:catalog.unableLoadEbookLibraries"));
    }
  }, [t]);

  useEffect(() => { void loadLibraries(); }, [loadLibraries]);

  useEffect(() => {
    // The chosen libraries ride along in `filters`, which the hook persists.
    writeCatalogView("ebooks:main", { sort, density });
  }, [sort, density]);

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

  // The tile's read button opens EPUB/FB2 straight into the reader; other formats
  // (PDF) fall back to the detail page, which has the right viewer for them.
  const openReader = (book: EbookBook) => {
    if (isFoliateFormat(book.format) && book.documentId) setReaderBook(book);
    else navigate(`/ebooks/books/${book.id}`);
  };

  const openEditDetail = async (book: AudiobookBook) => {
    setEditLoadError("");
    try {
      const payload = await api<{ book: AudiobookBookDetail }>(`/api/library/books/${book.id}`);
      setEditDetail(payload.book);
    } catch (err) {
      setEditLoadError(err instanceof Error ? err.message : t("book:catalog.unableLoadBookDetails"));
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    setDeleteError("");
    try {
      await api(`/api/library/books/${deleteTarget.id}`, { method: "DELETE" });
      setNotice(t("book:catalog.movedOneToRecycleNotice", { title: deleteTarget.title }));
      setDeleteTarget(null);
      void loadLibraries();
      cat.refresh();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : t("book:catalog.unableMoveEbookToRecycle"));
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
      const parts = [t("book:catalog.movedEbooksToRecycleNotice", { count: result.deleted })];
      if (result.forbidden > 0) parts.push(t("book:catalog.skippedNoDeleteAccess", { count: result.forbidden }));
      if (result.missing > 0) parts.push(t("book:catalog.skippedNotFound", { count: result.missing }));
      if (result.failed > 0) parts.push(result.error
        ? t("book:catalog.failedWithReason", { count: result.failed, error: result.error })
        : t("book:catalog.failed", { count: result.failed }));
      setNotice(parts.join(" · "));
      exitSelection();
      void loadLibraries();
      cat.refresh();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : t("book:catalog.unableMoveSelectedEbooksToRecycle"));
    } finally {
      setDeleteBusy(false);
    }
  };

  const handleUploaded = (count: number, libraryName: string) => {
    setUploadOpen(false);
    setNotice(count > 0
      ? t("book:catalog.uploadedEbooksNotice", { count, library: libraryName })
      : t("book:catalog.uploadCompleteNotice", { library: libraryName }));
    void loadLibraries();
    cat.refresh();
  };

  const libraryFor = (libraryId: string) => libraries.find((library) => library.id === libraryId);

  // How many ebooks the chosen shelves hold at all — the difference between
  // "your libraries are empty" and "nothing matched what you asked for".
  const selectedScopeBookCount = scopedLibraries.reduce((sum, library) => sum + library.bookCount, 0);
  const selectedLibraryLabel = scopedLibraries.length === 1 ? scopedLibraries[0].name : t("book:catalog.yourLibraries");
  const scanning = libraries.some((library) => library.scanStatus === "scanning");
  const hasActiveQuery = cat.search.trim().length > 0 || activeFilterCount(cat.filters) > 0 || cat.letter != null;
  const emptyMessage = selectedScopeBookCount === 0
    ? t("book:catalog.emptyNoneInLibraryEbooks", { library: selectedLibraryLabel })
    : hasActiveQuery
      ? t("book:catalog.emptyNoMatchEbooks")
      : t("book:catalog.emptyNoneEbooks");
  const error = librariesError || cat.error || editLoadError;

  return (
    <DashboardShell
      active="ebooks"
      user={user}
      logout={logout}
      sideNav={<SectionNav ariaLabel={t("common:nav.ebooks")} groupLabel={t("common:nav.ebooks")} items={ebookNavItems()} activeKey="books" />}
    >
      <section className="audiobook-main-page">
        <LibraryPageHeader
          title={t("book:catalog.ebooksTitle")}
          subtitle={`${t("book:catalog.counts.ebook", { count: cat.total })} • ${t("book:catalog.counts.author", { count: cat.facets.authors.length })}`}
          search={cat.search}
          onSearchChange={cat.setSearch}
          searchPlaceholder={t("book:catalog.searchEbooksPlaceholder")}
          // Every control lives in the toolbar below, Upload included: the header
          // is the page's name and its search box, nothing else.
        />

        {error && <MessageBox tone="error" title={t("book:catalog.ebooksErrorTitle")}>{error}</MessageBox>}
        {notice && <MessageBox tone="success" title={t("book:catalog.libraryUpdatedTitle")}>{notice}</MessageBox>}

        {loaded && libraries.length === 0 ? (
          <div className="empty-state library-empty">
            <BookMarked size={58} aria-hidden="true" />
            <h2>{t("book:catalog.noEbookLibraries")}</h2>
            {user.role === "admin" ? (
              <>
                <p className="muted">
                  {t("book:catalog.createLibraryHintEbooks")}
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
              <p className="muted">{t("book:catalog.adminAddEbookLibrary")}</p>
            )}
          </div>
        ) : (
          <>
            <LibraryPageToolbar
              // No library picker of its own: choosing shelves is one of the ways
              // this list is narrowed, so it lives in Filter with the rest.
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
                        aria-label={t("book:catalog.browseEbooksAria")}
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
                          <button type="button" role="menuitem" onClick={() => { setBrowseOpen(false); navigate("/ebooks/series"); }}>
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
              // it — the same row the audiobooks page wears.
              tools={
                <>
                  <FilterButton
                    facets={cat.facets}
                    value={cat.filters}
                    onChange={cat.setFilters}
                    fields={EBOOK_FILTER_FIELDS}
                    libraries={libraries}
                  />
                  <SortMenu value={sort} options={getEbookSortOptions()} onChange={setSort} ariaLabel={t("book:catalog.sortEbooksAria")} presentation="labelled" />
                  {/* Desktop only: the phone renders rows, not the grid this sizes. */}
                  {!isMobile && (
                    <SortMenu
                      value={density}
                      options={getDensityOptions()}
                      onChange={setDensity}
                      ariaLabel={t("book:catalog.view")}
                      presentation="labelled"
                      icon={<LayoutGrid size={18} aria-hidden="true" />}
                      label={t("book:catalog.view")}
                    />
                  )}
                  <span className="library-toolbar-divider" aria-hidden="true" />
                  {!isMobile && (canEditScope || canDeleteScope) && (
                    <button type="button" className="library-toolbar-button" onClick={() => { setSelectionMode(true); setNotice(""); }}>
                      <CheckSquare size={18} aria-hidden="true" />
                      <span className="toolbar-label">{t("book:catalog.select")}</span>
                    </button>
                  )}
                  {uploadLibraries.length > 0 && (
                    <button type="button" className="library-toolbar-button primary" onClick={() => { setUploadOpen(true); setNotice(""); }}>
                      <UploadCloud size={18} aria-hidden="true" />
                      <span className="toolbar-label">{t("book:catalog.upload")}</span>
                    </button>
                  )}
                </>
              }
              selection={!isMobile && selectionMode ? {
                count: selectedIds.size,
                actions: (
                  <>
                    <button
                      type="button"
                      className="library-toolbar-button"
                      onClick={() => setSelectedIds(new Set(cat.books.map((book) => book.id)))}
                      disabled={cat.books.length === 0}
                      title={t("book:catalog.selectAllLoadedEbooks")}
                    >
                      <CheckCheck size={18} aria-hidden="true" />
                      <span className="toolbar-label">{t("book:catalog.all")}</span>
                    </button>
                    {canEditScope && (
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
                    )}
                    {canEditScope && (
                      <button
                        type="button"
                        className="library-toolbar-button"
                        onClick={() => setEditionsModalOpen(true)}
                        disabled={selectedIds.size < 2}
                        title={t("book:catalog.groupSelectedEbooksTitle")}
                      >
                        <Layers size={18} aria-hidden="true" />
                        <span className="toolbar-label">{t("book:catalog.group")}</span>
                      </button>
                    )}
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
                        title={t("book:catalog.deleteSelectedEbooksTitle")}
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
              // Desktop only — see the audiobooks page: 30 letter targets don't
              // belong on a phone screen.
              strip={!isMobile && (
                <AlphabetBar available={cat.facets.letters} value={cat.letter} onChange={cat.setLetter} ariaLabel={t("book:catalog.filterEbooksByLetterAria")} />
              )}
            />

            <FilterChips value={cat.filters} onChange={cat.setFilters} libraries={libraries} />

            {scanning && (
              <MessageBox tone="info" title={t("book:catalog.scanningEbooksTitle")}>
                {t("book:catalog.scanningBody")}
              </MessageBox>
            )}

            {isMobile ? (
              <div className="home-feed-list">
                {cat.books.map((book) => (
                  <CatalogRowMobile
                    key={book.id}
                    book={book}
                    kind="ebook"
                    canEdit={libraryFor(book.libraryId)?.canWrite ?? false}
                    canDownload={libraryFor(book.libraryId)?.canDownload ?? false}
                    canDelete={libraryFor(book.libraryId)?.canDelete ?? false}
                    onEdit={openEditDetail}
                    onDelete={(target) => { setDeleteError(""); setDeleteTarget(target); }}
                    onAddToCollection={setCollectionBook}
                    onOpenReader={() => openReader(book)}
                    downloaded={downloadedIds.has(book.id)}
                    onDownload={setActiveDownload}
                    onDownloaded={handleDownloaded}
                    onToast={showToast}
                  />
                ))}
                {!cat.loading && cat.books.length === 0 && <p className="management-empty">{emptyMessage}</p>}
              </div>
            ) : (
              <div className={`audiobook-catalog grid ${density}`}>
                {cat.books.map((book) => (
                  <EbookCatalogCard
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
            )}

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

        {bulkOpen && (
          <BulkEditModal
            count={selectedIds.size}
            categories={categories}
            peopleSuggestions={peopleSuggestions}
            tagSuggestions={cat.facets.tags}
            showNarrator={false}
            onClose={() => setBulkOpen(false)}
            onSubmit={submitBulk}
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

        {editionsModalOpen && (
          <GroupAsEditionsModal
            kind="ebook"
            books={cat.books.filter((book) => selectedIds.has(book.id))}
            onClose={() => setEditionsModalOpen(false)}
            onSubmit={submitGroupEditions}
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
            title={t("book:catalog.deleteToRecycleBinTitle", { title: deleteTarget.title })}
            confirmLabel={t("book:detail.moveToRecycleBin")}
            busyLabel={t("book:detail.moving")}
            busy={deleteBusy}
            error={deleteError}
            onConfirm={() => void confirmDelete()}
            onCancel={() => { if (!deleteBusy) setDeleteTarget(null); }}
          >
            {t("book:catalog.deleteOneEbookBody")}
          </ConfirmDialog>
        )}

        {bulkDeleteOpen && (
          <ConfirmDialog
            title={t("book:catalog.bulkDeleteTitleEbooks", { count: selectedIds.size })}
            confirmLabel={t("book:catalog.bulkDeleteButtonEbooks", { count: selectedIds.size })}
            busyLabel={t("book:detail.moving")}
            busy={deleteBusy}
            error={deleteError}
            onConfirm={() => void confirmBulkDelete()}
            onCancel={() => { if (!deleteBusy) setBulkDeleteOpen(false); }}
          >
            {t("book:catalog.bulkDeleteBodyEbooks")}
          </ConfirmDialog>
        )}

        {readerBook?.documentId && createPortal(
          <EbookReader
            bookId={readerBook.id}
            documentId={readerBook.documentId}
            format={readerBook.format ?? "epub"}
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
