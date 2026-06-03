import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { BookOpen, CheckCircle2, ChevronDown, ChevronUp, Download, FileText, Pencil, Play, RotateCcw, Save, Search, Share2, Upload, X } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { ShareModal } from "../share/ShareModal";
import {
  EMPTY_FILTERS,
  FilterButton,
  FilterChips,
  SortSelect,
  filterBooks,
  sortBooks,
  type BookFilters,
  type SortKey
} from "./BookFilter";
import { DashboardShell } from "../../app/DashboardShell";
import { AudiobookNav } from "./AudiobookNav";
import { navigate } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import { formatBytes, formatDuration } from "../../shared/utils";
import type { AudiobookBook, AudiobookBookDetail, AudiobookFile, AudiobookLibrary, CategorySummary, CoverCandidate, LibrarySection, MetadataCandidate, PlaybackProgress } from "./types";

// Document formats we can render in the in-app reader overlay. Others get
// download-only. EPUB joins this set once the epub reader lands (Phase B).
const VIEWABLE_DOC_FORMATS = new Set(["pdf"]);

function BookCard({ book }: { book: AudiobookBook }) {
  const pct = book.progress?.percentComplete ?? null;
  const finished = book.progress?.completedAt != null || (pct != null && pct >= 0.98);
  const inProgress = !finished && pct != null && pct > 0;
  return (
    <button className="audiobook-card" onClick={() => navigate(`/audiobooks/books/${book.id}`)}>
      <div className="audiobook-cover">
        {book.coverUrl ? (
          <img src={book.coverUrl} alt="" aria-hidden="true" />
        ) : (
          <>
            <BookOpen size={13} aria-hidden="true" />
            <strong aria-hidden="true">{book.title.slice(0, 2).toUpperCase()}</strong>
          </>
        )}
        {finished && (
          <span className="audiobook-progress-badge" title="Finished" aria-label="Finished">
            <CheckCircle2 size={15} />
          </span>
        )}
        {inProgress && (
          <span className="audiobook-progress-bar" aria-label={`${Math.round((pct ?? 0) * 100)}% played`}>
            <span style={{ width: `${Math.round((pct ?? 0) * 100)}%` }} />
          </span>
        )}
      </div>
      <div className="audiobook-card-body">
        <strong>{book.title}</strong>
        <span>{book.authors.length > 0 ? book.authors.join(", ") : "Unknown author"}</span>
        <small>
          {book.durationSeconds != null ? `${formatDuration(book.durationSeconds)} · ` : ""}
          {book.fileCount} {book.fileCount === 1 ? "file" : "files"}
        </small>
      </div>
    </button>
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
  const [booksByLibrary, setBooksByLibrary] = useState<Record<string, AudiobookBook[]>>({});
  const [selectedLibraryId, setSelectedLibraryId] = useState("all");
  const [filters, setFilters] = useState<BookFilters>(EMPTY_FILTERS);
  const [sort, setSort] = useState<SortKey>("title");
  const [bookSearch, setBookSearch] = useState("");
  const [error, setError] = useState("");

  const loadLibraryBooks = useCallback(async (libraryId: string) => {
    const payload = await api<{ books: AudiobookBook[] }>(`/api/library/audiobook-libraries/${libraryId}/books`);
    setBooksByLibrary((current) => ({ ...current, [libraryId]: payload.books }));
  }, []);

  const loadMissingLibraryBooks = useCallback(async (libraryIds: string[]) => {
    await Promise.all(libraryIds.map((libraryId) => loadLibraryBooks(libraryId)));
  }, [loadLibraryBooks]);

  useEffect(() => {
    api<{ libraries: AudiobookLibrary[] }>("/api/library/audiobook-libraries")
      .then(async (payload) => {
        setLibraries(payload.libraries);
        setSelectedLibraryId("all");
        // Only the main grid's (non-section) libraries need their books loaded here;
        // section books are shown inside the section view.
        await loadMissingLibraryBooks(
          payload.libraries.filter((library) => !library.specialSection).map((library) => library.id)
        );
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load audiobooks"));
  }, [loadMissingLibraryBooks]);

  useEffect(() => {
    if (!libraries.some((library) => library.scanStatus === "scanning")) {
      return;
    }

    const timer = window.setInterval(() => {
      api<{ libraries: AudiobookLibrary[] }>("/api/library/audiobook-libraries")
        .then(async (payload) => {
          setLibraries(payload.libraries);
          await loadMissingLibraryBooks(
            payload.libraries.filter((library) => !library.specialSection).map((library) => library.id)
          );
        })
        .catch((err) => setError(err instanceof Error ? err.message : "Unable to refresh audiobooks"));
    }, 3000);

    return () => window.clearInterval(timer);
  }, [libraries, loadMissingLibraryBooks]);

  // Special-section libraries are walled off from the main grid; they appear only
  // behind their section's master icon.
  const normalLibraries = libraries.filter((library) => !library.specialSection);
  const allBooks = normalLibraries.flatMap((library) =>
    (booksByLibrary[library.id] ?? []).map((book) => ({ ...book, libraryName: library.name }))
  );
  const searchTerm = bookSearch.trim().toLowerCase();
  const searched = allBooks.filter((book) => {
    if (selectedLibraryId !== "all" && book.libraryId !== selectedLibraryId) return false;
    if (searchTerm) {
      const haystack = [book.title, book.libraryName, ...book.authors, ...book.narrators];
      if (!haystack.some((v) => v?.toLowerCase().includes(searchTerm))) return false;
    }
    return true;
  });
  const visibleBooks = sortBooks(filterBooks(searched, filters), sort);

  return (
    <DashboardShell active="audiobooks" user={user} logout={logout} sideNav={<AudiobookNav active="books" />}>
      <section className="work-area scene-page audiobook-scene audiobook-area">
          <div className="section-head audiobook-head">
            <div>
              <p className="eyebrow">Digital Library</p>
              <h1>Audiobooks</h1>
            </div>
          </div>

          {error && <MessageBox tone="error" title="Audiobooks error">{error}</MessageBox>}

          {normalLibraries.length === 0 && (
            <div className="empty-state library-empty">
              <BookOpen size={58} aria-hidden="true" />
              {libraries.some((library) => library.specialSection) ? (
                <>
                  <h2>No general audiobooks here</h2>
                  <p className="muted">Open a special section from the sidebar to browse its books.</p>
                </>
              ) : (
                <>
                  <h2>No audiobook libraries yet</h2>
                  <p className="muted">An administrator can add libraries from the control panel.</p>
                </>
              )}
            </div>
          )}

          {normalLibraries.length > 0 && (
            <>
              <div className="audiobook-toolbar">
                <label className="search-field">
                  <Search size={17} aria-hidden="true" />
                  <input
                    type="search"
                    value={bookSearch}
                    onChange={(event) => setBookSearch(event.target.value)}
                    placeholder="Search title, author, or narrator"
                    aria-label="Search audiobooks"
                  />
                </label>
                <select
                  className="library-filter"
                  value={selectedLibraryId}
                  onChange={(event) => setSelectedLibraryId(event.target.value)}
                  aria-label="Filter by library"
                >
                  <option value="all">All libraries</option>
                  {normalLibraries.map((library) => (
                    <option key={library.id} value={library.id}>{library.name}</option>
                  ))}
                </select>
                <FilterButton books={allBooks} value={filters} onChange={setFilters} />
                <SortSelect value={sort} onChange={setSort} />
                <span>{visibleBooks.length} {visibleBooks.length === 1 ? "book" : "books"}</span>
              </div>

              <FilterChips value={filters} onChange={setFilters} />

              {libraries.some((library) => library.scanStatus === "scanning") && (
                <MessageBox tone="info" title="Scanning audiobooks">
                  New metadata and covers will appear as the scan finishes.
                </MessageBox>
              )}

              <div className="audiobook-grid">
                {visibleBooks.map((book) => (
                  <BookCard key={book.id} book={book} />
                ))}
                {visibleBooks.length === 0 && <p className="management-empty">No audiobooks match this filter.</p>}
              </div>
            </>
          )}
      </section>
    </DashboardShell>
  );
}

export function SectionPage({
  sectionId,
  user,
  logout
}: {
  sectionId: string;
  user: PublicUser;
  logout: () => Promise<void>;
}) {
  const [section, setSection] = useState<LibrarySection | null>(null);
  const [members, setMembers] = useState<AudiobookLibrary[]>([]);
  const [booksByLibrary, setBooksByLibrary] = useState<Record<string, AudiobookBook[]>>({});
  const [selectedLibraryId, setSelectedLibraryId] = useState("all");
  const [filters, setFilters] = useState<BookFilters>(EMPTY_FILTERS);
  const [sort, setSort] = useState<SortKey>("title");
  const [bookSearch, setBookSearch] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([
      api<{ sections: LibrarySection[] }>("/api/library/sections"),
      api<{ libraries: AudiobookLibrary[] }>("/api/library/audiobook-libraries")
    ])
      .then(async ([sectionsPayload, librariesPayload]) => {
        const found = sectionsPayload.sections.find((s) => s.id === sectionId) ?? null;
        setSection(found);
        const sectionMembers = librariesPayload.libraries.filter((library) => library.sectionId === sectionId);
        setMembers(sectionMembers);
        const booksLists = await Promise.all(
          sectionMembers.map((library) =>
            api<{ books: AudiobookBook[] }>(`/api/library/audiobook-libraries/${library.id}/books`)
              .then((payload) => [library.id, payload.books] as const)
          )
        );
        setBooksByLibrary(Object.fromEntries(booksLists));
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load section"));
  }, [sectionId]);

  const allBooks = members.flatMap((library) =>
    (booksByLibrary[library.id] ?? []).map((book) => ({ ...book, libraryName: library.name }))
  );
  const searchTerm = bookSearch.trim().toLowerCase();
  const searched = allBooks.filter((book) => {
    if (selectedLibraryId !== "all" && book.libraryId !== selectedLibraryId) return false;
    if (searchTerm) {
      const haystack = [book.title, book.libraryName, ...book.authors, ...book.narrators];
      if (!haystack.some((v) => v?.toLowerCase().includes(searchTerm))) return false;
    }
    return true;
  });
  const visibleBooks = sortBooks(filterBooks(searched, filters), sort);

  return (
    <DashboardShell active="audiobooks" user={user} logout={logout} sideNav={<AudiobookNav activeSectionId={sectionId} />}>
      <section className="work-area scene-page audiobook-scene audiobook-area">
        <button className="back-link" onClick={() => navigate("/audiobooks")}>← Audiobooks</button>
        <div className="section-head audiobook-head">
          <div>
            <p className="eyebrow">Special Section</p>
            <h1>{section?.name ?? "Section"}</h1>
          </div>
        </div>

        {error && <MessageBox tone="error" title="Section error">{error}</MessageBox>}

        {members.length === 0 ? (
          <p className="management-empty">No libraries have been added to this section yet.</p>
        ) : (
          <>
            <div className="audiobook-toolbar">
              <label className="search-field">
                <Search size={17} aria-hidden="true" />
                <input
                  type="search"
                  value={bookSearch}
                  onChange={(event) => setBookSearch(event.target.value)}
                  placeholder="Search title, author, or narrator"
                  aria-label="Search section"
                />
              </label>
              {members.length > 1 && (
                <select
                  className="library-filter"
                  value={selectedLibraryId}
                  onChange={(event) => setSelectedLibraryId(event.target.value)}
                  aria-label="Filter by library"
                >
                  <option value="all">All libraries</option>
                  {members.map((library) => (
                    <option key={library.id} value={library.id}>{library.name}</option>
                  ))}
                </select>
              )}
              <FilterButton books={allBooks} value={filters} onChange={setFilters} />
              <SortSelect value={sort} onChange={setSort} />
              <span>{visibleBooks.length} {visibleBooks.length === 1 ? "book" : "books"}</span>
            </div>

            <FilterChips value={filters} onChange={setFilters} />

            {members.some((library) => library.scanStatus === "scanning") && (
              <MessageBox tone="info" title="Scanning">
                New metadata and covers will appear as the scan finishes.
              </MessageBox>
            )}

            <div className="audiobook-grid">
              {visibleBooks.map((book) => (
                <BookCard key={book.id} book={book} />
              ))}
              {visibleBooks.length === 0 && <p className="management-empty">No books match this filter.</p>}
            </div>
          </>
        )}
      </section>
    </DashboardShell>
  );
}

export function AudiobookBookPage({
  id,
  user,
  logout
}: {
  id: string;
  user: PublicUser;
  logout: () => Promise<void>;
}) {
  const [book, setBook] = useState<AudiobookBookDetail | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setBook(null);
    setError("");
    api<{ book: AudiobookBookDetail }>(`/api/library/books/${id}`)
      .then((payload) => setBook(payload.book))
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load audiobook details"));
  }, [id]);

  return (
    <DashboardShell active="audiobooks" user={user} logout={logout}>
      <section className="work-area scene-page audiobook-scene audiobook-book-scene book-detail-area">
        <div className="book-detail-shell">
          {error && <MessageBox tone="error" title="Audiobook error">{error}</MessageBox>}
          {book ? (
            <BookDetailView
              book={book}
              onBack={() => navigate("/audiobooks")}
              onBookUpdated={setBook}
            />
          ) : !error ? (
            <p className="management-empty">Loading audiobook...</p>
          ) : null}
        </div>
      </section>
    </DashboardShell>
  );
}

function BookDetailView({
  book,
  onBack,
  onBookUpdated
}: {
  book: AudiobookBookDetail;
  onBack: () => void;
  onBookUpdated: (book: AudiobookBookDetail) => void;
}) {
  const [filesOpen, setFilesOpen] = useState(false);
  const [progress, setProgress] = useState<PlaybackProgress | null>(null);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  const [metadataModalOpen, setMetadataModalOpen] = useState(false);
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const [viewerDoc, setViewerDoc] = useState<{ id: string; fileName: string; url: string } | null>(null);

  // Close the full-screen reader on Escape.
  useEffect(() => {
    if (!viewerDoc) return;
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") setViewerDoc(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewerDoc]);
  const [activeMetadataTab, setActiveMetadataTab] = useState<"edit" | "cover" | "lookup">("edit");
  const [metadataQuery, setMetadataQuery] = useState(`${book.title} ${book.authors[0] ?? ""}`.trim());
  const [metadataProvider, setMetadataProvider] = useState<"all" | MetadataCandidate["source"]>("all");
  const [updateDetails, setUpdateDetails] = useState(true);
  const [updateCover, setUpdateCover] = useState(true);
  const [metadataResults, setMetadataResults] = useState<MetadataCandidate[]>([]);
  const [metadataLoading, setMetadataLoading] = useState(false);
  const [applyingIndex, setApplyingIndex] = useState<number | null>(null);
  const [metadataError, setMetadataError] = useState("");
  const [resetting, setResetting] = useState(false);
  const [resetConfirm, setResetConfirm] = useState(false);
  const [resetError, setResetError] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState("");
  const [progressAction, setProgressAction] = useState<"complete" | "">("");
  const [progressActionError, setProgressActionError] = useState("");
  const [coverCandidates, setCoverCandidates] = useState<CoverCandidate[]>([]);
  const [coverLoading, setCoverLoading] = useState(false);
  const [coverSaving, setCoverSaving] = useState("");
  const [coverError, setCoverError] = useState("");
  const [libraryPeople, setLibraryPeople] = useState<string[]>([]);
  const [librarySeries, setLibrarySeries] = useState<string[]>([]);
  const [categories, setCategories] = useState<CategorySummary[]>([]);
  const [editForm, setEditForm] = useState(() => ({
    title: book.title,
    series: book.series ?? "",
    seriesPosition: book.seriesPosition?.toString() ?? "",
    authors: book.authors,
    narrators: book.narrators,
    tags: book.tags.join(", "),
    categoryKey: book.category?.key ?? "",
    publisher: book.publisher ?? "",
    yearPublished: book.yearPublished?.toString() ?? "",
    language: book.language ?? "",
    isbn: book.isbn ?? "",
    asin: book.asin ?? "",
    description: book.description ?? ""
  }));

  useEffect(() => {
    setEditForm({
      title: book.title,
      series: book.series ?? "",
      seriesPosition: book.seriesPosition?.toString() ?? "",
      authors: book.authors,
      narrators: book.narrators,
      tags: book.tags.join(", "),
    categoryKey: book.category?.key ?? "",
      publisher: book.publisher ?? "",
      yearPublished: book.yearPublished?.toString() ?? "",
      language: book.language ?? "",
      isbn: book.isbn ?? "",
      asin: book.asin ?? "",
      description: book.description ?? ""
    });
  }, [book]);

  useEffect(() => {
    setDetailsExpanded(false);
    setDescriptionExpanded(false);
  }, [book.id]);

  useEffect(() => {
    api<{ progress: PlaybackProgress | null }>(`/api/library/books/${book.id}/progress`)
      .then((payload) => setProgress(payload.progress))
      .catch(() => setProgress(null));
  }, [book.id]);

  // Derive per-file listened status from the book-level progress (current file +
  // linear order). Accurate for sequential listening; an approximation if the
  // user jumped around.
  const currentFileIndex = progress?.fileId ? book.files.findIndex((f) => f.id === progress.fileId) : -1;
  const bookFinished = progress?.completedAt != null || (progress?.percentComplete != null && progress.percentComplete >= 0.98);
  const fileState = (index: number): "completed" | "in_progress" | "not_started" => {
    if (bookFinished) return "completed";
    if (currentFileIndex < 0) return "not_started";
    if (index < currentFileIndex) return "completed";
    if (index === currentFileIndex) return "in_progress";
    return "not_started";
  };

  const loadCoverCandidates = useCallback(async () => {
    setCoverLoading(true);
    setCoverError("");
    try {
      const payload = await api<{ covers: CoverCandidate[] }>(`/api/library/books/${book.id}/cover-candidates`);
      setCoverCandidates(payload.covers);
    } catch (err) {
      setCoverError(err instanceof Error ? err.message : "Unable to load cover files");
    } finally {
      setCoverLoading(false);
    }
  }, [book.id]);

  useEffect(() => {
    if (metadataModalOpen && activeMetadataTab === "cover") {
      loadCoverCandidates();
    }
  }, [activeMetadataTab, loadCoverCandidates, metadataModalOpen]);

  useEffect(() => {
    if (!metadataModalOpen) return;
    api<{ people: string[] }>(`/api/library/audiobook-libraries/${book.libraryId}/people`)
      .then((payload) => setLibraryPeople(payload.people))
      .catch(() => {});
    api<{ series: { id: string; name: string }[] }>(`/api/library/audiobook-libraries/${book.libraryId}/series`)
      .then((payload) => setLibrarySeries(payload.series.map((s) => s.name)))
      .catch(() => {});
    api<{ categories: CategorySummary[] }>("/api/library/categories")
      .then((payload) => setCategories(payload.categories))
      .catch(() => {});
  }, [metadataModalOpen, book.libraryId]);

  const splitList = (value: string) => value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  const searchMetadata = async () => {
    setMetadataLoading(true);
    setMetadataError("");
    try {
      const params = new URLSearchParams({
        q: metadataQuery || book.title,
        provider: metadataProvider
      });
      const payload = await api<{ candidates: MetadataCandidate[] }>(`/api/library/books/${book.id}/metadata-search?${params}`);
      setMetadataResults(payload.candidates);
    } catch (err) {
      setMetadataError(err instanceof Error ? err.message : "Unable to search metadata");
    } finally {
      setMetadataLoading(false);
    }
  };

  const applyMetadata = async (candidate: MetadataCandidate, index: number) => {
    setApplyingIndex(index);
    setMetadataError("");
    try {
      const payload = await api<{ updated: boolean; book: AudiobookBookDetail }>(`/api/library/books/${book.id}/metadata-match`, {
        method: "POST",
        body: JSON.stringify({
          candidate,
          updateDetails,
          updateCover: updateCover && Boolean(candidate.coverUrl)
        })
      });
      onBookUpdated(payload.book);
      setMetadataResults([]);
      setMetadataModalOpen(false);
    } catch (err) {
      setMetadataError(err instanceof Error ? err.message : "Unable to apply metadata");
    } finally {
      setApplyingIndex(null);
    }
  };

  const resetMetadata = async () => {
    setResetting(true);
    setResetError("");
    try {
      const payload = await api<{ reset: boolean; book: AudiobookBookDetail }>(`/api/library/books/${book.id}/metadata-reset`, { method: "POST" });
      onBookUpdated(payload.book);
      setResetConfirm(false);
    } catch (err) {
      setResetError(err instanceof Error ? err.message : "Unable to reset metadata");
    } finally {
      setResetting(false);
    }
  };

  const saveManualMetadata = async () => {
    setEditSaving(true);
    setEditError("");
    try {
      const payload = await api<{ updated: boolean; book: AudiobookBookDetail }>(`/api/library/books/${book.id}/metadata`, {
        method: "PATCH",
        body: JSON.stringify({
          title: editForm.title,
          series: editForm.series || null,
          seriesPosition: editForm.seriesPosition ? Number(editForm.seriesPosition) : null,
          authors: editForm.authors,
          narrators: editForm.narrators,
          tags: splitList(editForm.tags),
          categoryKey: editForm.categoryKey || null,
          publisher: editForm.publisher || null,
          yearPublished: editForm.yearPublished ? Number(editForm.yearPublished) : null,
          description: editForm.description || null,
          language: editForm.language || null,
          isbn: editForm.isbn || null,
          asin: editForm.asin || null
        })
      });
      onBookUpdated(payload.book);
      setMetadataModalOpen(false);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Unable to save metadata");
    } finally {
      setEditSaving(false);
    }
  };

  const markBookFinished = async () => {
    setProgressAction("complete");
    setProgressActionError("");
    try {
      await api(`/api/library/books/${book.id}/progress/complete`, { method: "POST", body: "{}" });
    } catch (err) {
      setProgressActionError(err instanceof Error ? err.message : "Unable to mark book finished");
    } finally {
      setProgressAction("");
    }
  };

  const applyFolderCover = async (cover: CoverCandidate) => {
    setCoverSaving(cover.relativePath);
    setCoverError("");
    try {
      const payload = await api<{ updated: boolean; book: AudiobookBookDetail }>(`/api/library/books/${book.id}/cover`, {
        method: "POST",
        body: JSON.stringify({ relativePath: cover.relativePath })
      });
      showUpdatedCover(payload.book);
    } catch (err) {
      setCoverError(err instanceof Error ? err.message : "Unable to apply cover");
    } finally {
      setCoverSaving("");
    }
  };

  const uploadCover = async (file: File | null) => {
    if (!file) {
      return;
    }

    setCoverSaving("upload");
    setCoverError("");
    try {
      const payload = await api<{ updated: boolean; book: AudiobookBookDetail }>(`/api/library/books/${book.id}/cover`, {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file
      });
      showUpdatedCover(payload.book);
    } catch (err) {
      setCoverError(err instanceof Error ? err.message : "Unable to upload cover");
    } finally {
      setCoverSaving("");
    }
  };

  const showUpdatedCover = (updatedBook: AudiobookBookDetail) => {
    const version = Date.now();
    onBookUpdated({
      ...updatedBook,
      coverUrl: updatedBook.coverUrl ? `${updatedBook.coverUrl}?v=${version}` : updatedBook.coverUrl,
      coverLargeUrl: updatedBook.coverLargeUrl ? `${updatedBook.coverLargeUrl}?v=${version}` : updatedBook.coverLargeUrl
    });
  };

  type DetailRow = { label: string; value: string; group: "core" | "extra"; className?: string };
  const detailRows: DetailRow[] = [
    book.series ? {
      label: "Series",
      value: `${book.series}${book.seriesPosition != null ? ` #${book.seriesPosition}` : ""}`,
      group: "core"
    } : null,
    book.narrators.length > 0 ? {
      label: "Narrators",
      value: book.narrators.join(", "),
      group: "core"
    } : null,
    book.durationSeconds != null ? {
      label: "Duration",
      value: formatDuration(book.durationSeconds),
      group: "core"
    } : null,
    book.yearPublished ? {
      label: "Published",
      value: String(book.yearPublished),
      group: "core"
    } : null,
    book.totalSize > 0 ? {
      label: "Size",
      value: formatBytes(book.totalSize),
      group: "core"
    } : null,
    book.authors.length > 0 ? {
      label: "Authors",
      value: book.authors.join(", "),
      group: "extra"
    } : null,
    book.language ? {
      label: "Language",
      value: book.language,
      group: "extra"
    } : null,
    book.publisher ? {
      label: "Publisher",
      value: book.publisher,
      group: "extra"
    } : null,
    book.category ? {
      label: "Category",
      value: book.category.name,
      group: "main"
    } : null,
    book.isbn ? {
      label: "ISBN",
      value: book.isbn,
      group: "extra"
    } : null,
    book.asin ? {
      label: "ASIN",
      value: book.asin,
      group: "extra"
    } : null,
    {
      label: "Path",
      value: book.folderPath,
      group: "extra",
      className: "book-folder-path"
    }
  ].filter((row): row is DetailRow => Boolean(row));
  const coreDetailRows = detailRows.filter((row) => row.group === "core");
  const collapsedDetailRows = coreDetailRows.length > 0 ? coreDetailRows : detailRows.slice(0, 3);
  const visibleDetailRows = detailsExpanded ? detailRows : collapsedDetailRows;
  const canExpandDetails = detailRows.length > collapsedDetailRows.length;
  const hiddenDetailCount = detailRows.length - collapsedDetailRows.length;
  const descriptionText = book.description?.trim() ?? "";
  const canExpandDescription = descriptionText.length > 420;
  const visibleDescription = canExpandDescription && !descriptionExpanded
    ? `${descriptionText.slice(0, 420).trimEnd()}...`
    : descriptionText;

  return (
    <div className="book-detail-view">
      <button className="back-link" onClick={onBack}>
        ← Audiobooks
      </button>

      <div className="book-detail-head">
        <div className="book-detail-cover-col">
          <div className="book-detail-cover" aria-hidden="true">
            {book.coverUrl ? (
              <img src={book.coverLargeUrl ?? book.coverUrl} alt="" />
            ) : (
              <>
                <BookOpen size={32} />
                <strong>{book.title.slice(0, 2).toUpperCase()}</strong>
              </>
            )}
          </div>

          {book.tags.length > 0 && (
            <section className="book-tags book-tags-under-cover" aria-label="Tags">
              {book.tags.map((tag) => (
                <button
                  className="book-tag-chip"
                  key={tag}
                  type="button"
                  onClick={() => navigate(`/audiobooks/tags/${encodeURIComponent(tag)}`)}
                >
                  {tag}
                </button>
              ))}
            </section>
          )}
        </div>

        <div className="book-detail-info">
          <p className="eyebrow">{book.libraryName}</p>
          <h1 className="book-detail-title">{book.title}</h1>
          {book.authors.length > 0 && (
            <p className="book-detail-author">by {book.authors.join(", ")}</p>
          )}

          <dl className="book-detail-meta">
            {visibleDetailRows.map((row) => (
              <div key={row.label}>
                <dt>{row.label}</dt>
                <dd className={row.className}>{row.value}</dd>
              </div>
            ))}
          </dl>
          {canExpandDetails && (
            <button
              className="book-detail-more"
              type="button"
              onClick={() => setDetailsExpanded((expanded) => !expanded)}
              aria-expanded={detailsExpanded}
            >
              {detailsExpanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
              <span>{detailsExpanded ? "Show fewer details" : `Show ${hiddenDetailCount} more detail${hiddenDetailCount === 1 ? "" : "s"}`}</span>
            </button>
          )}

          <div className="book-detail-actions">
            <button
              className="primary-button"
              onClick={() => window.open(`/player/${book.id}`, "isputnik-player", "width=500,height=800,resizable=yes,scrollbars=yes")}
            >
              <Play size={16} />
              <span>Play</span>
            </button>
            <button className="secondary-button" onClick={() => { setActiveMetadataTab("edit"); setMetadataModalOpen(true); }}>
              <Pencil size={16} />
              <span>Edit metadata</span>
            </button>
            <button className="secondary-button" onClick={markBookFinished} disabled={progressAction !== ""}>
              <CheckCircle2 size={16} />
              <span>{progressAction === "complete" ? "Saving..." : "Mark finished"}</span>
            </button>
            <a className="secondary-button" href={`/api/library/books/${book.id}/download`} download>
              <Download size={16} />
              <span>Download</span>
            </a>
            <button className="secondary-button" onClick={() => setShareModalOpen(true)}>
              <Share2 size={16} />
              <span>Share</span>
            </button>
          </div>
          {progressActionError && <MessageBox tone="error" title="Progress error">{progressActionError}</MessageBox>}

          {descriptionText && (
            <section className="book-description-block">
              <p className="book-description">{visibleDescription}</p>
              {canExpandDescription && (
                <button
                  className="book-detail-more book-description-more"
                  type="button"
                  onClick={() => setDescriptionExpanded((expanded) => !expanded)}
                  aria-expanded={descriptionExpanded}
                >
                  {descriptionExpanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                  <span>{descriptionExpanded ? "Show less description" : "Show full description"}</span>
                </button>
              )}
            </section>
          )}

          {book.documents.length > 0 && (
            <section className="book-documents-section">
              <h2 className="book-documents-title">Documents</h2>
              <div className="book-document-list">
                {book.documents.map((doc) => (
                  <div className="book-document-row" key={doc.id}>
                    <FileText size={18} aria-hidden="true" />
                    <div className="book-document-info">
                      <strong>{doc.fileName}</strong>
                      <small>{doc.format.toUpperCase()} · {formatBytes(doc.size)}</small>
                    </div>
                    {VIEWABLE_DOC_FORMATS.has(doc.format) && (
                      <button
                        className="secondary-button compact-button"
                        onClick={() => setViewerDoc({ id: doc.id, fileName: doc.fileName, url: doc.url })}
                      >
                        <BookOpen size={15} />
                        <span>Read</span>
                      </button>
                    )}
                    <a className="secondary-button compact-button" href={`${doc.url}?download`} download>
                      <Download size={15} />
                      <span>Download</span>
                    </a>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="book-files-section">
            <button
              className="book-files-toggle"
              onClick={() => setFilesOpen((open) => !open)}
              aria-expanded={filesOpen}
            >
              <span>Files</span>
              <span className="book-files-count">{book.files.length}</span>
              {filesOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
            </button>

            {filesOpen && (
              <div className="book-file-list">
                {book.files.map((file, index) => {
                  const state = fileState(index);
                  return (
                    <article className="book-file-row" key={file.id}>
                      <span>{file.trackNumber ?? "-"}</span>
                      <div>
                        <strong>{file.chapterTitle || file.relativePath.split("/").at(-1) || file.relativePath}</strong>
                        <small>{file.relativePath}</small>
                      </div>
                      <span className={`book-file-status ${state}`}>
                        {state === "completed" && (<><CheckCircle2 size={13} /> Done</>)}
                        {state === "in_progress" && (<><span className="book-file-dot" /> Playing</>)}
                        {state === "not_started" && "—"}
                      </span>
                      <small>
                        {file.durationSeconds != null ? `${formatDuration(file.durationSeconds)} · ` : ""}
                        {formatBytes(file.size)}
                      </small>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </div>

      {shareModalOpen && (
        <ShareModal bookId={book.id} bookTitle={book.title} onClose={() => setShareModalOpen(false)} />
      )}

      {viewerDoc && createPortal(
        <div className="doc-viewer-backdrop" role="dialog" aria-modal="true" aria-label={viewerDoc.fileName}>
          <div className="doc-viewer-head">
            <span className="doc-viewer-name">{viewerDoc.fileName}</span>
            <div className="doc-viewer-actions">
              <a className="secondary-button compact-button" href={`${viewerDoc.url}?download`} download>
                <Download size={15} />
                <span>Download</span>
              </a>
              <button className="modal-close" onClick={() => setViewerDoc(null)} aria-label="Close reader">
                <X size={18} />
              </button>
            </div>
          </div>
          <iframe className="doc-viewer-frame" src={viewerDoc.url} title={viewerDoc.fileName} />
        </div>,
        document.body
      )}

      {metadataModalOpen && (
        <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) { setMetadataModalOpen(false); setResetConfirm(false); } }}>
          <div className="metadata-modal" role="dialog" aria-modal="true" aria-label="Metadata">
            <div className="modal-header">
              <h2>Metadata</h2>
              <button className="modal-close" onClick={() => { setMetadataModalOpen(false); setResetConfirm(false); }} aria-label="Close">
                <X size={18} />
              </button>
            </div>

            <div className="modal-tabs">
              <button className={`modal-tab${activeMetadataTab === "edit" ? " active" : ""}`} onClick={() => setActiveMetadataTab("edit")}>
                Metadata
              </button>
              <button className={`modal-tab${activeMetadataTab === "cover" ? " active" : ""}`} onClick={() => setActiveMetadataTab("cover")}>
                Cover
              </button>
              <button className={`modal-tab${activeMetadataTab === "lookup" ? " active" : ""}`} onClick={() => setActiveMetadataTab("lookup")}>
                Metadata Lookup
              </button>
            </div>

            <div className="modal-tab-content">
              {activeMetadataTab === "edit" ? (
                <>
                  <div className="metadata-edit-grid">
                    <label className="field metadata-field-half">
                      <span>Title</span>
                      <input value={editForm.title} onChange={(event) => setEditForm((form) => ({ ...form, title: event.target.value }))} />
                    </label>
                    <div className="field metadata-field-series-name">
                      <span>Series</span>
                      <SuggestInput
                        value={editForm.series}
                        onChange={(v) => setEditForm((form) => ({ ...form, series: v }))}
                        suggestions={librarySeries}
                        placeholder="Series name…"
                      />
                    </div>
                    <label className="field metadata-field-series-pos">
                      <span>#</span>
                      <input
                        type="number"
                        min="0"
                        step="0.1"
                        value={editForm.seriesPosition}
                        onChange={(event) => setEditForm((form) => ({ ...form, seriesPosition: event.target.value }))}
                        placeholder="1"
                      />
                    </label>
                    <div className="field metadata-field-half">
                      <span>Authors</span>
                      <PeopleCombobox
                        value={editForm.authors}
                        onChange={(v) => setEditForm((form) => ({ ...form, authors: v }))}
                        suggestions={libraryPeople}
                        placeholder="Add author…"
                      />
                    </div>
                    <div className="field metadata-field-half">
                      <span>Narrators</span>
                      <PeopleCombobox
                        value={editForm.narrators}
                        onChange={(v) => setEditForm((form) => ({ ...form, narrators: v }))}
                        suggestions={libraryPeople}
                        placeholder="Add narrator…"
                      />
                    </div>
                    <label className="field metadata-field-half">
                      <span>Category</span>
                      <select value={editForm.categoryKey} onChange={(event) => setEditForm((form) => ({ ...form, categoryKey: event.target.value }))}>
                        <option value="">Auto (from scan)</option>
                        {categories.map((category) => (
                          <option key={category.key} value={category.key}>{category.name}</option>
                        ))}
                      </select>
                    </label>
                    <label className="field metadata-field-half">
                      <span>Tags</span>
                      <input
                        value={editForm.tags}
                        onChange={(event) => setEditForm((form) => ({ ...form, tags: event.target.value }))}
                        placeholder="Comma-separated, e.g. cyberpunk, попаданцы"
                      />
                    </label>
                    <label className="field metadata-field-half">
                      <span>Publisher</span>
                      <input value={editForm.publisher} onChange={(event) => setEditForm((form) => ({ ...form, publisher: event.target.value }))} />
                    </label>
                    <label className="field">
                      <span>Year</span>
                      <input type="number" value={editForm.yearPublished} onChange={(event) => setEditForm((form) => ({ ...form, yearPublished: event.target.value }))} />
                    </label>
                    <label className="field">
                      <span>Language</span>
                      <input value={editForm.language} onChange={(event) => setEditForm((form) => ({ ...form, language: event.target.value }))} />
                    </label>
                    <label className="field">
                      <span>ISBN</span>
                      <input value={editForm.isbn} onChange={(event) => setEditForm((form) => ({ ...form, isbn: event.target.value }))} />
                    </label>
                    <label className="field">
                      <span>ASIN</span>
                      <input value={editForm.asin} onChange={(event) => setEditForm((form) => ({ ...form, asin: event.target.value }))} />
                    </label>
                    <label className="field metadata-field-wide">
                      <span>Description</span>
                      <textarea value={editForm.description} onChange={(event) => setEditForm((form) => ({ ...form, description: event.target.value }))} rows={4} />
                    </label>
                  </div>

                  {editError && <MessageBox tone="error" title="Metadata edit error">{editError}</MessageBox>}

                  <div className="metadata-actions">
                    <button className="primary-button" onClick={saveManualMetadata} disabled={editSaving || !editForm.title.trim()}>
                      <Save size={16} />
                      <span>{editSaving ? "Saving..." : "Save metadata"}</span>
                    </button>
                    {book.metadataSource === "manual" && !resetConfirm && (
                      <button className="secondary-button" onClick={() => setResetConfirm(true)}>
                        <RotateCcw size={16} />
                        <span>Reset to auto</span>
                      </button>
                    )}
                  </div>

                  {resetConfirm && (
                    <div className="metadata-reset-confirm">
                      <p>This will replace all manually edited fields with data from the file scan. Continue?</p>
                      <div className="metadata-actions">
                        <button className="primary-button" onClick={resetMetadata} disabled={resetting}>
                          <RotateCcw size={16} />
                          <span>{resetting ? "Resetting..." : "Yes, reset"}</span>
                        </button>
                        <button className="secondary-button" onClick={() => setResetConfirm(false)} disabled={resetting}>
                          Cancel
                        </button>
                      </div>
                      {resetError && <MessageBox tone="error" title="Reset error">{resetError}</MessageBox>}
                    </div>
                  )}
                </>
              ) : activeMetadataTab === "cover" ? (
                <>
                  <div className="cover-tab-layout">
                    <section className="cover-current-panel">
                      <span>Current cover</span>
                      <div className="cover-current-preview">
                        {book.coverUrl ? (
                          <img src={book.coverLargeUrl ?? book.coverUrl} alt="" />
                        ) : (
                          <BookOpen size={34} />
                        )}
                      </div>
                    </section>

                    <section className="cover-picker-panel">
                      <div className="cover-picker-head">
                        <div>
                          <strong>Folder covers</strong>
                          <span>{coverLoading ? "Scanning folder..." : `${coverCandidates.length} image file${coverCandidates.length === 1 ? "" : "s"}`}</span>
                        </div>
                        <button className="secondary-button compact-button" onClick={loadCoverCandidates} disabled={coverLoading || Boolean(coverSaving)}>
                          <RotateCcw size={14} />
                          <span>Refresh</span>
                        </button>
                      </div>

                      <div className="cover-candidate-grid">
                        {coverCandidates.map((cover) => (
                          <button
                            className="cover-candidate"
                            key={cover.relativePath}
                            onClick={() => applyFolderCover(cover)}
                            disabled={Boolean(coverSaving)}
                          >
                            <img src={cover.previewUrl} alt="" />
                            <span>{cover.name}</span>
                            <small>{formatBytes(cover.size)}</small>
                            <strong>{coverSaving === cover.relativePath ? "Applying..." : "Apply"}</strong>
                          </button>
                        ))}
                        {!coverLoading && coverCandidates.length === 0 && (
                          <p className="management-empty">No cover image files were found in this audiobook folder.</p>
                        )}
                      </div>
                    </section>
                  </div>

                  <label className="cover-upload-panel">
                    <Upload size={18} />
                    <span>{coverSaving === "upload" ? "Uploading..." : "Upload new cover"}</span>
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      disabled={Boolean(coverSaving)}
                      onChange={(event) => {
                        uploadCover(event.target.files?.[0] ?? null);
                        event.currentTarget.value = "";
                      }}
                    />
                  </label>

                  {coverError && <MessageBox tone="error" title="Cover error">{coverError}</MessageBox>}
                </>
              ) : (
                <>
                  <div className="metadata-search-row">
                    <select
                      className="library-filter"
                      value={metadataProvider}
                      onChange={(event) => setMetadataProvider(event.target.value as typeof metadataProvider)}
                      aria-label="Metadata provider"
                    >
                      <option value="all">All providers</option>
                      <option value="itunes">iTunes</option>
                      <option value="openlibrary">Open Library</option>
                      <option value="fantlab">FantLab</option>
                    </select>
                    <label className="search-field">
                      <Search size={17} aria-hidden="true" />
                      <input
                        type="search"
                        value={metadataQuery}
                        onChange={(event) => setMetadataQuery(event.target.value)}
                        placeholder="Search title or ASIN"
                        aria-label="Search metadata"
                      />
                    </label>
                    <button className="primary-button metadata-search-button" onClick={searchMetadata} disabled={metadataLoading}>
                      <Search size={16} />
                      <span>{metadataLoading ? "Searching..." : "Search"}</span>
                    </button>
                  </div>

                  <div className="metadata-apply-controls">
                    <label>
                      <input type="checkbox" checked={updateDetails} onChange={(event) => setUpdateDetails(event.target.checked)} />
                      <span>Update details</span>
                    </label>
                    <label>
                      <input type="checkbox" checked={updateCover} onChange={(event) => setUpdateCover(event.target.checked)} />
                      <span>Update cover</span>
                    </label>
                  </div>

                  {metadataError && <MessageBox tone="error" title="Metadata lookup error">{metadataError}</MessageBox>}

                  <div className="metadata-results">
                    {metadataResults.map((candidate, index) => (
                      <article className="metadata-result-card" key={`${candidate.source}-${candidate.title}-${index}`}>
                        <div className="metadata-result-cover" aria-hidden="true">
                          {candidate.coverUrl ? <img src={candidate.coverUrl} alt="" /> : <BookOpen size={22} />}
                        </div>
                        <div className="metadata-result-body">
                          <div className="metadata-result-title-row">
                            <strong>{candidate.title}</strong>
                            {candidate.year && <b>{candidate.year}</b>}
                          </div>
                          <span>{candidate.authors.length > 0 ? `by ${candidate.authors.join(", ")}` : "Unknown author"}</span>
                          <small>
                            {[candidate.narrators?.length ? `Narrators: ${candidate.narrators.join(", ")}` : "", candidate.publisher, candidate.source]
                              .filter(Boolean)
                              .join(" · ")}
                          </small>
                          {candidate.subtitle && <em>{candidate.subtitle}</em>}
                          {candidate.description && <p>{candidate.description}</p>}
                        </div>
                        <button
                          className="primary-button compact-button metadata-apply-button"
                          onClick={() => applyMetadata(candidate, index)}
                          disabled={applyingIndex !== null}
                        >
                          <CheckCircle2 size={15} />
                          <span>{applyingIndex === index ? "Applying..." : "Apply"}</span>
                        </button>
                      </article>
                    ))}
                    {!metadataLoading && metadataResults.length === 0 && (
                      <p className="management-empty">Search for a provider match to update details and cover art.</p>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

function SuggestInput({
  value,
  onChange,
  suggestions,
  placeholder
}: {
  value: string;
  onChange: (value: string) => void;
  suggestions: string[];
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const filtered = suggestions.filter((s) => s.toLowerCase().includes(value.toLowerCase()));

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div className="suggest-input" ref={containerRef}>
      <input
        value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => { if (e.key === "Escape" || e.key === "Enter") setOpen(false); }}
        placeholder={placeholder}
      />
      {open && filtered.length > 0 && (
        <div className="people-combobox-dropdown">
          {filtered.map((s) => (
            <button key={s} type="button" className="people-combobox-option" onMouseDown={(e) => { e.preventDefault(); onChange(s); setOpen(false); }}>
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function PeopleCombobox({
  value,
  onChange,
  suggestions,
  placeholder
}: {
  value: string[];
  onChange: (value: string[]) => void;
  suggestions: string[];
  placeholder?: string;
}) {
  const [inputValue, setInputValue] = useState("");
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const filtered = suggestions.filter(
    (s) => !value.includes(s) && s.toLowerCase().includes(inputValue.toLowerCase())
  );

  const add = (name: string) => {
    const trimmed = name.trim();
    if (trimmed && !value.includes(trimmed)) {
      onChange([...value, trimmed]);
    }
    setInputValue("");
  };

  const remove = (name: string) => {
    onChange(value.filter((v) => v !== name));
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && inputValue.trim()) {
      e.preventDefault();
      add(inputValue);
    } else if (e.key === "Backspace" && !inputValue && value.length > 0) {
      remove(value[value.length - 1]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const showNew = inputValue.trim() && !value.includes(inputValue.trim()) && !filtered.some((s) => s.toLowerCase() === inputValue.trim().toLowerCase());

  return (
    <div className="people-combobox" ref={containerRef}>
      <div className="people-combobox-input-area" onClick={() => inputRef.current?.focus()}>
        {value.map((name) => (
          <span key={name} className="people-chip">
            {name}
            <button type="button" onClick={(e) => { e.stopPropagation(); remove(name); }} aria-label={`Remove ${name}`}>
              <X size={12} />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          value={inputValue}
          onChange={(e) => { setInputValue(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={value.length === 0 ? placeholder : ""}
        />
      </div>
      {open && (filtered.length > 0 || showNew) && (
        <div className="people-combobox-dropdown">
          {filtered.map((s) => (
            <button key={s} type="button" className="people-combobox-option" onMouseDown={(e) => { e.preventDefault(); add(s); }}>
              {s}
            </button>
          ))}
          {showNew && (
            <button type="button" className="people-combobox-option people-combobox-option-new" onMouseDown={(e) => { e.preventDefault(); add(inputValue); }}>
              Add "{inputValue.trim()}"
            </button>
          )}
        </div>
      )}
    </div>
  );
}
