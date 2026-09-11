import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { BookMarked, BookOpen, CheckCheck, CheckSquare, Layers, LayoutGrid, Library, LibraryBig, Loader2, Pencil, Trash2, UploadCloud, X } from "lucide-react";
import { api } from "../../../api";
import { DashboardShell } from "../../../app/DashboardShell";
import { useSession } from "../../../app/SessionContext";
import { listDownloads, listEbookDownloads } from "../../../offline/downloads";
import { followRoute, navigate } from "../../../router";
import { AlphabetBar } from "../../../shared/AlphabetBar";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { cx } from "../../../shared/cx";
import { LibraryPageHeader } from "../../../shared/LibraryPageHeader";
import { LibraryPageToolbar } from "../../../shared/LibraryPageToolbar";
import { MessageBox } from "../../../shared/MessageBox";
import { SectionNav } from "../../../shared/SectionNav";
import { SortMenu } from "../../../shared/SortMenu";
import { useIsMobile } from "../../../shared/useIsMobile";
import { isFoliateFormat } from "../../../shared/utils";
import { AddToCollectionModal } from "../../collections/AddToCollectionModal";
import { activeFilterCount, FilterButton, FilterChips, getEbookSortOptions, getSortOptions, type SortKey } from "../BookFilter";
import { EditMetadataModal } from "../EditMetadataModal";
import { EbookReader } from "../reader/EbookReader";
import { audiobookNavItems, ebookNavItems } from "../sectionNavItems";
import type { AudiobookBook, AudiobookBookDetail, CategorySummary } from "../types";
import { getDensityOptions, readCatalogView, useMediaCatalog, writeCatalogView, type CatalogDensity, type CatalogScope } from "../useAudiobookCatalog";
import { AddToSeriesModal } from "./AddToSeriesModal";
import { BulkEditModal } from "./BulkEditModal";
import { CatalogBookCard } from "./CatalogBookCard";
import { CatalogBrowseMenu } from "./CatalogBrowseMenu";
import { CATALOG_KINDS, type CatalogKind, type CatalogLibrary, type EbookBook } from "./catalogKinds";
import { CatalogRowMobile } from "./CatalogRowMobile";
import { CatalogTail } from "./CatalogTail";
import { EbookCatalogCard } from "./EbookCatalogCard";
import { EbookUploadModal } from "./EbookUploadModal";
import { GroupAsEditionsModal } from "./GroupAsEditionsModal";
import { UploadBookModal } from "./UploadBookModal";
import { useCatalogSelection } from "./useCatalogSelection";
import { Button } from "../../../shared/Button";

// The Audiobooks page and the Ebooks page — one browse page over the server's
// paged catalog, drawn for either kind of library. What differs between the two
// (endpoints, words, facets, which actions apply) lives in catalogKinds.ts; the
// tiles differ enough to be two components (CatalogBookCard / EbookCatalogCard).
export function CatalogPage({ kind }: { kind: CatalogKind }) {
  const config = CATALOG_KINDS[kind];
  const K = config.keys;
  const isEbook = kind === "ebook";
  const { t } = useTranslation(["common", "book"]);
  const { user } = useSession();
  const [libraries, setLibraries] = useState<CatalogLibrary[]>([]);
  // Derived from the library filter below, not chosen: exactly one library in the
  // filter behaves as a scope, anything else is "all". Keeps one source of truth
  // for what's in view.
  const [selectedLibraryId, setSelectedLibraryId] = useState("all");
  // Remembered for the session like the rest of the view (search, filters, View),
  // so stepping into a book and back keeps the order you chose.
  const [sort, setSort] = useState<SortKey>(() => readCatalogView(config.persistKey).sort);
  const [density, setDensity] = useState<CatalogDensity>(() => readCatalogView(config.persistKey).density);
  const [librariesError, setLibrariesError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState("");
  // Cross-type category taxonomy, for the bulk-edit category picker.
  const [categories, setCategories] = useState<CategorySummary[]>([]);
  // Source-writing actions (policy-gated): upload new books, delete existing ones.
  const [uploadOpen, setUploadOpen] = useState(false);

  // Per-tile actions that need page-level UI.
  const [collectionBook, setCollectionBook] = useState<EbookBook | null>(null);
  const [readerBook, setReaderBook] = useState<EbookBook | null>(null);
  // The full metadata editor needs the book detail shape; fetch it on demand
  // when a tile's "Edit metadata" is chosen.
  const [editDetail, setEditDetail] = useState<AudiobookBookDetail | null>(null);
  const [editLoadError, setEditLoadError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<AudiobookBook | null>(null);
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
    const list: () => Promise<{ bookId: string }[]> = isEbook ? listEbookDownloads : listDownloads;
    list().then((downloads) => {
      if (alive) setDownloadedIds(new Set(downloads.map((d) => d.bookId)));
    }).catch(() => {});
    return () => { alive = false; };
  }, [isMobile]); // eslint-disable-line react-hooks/exhaustive-deps

  // Which shelves the list is drawn from is a filter, like every other way of
  // narrowing it — there is no scope picker of its own. One library chosen still
  // resolves to the library-scoped query, so the facets and the A–Z letters stay
  // honest to what is actually on screen; anything else is the whole catalog.
  const scope: CatalogScope = selectedLibraryId === "all"
    ? { kind: "all" }
    : { kind: "library", libraryId: selectedLibraryId };
  const cat = useMediaCatalog<EbookBook>(scope, sort, config.persistKey, config.endpoints);

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
  // Delete access in view drives bulk delete (works across several libraries too).
  const canDeleteScope = scopedLibraries.some((library) => library.canDelete);
  // Either is reason to select: someone who may only delete still needs a way to
  // tick several books, and the row then offers Delete alone.
  const canSelect = canEditScope || canDeleteScope;
  // Series live in a single library, so bulk "Add to series" is only offered when
  // the list is down to one — which means one library picked in Filter.
  const canAddToSeries = canEditScope && selectedLibraryId !== "all";
  // Libraries accepting uploads drive the Upload button + modal choices.
  const uploadLibraries = libraries.filter((library) => library.canUpload);

  // Existing people in the current scope, for the bulk-edit comboboxes.
  const peopleSuggestions = config.narrators
    ? Array.from(new Set([...cat.facets.authors, ...cat.facets.narrators]))
    : cat.facets.authors;

  // Also what the scan poll below calls, so a failed poll says so — and the next
  // good one takes the message down again rather than leaving a stale error up.
  const loadLibraries = useCallback(async () => {
    try {
      const payload = await api<{ libraries: CatalogLibrary[] }>(`/api/library/${config.librariesPath}`);
      setLibraries(payload.libraries);
      setLibrariesError("");
      setLoaded(true);
    } catch (err) {
      setLibrariesError(err instanceof Error ? err.message : t(K.unableLoadLibraries));
    }
  }, [config.librariesPath, K, t]);

  useEffect(() => { void loadLibraries(); }, [loadLibraries]);

  // What an upload or a delete changed: the catalog, and the library counts the
  // empty-state message is worded from.
  const refreshAfterChange = () => {
    void loadLibraries();
    cat.refresh();
  };

  const selection = useCatalogSelection({
    config,
    libraryId: selectedLibraryId,
    onNotice: setNotice,
    onChanged: cat.refresh,
    onDeleted: refreshAfterChange
  });

  // Drop selection when the scope changes or selection is disallowed.
  useEffect(() => { selection.exit(); }, [selectedLibraryId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!canSelect) selection.exit(); }, [canSelect]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    api<{ categories: CategorySummary[] }>("/api/library/categories")
      .then((payload) => setCategories(payload.categories))
      .catch(() => setCategories([]));
  }, []);

  useEffect(() => {
    // The chosen libraries ride along in `filters`, which the hook persists.
    writeCatalogView(config.persistKey, { sort, density });
  }, [sort, density]); // eslint-disable-line react-hooks/exhaustive-deps

  // While a library is scanning, refresh both the library status and the catalog
  // so new books appear without a manual reload.
  useEffect(() => {
    if (!libraries.some((library) => library.scanStatus === "scanning")) return;
    const timer = window.setInterval(() => {
      void loadLibraries();
      cat.refresh();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [libraries, loadLibraries, cat.refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleAudiobookUploaded = (book: AudiobookBookDetail | null, libraryName: string) => {
    setUploadOpen(false);
    setNotice(book
      ? t("book:catalog.uploadedBookNotice", { title: book.title, library: libraryName })
      : t("book:catalog.uploadCompleteNotice", { library: libraryName }));
    refreshAfterChange();
  };

  const handleEbooksUploaded = (count: number, libraryName: string) => {
    setUploadOpen(false);
    setNotice(count > 0
      ? t("book:catalog.uploadedEbooksNotice", { count, library: libraryName })
      : t("book:catalog.uploadCompleteNotice", { library: libraryName }));
    refreshAfterChange();
  };

  const confirmDeleteOne = async () => {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    setDeleteError("");
    try {
      await api(`/api/library/books/${deleteTarget.id}`, { method: "DELETE" });
      setNotice(t("book:catalog.movedOneToRecycleNotice", { title: deleteTarget.title }));
      setDeleteTarget(null);
      refreshAfterChange();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : t(K.unableMoveOne));
    } finally {
      setDeleteBusy(false);
    }
  };

  const askDelete = (target: AudiobookBook) => { setDeleteError(""); setDeleteTarget(target); };

  // The tile's read button opens EPUB/FB2 straight into the reader; other formats
  // (PDF) fall back to the detail page, which has the right viewer for them.
  const openReader = (book: EbookBook) => {
    if (isFoliateFormat(book.format) && book.documentId) setReaderBook(book);
    else navigate(`/ebooks/books/${book.id}`);
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

  const libraryFor = (libraryId: string) => libraries.find((library) => library.id === libraryId);

  // How many books the chosen shelves hold at all — the difference between "your
  // libraries are empty" and "nothing matched what you asked for".
  const selectedScopeBookCount = scopedLibraries.reduce((sum, library) => sum + library.bookCount, 0);
  const selectedLibraryLabel = scopedLibraries.length === 1 ? scopedLibraries[0].name : t("book:catalog.yourLibraries");
  const scanning = libraries.some((library) => library.scanStatus === "scanning");
  const hasActiveQuery = cat.search.trim().length > 0 || activeFilterCount(cat.filters) > 0 || cat.letter != null;
  const emptyMessage = selectedScopeBookCount === 0
    ? t(K.emptyNoneInLibrary, { library: selectedLibraryLabel })
    : hasActiveQuery
      ? t(K.emptyNoMatch)
      : t(K.emptyNone);
  const error = librariesError || cat.error || editLoadError;
  const subtitle = [
    t(isEbook ? "book:catalog.counts.ebook" : "book:catalog.counts.audiobook", { count: cat.total }),
    t("book:catalog.counts.author", { count: cat.facets.authors.length }),
    ...(config.narrators ? [t("book:catalog.counts.narrator", { count: cat.facets.narrators.length })] : [])
  ].join(" • ");
  const navLabel = t(isEbook ? "common:nav.ebooks" : "common:nav.audiobooks");

  return (
    <DashboardShell
      active={config.dashboard}
      sideNav={<SectionNav ariaLabel={navLabel} groupLabel={navLabel} items={isEbook ? ebookNavItems() : audiobookNavItems()} activeKey="books" />}
    >
      <section className="audiobook-main-page">
        <LibraryPageHeader
          title={t(K.title)}
          subtitle={subtitle}
          search={cat.search}
          onSearchChange={cat.setSearch}
          searchPlaceholder={t(K.searchPlaceholder)}
          // Every control lives in the toolbar below, Upload included: the header
          // is the page's name and its search box, nothing else.
        />

        {error && <MessageBox tone="error" title={t(K.errorTitle)}>{error}</MessageBox>}
        {notice && <MessageBox tone="success" title={t("book:catalog.libraryUpdatedTitle")}>{notice}</MessageBox>}

        {/* Only once the list has actually arrived: before that, an empty
            array means "not loaded yet", and saying "no libraries" flashed the
            wrong page at everyone who has some. */}
        {loaded && libraries.length === 0 ? (
          <div className="empty-state library-empty">
            {isEbook ? <BookMarked size={58} aria-hidden="true" /> : <BookOpen size={58} aria-hidden="true" />}
            <h2>{t(K.noLibraries)}</h2>
            {user.role === "admin" ? (
              <>
                <p className="muted">
                  {t(K.createLibraryHint)}
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
              <p className="muted">{t(K.adminAddLibraries)}</p>
            )}
          </div>
        ) : (
          <>
            <LibraryPageToolbar
              // No library picker of its own: choosing shelves is one of the ways
              // this list is narrowed, so it lives in Filter with the rest. The
              // active choice reads back as a chip under the toolbar.
              scope={<>{isMobile && <CatalogBrowseMenu kind={kind} />}</>}
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
                    fields={config.filterFields}
                    libraries={libraries}
                  />
                  <SortMenu value={sort} options={isEbook ? getEbookSortOptions() : getSortOptions()} onChange={setSort} ariaLabel={t(K.sortAria)} presentation="labelled" />
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
                  {!isMobile && canSelect && (
                    <Button variant="toolbar" onClick={() => { selection.enter(); setNotice(""); }}>
                      <CheckSquare size={18} aria-hidden="true" />
                      <span className="toolbar-label">{t("book:catalog.select")}</span>
                    </Button>
                  )}
                  {uploadLibraries.length > 0 && (
                    <Button variant="toolbar" className="primary" onClick={() => { setUploadOpen(true); setNotice(""); }}>
                      <UploadCloud size={18} aria-hidden="true" />
                      <span className="toolbar-label">{t("book:catalog.upload")}</span>
                    </Button>
                  )}
                </>
              }
              selection={!isMobile && selection.active ? {
                count: selection.selectedIds.size,
                // Labelled, like the standard row: an unlabelled trash icon is
                // exactly where hesitation costs the most.
                actions: (
                  <>
                    <Button
                      variant="toolbar"
                      onClick={() => selection.selectAll(cat.books.map((book) => book.id))}
                      disabled={cat.books.length === 0}
                      title={t(K.selectAllLoaded)}
                    >
                      <CheckCheck size={18} aria-hidden="true" />
                      <span className="toolbar-label">{t("book:catalog.all")}</span>
                    </Button>
                    {canEditScope && (
                      <Button
                        variant="toolbar"
                        onClick={() => selection.setBulkOpen(true)}
                        disabled={selection.selectedIds.size === 0}
                        title={t("book:detail.editMetadata")}
                      >
                        <Pencil size={18} aria-hidden="true" />
                        <span className="toolbar-label">{t("book:catalog.edit")}</span>
                      </Button>
                    )}
                    {canEditScope && (
                      <Button
                        variant="toolbar"
                        onClick={() => selection.setEditionsOpen(true)}
                        disabled={selection.selectedIds.size < 2}
                        title={t(K.groupSelected)}
                      >
                        <Layers size={18} aria-hidden="true" />
                        <span className="toolbar-label">{t("book:catalog.group")}</span>
                      </Button>
                    )}
                    {canAddToSeries && (
                      <Button
                        variant="toolbar"
                        onClick={() => selection.setSeriesOpen(true)}
                        disabled={selection.selectedIds.size === 0}
                        title={t("book:catalog.addToSeriesTitle")}
                      >
                        <Library size={18} aria-hidden="true" />
                        <span className="toolbar-label">{t("book:catalog.seriesShort")}</span>
                      </Button>
                    )}
                    {canDeleteScope && (
                      <Button
                        variant="toolbar" danger
                        onClick={selection.openDelete}
                        disabled={selection.selectedIds.size === 0}
                        title={t(K.deleteSelected)}
                      >
                        <Trash2 size={18} aria-hidden="true" />
                        <span className="toolbar-label">{t("book:catalog.delete")}</span>
                      </Button>
                    )}
                    <span className="library-toolbar-divider" aria-hidden="true" />
                    <Button variant="toolbar" onClick={selection.exit} title={t("book:catalog.leaveSelection")}>
                      <X size={18} aria-hidden="true" />
                      <span className="toolbar-label">{t("common:common.done")}</span>
                    </Button>
                  </>
                )
              } : null}
              // Desktop only. On a phone the letters are a 30-target row nobody
              // can hit accurately, competing with the list they're meant to
              // reach — scrolling and search do that job better there.
              strip={!isMobile && (
                <AlphabetBar available={cat.facets.letters} value={cat.letter} onChange={cat.setLetter} ariaLabel={t(K.letterAria)} />
              )}
            />

            <FilterChips value={cat.filters} onChange={cat.setFilters} libraries={libraries} />

            {scanning && (
              <MessageBox tone="info" title={t(K.scanningTitle)}>
                {t("book:catalog.scanningBody")}
              </MessageBox>
            )}

            {isMobile ? (
              <div className="home-feed-list">
                {cat.books.map((book) => {
                  const lib = libraryFor(book.libraryId);
                  return (
                    <CatalogRowMobile
                      key={book.id}
                      book={book}
                      kind={kind}
                      canEdit={lib?.canWrite ?? false}
                      canDownload={lib?.canDownload ?? false}
                      canDelete={lib?.canDelete ?? false}
                      onEdit={openEditDetail}
                      onDelete={askDelete}
                      onAddToCollection={setCollectionBook}
                      onOpenReader={isEbook ? () => openReader(book) : undefined}
                      downloaded={downloadedIds.has(book.id)}
                      onDownload={setActiveDownload}
                      onDownloaded={handleDownloaded}
                      onToast={showToast}
                    />
                  );
                })}
                {!cat.loading && cat.books.length === 0 && <p className="management-empty">{emptyMessage}</p>}
              </div>
            ) : (
              <div className={cx("audiobook-catalog", "grid", density)}>
                {cat.books.map((book) => {
                  const lib = libraryFor(book.libraryId);
                  const tile = {
                    selectionMode: selection.active,
                    selected: selection.selectedIds.has(book.id),
                    onToggleSelect: selection.toggle,
                    canEdit: lib?.canWrite ?? false,
                    canDownload: lib?.canDownload ?? false,
                    canDelete: lib?.canDelete ?? false,
                    onEdit: openEditDetail,
                    onAddToCollection: setCollectionBook,
                    onDelete: askDelete
                  };
                  return isEbook
                    ? <EbookCatalogCard key={book.id} book={book} {...tile} onRead={openReader} />
                    : <CatalogBookCard key={book.id} book={book} {...tile} />;
                })}
                {!cat.loading && cat.books.length === 0 && <p className="management-empty">{emptyMessage}</p>}
              </div>
            )}

            <CatalogTail hasMore={cat.hasMore} loadingMore={cat.loadingMore} loadMore={cat.loadMore} sentinelRef={cat.sentinelRef} />
          </>
        )}

        {selection.bulkOpen && (
          <BulkEditModal
            count={selection.selectedIds.size}
            categories={categories}
            peopleSuggestions={peopleSuggestions}
            tagSuggestions={cat.facets.tags}
            showNarrator={config.narrators}
            onClose={() => selection.setBulkOpen(false)}
            onSubmit={selection.submitBulk}
          />
        )}

        {selection.seriesOpen && selectedLibraryId !== "all" && (
          <AddToSeriesModal
            libraryId={selectedLibraryId}
            kind={kind}
            count={selection.selectedIds.size}
            onClose={() => selection.setSeriesOpen(false)}
            onSubmit={selection.submitAddToSeries}
          />
        )}

        {selection.editionsOpen && (
          <GroupAsEditionsModal
            kind={kind}
            books={cat.books.filter((book) => selection.selectedIds.has(book.id))}
            onClose={() => selection.setEditionsOpen(false)}
            onSubmit={selection.submitGroupEditions}
          />
        )}

        {uploadOpen && uploadLibraries.length > 0 && (isEbook ? (
          <EbookUploadModal
            libraries={uploadLibraries}
            initialLibraryId={selectedLibraryId}
            onClose={() => setUploadOpen(false)}
            onUploaded={handleEbooksUploaded}
          />
        ) : (
          <UploadBookModal
            libraries={uploadLibraries}
            initialLibraryId={selectedLibraryId}
            onClose={() => setUploadOpen(false)}
            onUploaded={handleAudiobookUploaded}
          />
        ))}

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
            {isEbook
              ? t("book:catalog.deleteOneEbookBody")
              : t("book:catalog.deleteOneAudiobookBody", { files: t("book:catalog.counts.audioFile", { count: deleteTarget.fileCount }) })}
          </ConfirmDialog>
        )}

        {selection.deleteOpen && (
          <ConfirmDialog
            title={t(K.bulkDeleteTitle, { count: selection.selectedIds.size })}
            confirmLabel={t(K.bulkDeleteButton, { count: selection.selectedIds.size })}
            busyLabel={t("book:detail.moving")}
            busy={selection.deleteBusy}
            error={selection.deleteError}
            onConfirm={() => void selection.confirmDelete()}
            onCancel={() => { if (!selection.deleteBusy) selection.setDeleteOpen(false); }}
          >
            {t(K.bulkDeleteBody)}
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
            entityType={kind}
            entityId={collectionBook.id}
            title={collectionBook.title}
            onClose={() => setCollectionBook(null)}
          />
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
