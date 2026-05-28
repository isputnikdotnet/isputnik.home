import { useCallback, useEffect, useRef, useState } from "react";
import { BookOpen, CheckCircle2, ChevronDown, ChevronUp, Download, Eye, FastForward, List, Pause, Pencil, Play, Rewind, RotateCcw, Save, Search, SkipBack, SkipForward, Sparkles, Volume2, VolumeX, X } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { MessageBox } from "../../shared/MessageBox";
import { formatBytes, formatDuration } from "../../shared/utils";
import type { AudiobookBook, AudiobookBookDetail, AudiobookFile, AudiobookLibrary, MetadataCandidate, PlaybackProgress } from "./types";

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
  const [selectedBookDetail, setSelectedBookDetail] = useState<AudiobookBookDetail | null>(null);
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
    const onPop = () => {
      if (window.location.pathname === "/audiobooks") setSelectedBookDetail(null);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    api<{ libraries: AudiobookLibrary[] }>("/api/library/audiobook-libraries")
      .then(async (payload) => {
        setLibraries(payload.libraries);
        setSelectedLibraryId("all");
        await loadMissingLibraryBooks(payload.libraries.map((library) => library.id));
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
          await loadMissingLibraryBooks(payload.libraries.map((library) => library.id));
        })
        .catch((err) => setError(err instanceof Error ? err.message : "Unable to refresh audiobooks"));
    }, 3000);

    return () => window.clearInterval(timer);
  }, [libraries, loadMissingLibraryBooks]);

  const visibleLibraryIds = selectedLibraryId === "all"
    ? libraries.map((library) => library.id)
    : [selectedLibraryId];
  const searchTerm = bookSearch.trim().toLowerCase();
  const visibleBooks = visibleLibraryIds
    .flatMap((libraryId) => (booksByLibrary[libraryId] ?? []).map((book) => ({
      ...book,
      libraryName: libraries.find((library) => library.id === libraryId)?.name ?? "Audiobooks"
    })))
    .filter((book) => {
      if (!searchTerm) {
        return true;
      }

      return [
        book.title,
        book.folderPath,
        book.libraryName,
        ...book.authors
      ].some((value) => value.toLowerCase().includes(searchTerm));
    });

  const handleLibraryFilter = (libraryId: string) => {
    setSelectedLibraryId(libraryId);
    const idsToLoad = libraryId === "all" ? libraries.map((library) => library.id) : [libraryId];
    const missingIds = idsToLoad.filter((id) => !booksByLibrary[id]);
    if (missingIds.length > 0) {
      loadMissingLibraryBooks(missingIds).catch((err) => setError(err instanceof Error ? err.message : "Unable to load books"));
    }
  };

  const openBookDetail = async (bookId: string) => {
    setError("");
    try {
      const payload = await api<{ book: AudiobookBookDetail }>(`/api/library/books/${bookId}`);
      setSelectedBookDetail(payload.book);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load audiobook details");
    }
  };

  return (
    <DashboardShell active="audiobooks" user={user} logout={logout}>
      {selectedBookDetail ? (
        <section className="work-area book-detail-area">
          <BookDetailView
            book={selectedBookDetail}
            onBack={() => setSelectedBookDetail(null)}
            onBookUpdated={setSelectedBookDetail}
          />
        </section>
      ) : (
        <section className="work-area audiobook-area">
          <div className="section-head audiobook-head">
            <div>
              <p className="eyebrow">Digital Library</p>
              <div className="title-with-control">
                <h1>Audiobooks</h1>
                {libraries.length > 0 && (
                  <select
                    className="library-filter"
                    value={selectedLibraryId}
                    onChange={(event) => handleLibraryFilter(event.target.value)}
                    aria-label="Filter audiobook library"
                  >
                    <option value="all">All libraries</option>
                    {libraries.map((library) => (
                      <option value={library.id} key={library.id}>{library.name}</option>
                    ))}
                  </select>
                )}
              </div>
            </div>
          </div>

          {error && <MessageBox tone="error" title="Audiobooks error">{error}</MessageBox>}

          {libraries.length === 0 ? (
            <div className="empty-state library-empty">
              <BookOpen size={58} aria-hidden="true" />
              <h2>No audiobook libraries yet</h2>
              <p className="muted">An administrator can add libraries from the control panel.</p>
            </div>
          ) : (
            <>
              <div className="audiobook-toolbar">
                <label className="search-field">
                  <Search size={17} aria-hidden="true" />
                  <input
                    type="search"
                    value={bookSearch}
                    onChange={(event) => setBookSearch(event.target.value)}
                    placeholder="Search title, author, or library"
                    aria-label="Search audiobooks"
                  />
                </label>
                <span>{visibleBooks.length} {visibleBooks.length === 1 ? "book" : "books"}</span>
              </div>

              {libraries.some((library) => library.scanStatus === "scanning") && (
                <MessageBox tone="info" title="Scanning audiobooks">
                  New metadata and covers will appear as the scan finishes.
                </MessageBox>
              )}

              <div className="audiobook-grid">
                {visibleBooks.map((book) => (
                  <button className="audiobook-card" key={book.id} onClick={() => openBookDetail(book.id)}>
                    <div className="audiobook-cover" aria-hidden="true">
                      {book.coverUrl ? (
                        <img src={book.coverUrl} alt="" />
                      ) : (
                        <>
                          <BookOpen size={13} />
                          <strong>{book.title.slice(0, 2).toUpperCase()}</strong>
                        </>
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
                ))}
                {visibleBooks.length === 0 && <p className="management-empty">No audiobooks match this filter.</p>}
              </div>
            </>
          )}
        </section>
      )}
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
  const [metadataModalOpen, setMetadataModalOpen] = useState(false);
  const [activeMetadataTab, setActiveMetadataTab] = useState<"edit" | "lookup">("edit");
  const [metadataQuery, setMetadataQuery] = useState(`${book.title} ${book.authors[0] ?? ""}`.trim());
  const [metadataProvider, setMetadataProvider] = useState<"all" | MetadataCandidate["source"]>("all");
  const [updateDetails, setUpdateDetails] = useState(true);
  const [updateCover, setUpdateCover] = useState(true);
  const [metadataResults, setMetadataResults] = useState<MetadataCandidate[]>([]);
  const [metadataLoading, setMetadataLoading] = useState(false);
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const [applyingIndex, setApplyingIndex] = useState<number | null>(null);
  const [metadataError, setMetadataError] = useState("");
  const [resetting, setResetting] = useState(false);
  const [resetConfirm, setResetConfirm] = useState(false);
  const [resetError, setResetError] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState("");
  const [editForm, setEditForm] = useState(() => ({
    title: book.title,
    authors: book.authors.join(", "),
    narrators: book.narrators.join(", "),
    genres: book.genres.join(", "),
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
      authors: book.authors.join(", "),
      narrators: book.narrators.join(", "),
      genres: book.genres.join(", "),
      publisher: book.publisher ?? "",
      yearPublished: book.yearPublished?.toString() ?? "",
      language: book.language ?? "",
      isbn: book.isbn ?? "",
      asin: book.asin ?? "",
      description: book.description ?? ""
    });
  }, [book]);

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
      setExpandedIndex(null);
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
          authors: splitList(editForm.authors),
          narrators: splitList(editForm.narrators),
          genres: splitList(editForm.genres),
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

  const diffRows = (candidate: MetadataCandidate) => {
    const rows: { label: string; current: string; next: string; changed: boolean }[] = [];
    const add = (label: string, current: string | null | undefined, next: string | null | undefined) => {
      if (next == null || next === "") return;
      rows.push({ label, current: current || "—", next, changed: current !== next });
    };
    add("Title", book.title, candidate.title);
    add("Authors", book.authors.join(", ") || null, candidate.authors.join(", "));
    add("Narrators", book.narrators.join(", ") || null, candidate.narrators?.join(", "));
    add("Year", book.yearPublished?.toString(), candidate.year?.toString());
    add("Publisher", book.publisher, candidate.publisher);
    add("Language", book.language, candidate.language);
    add("Genres", book.genres.join(", ") || null, candidate.genres?.join(", "));
    add("ISBN", book.isbn, candidate.isbn);
    return rows;
  };

  return (
    <div className="book-detail-view">
      <button className="back-link" onClick={onBack}>
        ← Audiobooks
      </button>

      <div className="book-detail-head">
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

        <div className="book-detail-info">
          <p className="eyebrow">{book.libraryName}</p>
          <h1 className="book-detail-title">{book.title}</h1>
          {book.authors.length > 0 && (
            <p className="book-detail-author">by {book.authors.join(", ")}</p>
          )}

          <dl className="book-detail-meta">
            {book.authors.length > 0 && (
              <div>
                <dt>Authors</dt>
                <dd>{book.authors.join(", ")}</dd>
              </div>
            )}
            {book.narrators.length > 0 && (
              <div>
                <dt>Narrators</dt>
                <dd>{book.narrators.join(", ")}</dd>
              </div>
            )}
            {book.yearPublished && (
              <div>
                <dt>Published</dt>
                <dd>{book.yearPublished}</dd>
              </div>
            )}
            {book.language && (
              <div>
                <dt>Language</dt>
                <dd>{book.language}</dd>
              </div>
            )}
            {book.durationSeconds != null && (
              <div>
                <dt>Duration</dt>
                <dd>{formatDuration(book.durationSeconds)}</dd>
              </div>
            )}
            {book.totalSize > 0 && (
              <div>
                <dt>Size</dt>
                <dd>{formatBytes(book.totalSize)}</dd>
              </div>
            )}
            {book.isbn && (
              <div>
                <dt>ISBN</dt>
                <dd>{book.isbn}</dd>
              </div>
            )}
            {book.asin && (
              <div>
                <dt>ASIN</dt>
                <dd>{book.asin}</dd>
              </div>
            )}
            {book.publisher && (
              <div>
                <dt>Publisher</dt>
                <dd>{book.publisher}</dd>
              </div>
            )}
            {book.genres.length > 0 && (
              <div>
                <dt>Genres</dt>
                <dd>{book.genres.join(", ")}</dd>
              </div>
            )}
          </dl>
        </div>
      </div>

      {book.description && (
        <p className="book-description">{book.description}</p>
      )}

      <div className="book-detail-actions">
        <button className="secondary-button" onClick={() => { setActiveMetadataTab("edit"); setMetadataModalOpen(true); }}>
          <Pencil size={16} />
          <span>Edit metadata</span>
        </button>
        <button className="secondary-button" onClick={() => { setActiveMetadataTab("lookup"); setMetadataModalOpen(true); }}>
          <Sparkles size={16} />
          <span>Metadata lookup</span>
        </button>
        <a className="secondary-button" href={`/api/library/books/${book.id}/download`} download>
          <Download size={16} />
          <span>Download</span>
        </a>
      </div>

      <AudioPlayer book={book} />

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
              <button className={`modal-tab${activeMetadataTab === "lookup" ? " active" : ""}`} onClick={() => setActiveMetadataTab("lookup")}>
                Metadata Lookup
              </button>
            </div>

            <div className="modal-tab-content">
              {activeMetadataTab === "edit" ? (
                <>
                  <div className="metadata-edit-grid">
                    <label className="field metadata-field-wide">
                      <span>Title</span>
                      <input value={editForm.title} onChange={(event) => setEditForm((form) => ({ ...form, title: event.target.value }))} />
                    </label>
                    <label className="field">
                      <span>Authors</span>
                      <input value={editForm.authors} onChange={(event) => setEditForm((form) => ({ ...form, authors: event.target.value }))} />
                    </label>
                    <label className="field">
                      <span>Narrators</span>
                      <input value={editForm.narrators} onChange={(event) => setEditForm((form) => ({ ...form, narrators: event.target.value }))} />
                    </label>
                    <label className="field">
                      <span>Genres</span>
                      <input value={editForm.genres} onChange={(event) => setEditForm((form) => ({ ...form, genres: event.target.value }))} />
                    </label>
                    <label className="field">
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
                      <textarea value={editForm.description} onChange={(event) => setEditForm((form) => ({ ...form, description: event.target.value }))} rows={5} />
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
              ) : (
                <>
                  <div className="metadata-search-row">
                    <label className="search-field">
                      <Search size={17} aria-hidden="true" />
                      <input
                        type="search"
                        value={metadataQuery}
                        onChange={(event) => setMetadataQuery(event.target.value)}
                        placeholder="Search title or author"
                        aria-label="Search metadata"
                      />
                    </label>
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
                    <button className="primary-button" onClick={searchMetadata} disabled={metadataLoading}>
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
                    {metadataResults.map((candidate, index) => {
                      const isExpanded = expandedIndex === index;
                      const rows = isExpanded ? diffRows(candidate) : [];
                      return (
                        <article className="metadata-result-card" key={`${candidate.source}-${candidate.title}-${index}`}>
                          <div className="metadata-result-cover" aria-hidden="true">
                            {candidate.coverUrl ? <img src={candidate.coverUrl} alt="" /> : <BookOpen size={22} />}
                          </div>
                          <div className="metadata-result-body">
                            <strong>{candidate.title}</strong>
                            {candidate.subtitle && <span>{candidate.subtitle}</span>}
                            <small>
                              {[candidate.authors.join(", "), candidate.year, candidate.publisher, candidate.source]
                                .filter(Boolean)
                                .join(" · ")}
                            </small>
                          </div>
                          <button
                            className="secondary-button compact-button"
                            onClick={() => setExpandedIndex(isExpanded ? null : index)}
                            disabled={applyingIndex !== null}
                          >
                            <Eye size={15} />
                            <span>{isExpanded ? "Collapse" : "Preview"}</span>
                          </button>

                          {isExpanded && (
                            <div className="metadata-diff-panel">
                              {candidate.description && (
                                <p className="metadata-diff-description">{candidate.description}</p>
                              )}
                              <table className="metadata-diff-table">
                                <thead>
                                  <tr><th>Field</th><th>Current</th><th>Candidate</th></tr>
                                </thead>
                                <tbody>
                                  {rows.map((row) => (
                                    <tr key={row.label} className={row.changed ? "diff-changed" : "diff-same"}>
                                      <td>{row.label}</td>
                                      <td>{row.current}</td>
                                      <td>{row.next}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                              {updateCover && candidate.coverUrl && (
                                <div className="metadata-diff-covers">
                                  <div>
                                    <p>Current cover</p>
                                    {book.coverUrl
                                      ? <img src={book.coverUrl} alt="" />
                                      : <div className="cover-placeholder"><BookOpen size={22} /></div>}
                                  </div>
                                  <div>
                                    <p>Candidate cover</p>
                                    <img src={candidate.coverUrl} alt="" />
                                  </div>
                                </div>
                              )}
                              <div className="metadata-actions">
                                <button
                                  className="primary-button"
                                  onClick={() => applyMetadata(candidate, index)}
                                  disabled={applyingIndex !== null}
                                >
                                  <CheckCircle2 size={15} />
                                  <span>{applyingIndex === index ? "Applying..." : "Apply"}</span>
                                </button>
                                <button className="secondary-button" onClick={() => setExpandedIndex(null)} disabled={applyingIndex !== null}>
                                  Cancel
                                </button>
                              </div>
                            </div>
                          )}
                        </article>
                      );
                    })}
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
            {book.files.map((file) => (
              <article className="book-file-row" key={file.id}>
                <span>{file.trackNumber ?? "-"}</span>
                <div>
                  <strong>{file.chapterTitle || file.relativePath.split("/").at(-1) || file.relativePath}</strong>
                  <small>{file.relativePath}</small>
                </div>
                <small>
                  {file.durationSeconds != null ? `${formatDuration(file.durationSeconds)} · ` : ""}
                  {formatBytes(file.size)}
                </small>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function formatTime(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];

function AudioPlayer({ book }: { book: AudiobookBookDetail }) {
  const availableFiles = book.files.filter((f) => f.status === "available");
  const audioRef = useRef<HTMLAudioElement>(null);
  const pendingSeekRef = useRef<number | null>(null);
  const shouldAutoPlayRef = useRef(false);
  const saveIntervalRef = useRef<number | null>(null);

  const [fileIndex, setFileIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [fileDuration, setFileDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [speedOpen, setSpeedOpen] = useState(false);
  const [chaptersOpen, setChaptersOpen] = useState(false);
  const [playerError, setPlayerError] = useState("");

  const totalDuration = availableFiles.reduce((sum, f) => sum + (f.durationSeconds ?? 0), 0);
  const completedDuration = availableFiles.slice(0, fileIndex).reduce((sum, f) => sum + (f.durationSeconds ?? 0), 0);
  const bookPosition = completedDuration + currentTime;

  const currentFile: AudiobookFile | undefined = availableFiles[fileIndex];

  const saveProgress = useCallback((file: AudiobookFile, position: number) => {
    api(`/api/library/books/${book.id}/progress`, {
      method: "PATCH",
      body: JSON.stringify({ fileId: file.id, positionSeconds: Math.floor(position) })
    }).catch(() => {});
  }, [book.id]);

  const skip = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const newTime = audio.currentTime + seconds;
    if (newTime < 0 && fileIndex > 0) {
      const prevDuration = availableFiles[fileIndex - 1].durationSeconds ?? 0;
      if (currentFile) saveProgress(currentFile, 0);
      shouldAutoPlayRef.current = playing;
      pendingSeekRef.current = Math.max(0, prevDuration + newTime);
      setFileIndex((prev) => prev - 1);
    } else if (fileDuration > 0 && newTime >= fileDuration && fileIndex < availableFiles.length - 1) {
      if (currentFile) saveProgress(currentFile, fileDuration);
      shouldAutoPlayRef.current = playing;
      pendingSeekRef.current = Math.max(0, newTime - fileDuration);
      setFileIndex((prev) => prev + 1);
    } else {
      const clamped = Math.max(0, Math.min(newTime, fileDuration));
      audio.currentTime = clamped;
      setCurrentTime(clamped);
    }
  }, [fileIndex, fileDuration, availableFiles, currentFile, playing, saveProgress]);

  const jumpToChapter = useCallback((index: number) => {
    if (audioRef.current && currentFile) saveProgress(currentFile, audioRef.current.currentTime);
    shouldAutoPlayRef.current = playing;
    pendingSeekRef.current = 0;
    setFileIndex(index);
    setChaptersOpen(false);
  }, [currentFile, playing, saveProgress]);

  // Save progress on tab/window close
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (!currentFile || !audioRef.current) return;
      fetch(`/api/library/books/${book.id}/progress`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileId: currentFile.id, positionSeconds: Math.floor(audioRef.current.currentTime) }),
        keepalive: true
      });
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [book.id, currentFile]);

  // Set src whenever the current file changes. With preload="none" audio.load() only
  // resets the element — no network request happens until play() is called.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !currentFile) return;
    setCurrentTime(0);
    setFileDuration(0);
    setPlayerError("");
    audio.src = `/api/library/books/${book.id}/stream/${currentFile.id}`;
    audio.playbackRate = playbackRate;
    audio.load();
    if (shouldAutoPlayRef.current) {
      shouldAutoPlayRef.current = false;
      audio.play().catch(() => {});
    }
  }, [fileIndex, book.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Restore saved progress once on mount — independent of the src effect
  useEffect(() => {
    if (availableFiles.length === 0) return;
    api<{ progress: PlaybackProgress | null }>(`/api/library/books/${book.id}/progress`)
      .then(({ progress }) => {
        if (!progress?.fileId) return;
        const idx = availableFiles.findIndex((f) => f.id === progress.fileId);
        if (idx < 0) return;
        pendingSeekRef.current = progress.positionSeconds;
        if (idx !== 0) setFileIndex(idx); // triggers src effect for saved file
        // idx === 0: src already loading; pendingSeek applied in handleLoadedMetadata
      })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Periodic save every 10s while playing
  useEffect(() => {
    if (!playing) {
      if (saveIntervalRef.current) clearInterval(saveIntervalRef.current);
      return;
    }
    saveIntervalRef.current = window.setInterval(() => {
      if (audioRef.current && currentFile) {
        saveProgress(currentFile, audioRef.current.currentTime);
      }
    }, 10000);
    return () => { if (saveIntervalRef.current) clearInterval(saveIntervalRef.current); };
  }, [playing, currentFile, saveProgress]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = muted ? 0 : volume;
    audio.muted = muted;
  }, [volume, muted]);

  useEffect(() => {
    if (!speedOpen) return;
    const close = () => setSpeedOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [speedOpen]);

  const handleLoadedMetadata = () => {
    const audio = audioRef.current;
    if (!audio) return;
    setFileDuration(isFinite(audio.duration) ? audio.duration : 0);
    if (pendingSeekRef.current !== null) {
      audio.currentTime = pendingSeekRef.current;
      pendingSeekRef.current = null;
    }
  };

  const handleTimeUpdate = () => {
    if (audioRef.current) setCurrentTime(audioRef.current.currentTime);
  };

  const handleEnded = () => {
    if (!currentFile) return;
    saveProgress(currentFile, audioRef.current?.duration ?? 0);
    if (fileIndex < availableFiles.length - 1) {
      shouldAutoPlayRef.current = true;
      setFileIndex((prev) => prev + 1);
    } else {
      setPlaying(false);
    }
  };

  const handlePlay = () => { setPlaying(true); setPlayerError(""); };
  const handlePause = () => {
    setPlaying(false);
    if (audioRef.current && currentFile) saveProgress(currentFile, audioRef.current.currentTime);
  };
  const handleSeeked = () => {
    if (audioRef.current && currentFile) saveProgress(currentFile, audioRef.current.currentTime);
  };
  const handleError = useCallback(() => {
    setPlaying(false);
    const code = audioRef.current?.error?.code;
    if (code === 3) {
      setPlayerError("Audio decoding error — the file may be corrupt.");
    } else if (code === 2) {
      setPlayerError("Network error while loading audio.");
    } else {
      setPlayerError("Unable to play this file.");
    }
  }, []);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
    } else {
      setPlayerError("");
      audio.play().catch((err) => {
        setPlayerError(err instanceof Error ? err.message : "Playback failed");
      });
    }
  };

  const goToPrev = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (currentTime > 3) {
      audio.currentTime = 0;
    } else if (fileIndex > 0) {
      if (currentFile) saveProgress(currentFile, 0);
      shouldAutoPlayRef.current = playing;
      setFileIndex((prev) => prev - 1);
    }
  };

  const goToNext = () => {
    if (fileIndex < availableFiles.length - 1) {
      if (audioRef.current && currentFile) saveProgress(currentFile, audioRef.current.currentTime);
      shouldAutoPlayRef.current = playing;
      setFileIndex((prev) => prev + 1);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const time = Number(e.target.value);
    if (audioRef.current) audioRef.current.currentTime = time;
    setCurrentTime(time);
  };

  const changeRate = (rate: number) => {
    setPlaybackRate(rate);
    if (audioRef.current) audioRef.current.playbackRate = rate;
    setSpeedOpen(false);
  };

  const toggleMute = () => setMuted((m) => !m);
  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value);
    setVolume(v);
    if (v > 0) setMuted(false);
  };
  const toggleSpeedMenu = (e: React.MouseEvent) => {
    e.stopPropagation();
    setSpeedOpen((open) => !open);
  };

  if (availableFiles.length === 0) return null;

  return (
    <div className="audio-player">
      <audio
        ref={audioRef}
        preload="none"
        onLoadedMetadata={handleLoadedMetadata}
        onTimeUpdate={handleTimeUpdate}
        onEnded={handleEnded}
        onPlay={handlePlay}
        onPause={handlePause}
        onSeeked={handleSeeked}
        onError={handleError}
      />

      <div className="player-chapter">
        <span className="player-chapter-index">{fileIndex + 1} / {availableFiles.length}</span>
        <span className="player-chapter-title">
          {currentFile?.chapterTitle || currentFile?.relativePath.split("/").at(-1) || ""}
        </span>
      </div>

      <div className="player-controls">
        <button className="player-btn player-btn-skip" onClick={() => skip(-30)} aria-label="Skip back 30 seconds">
          <Rewind size={17} />
          <span>30</span>
        </button>
        <button
          className="player-btn"
          onClick={goToPrev}
          disabled={fileIndex === 0 && currentTime <= 3}
          aria-label="Previous chapter"
        >
          <SkipBack size={20} />
        </button>
        <button className="player-btn player-btn-primary" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"}>
          {playing ? <Pause size={22} /> : <Play size={22} />}
        </button>
        <button
          className="player-btn"
          onClick={goToNext}
          disabled={fileIndex >= availableFiles.length - 1}
          aria-label="Next chapter"
        >
          <SkipForward size={20} />
        </button>
        <button className="player-btn player-btn-skip" onClick={() => skip(30)} aria-label="Skip forward 30 seconds">
          <FastForward size={17} />
          <span>30</span>
        </button>
      </div>

      <div className="player-seek">
        <span className="player-time">{formatTime(currentTime)}</span>
        <input
          type="range"
          className="player-seekbar"
          min={0}
          max={fileDuration || 0}
          step={1}
          value={currentTime}
          onChange={handleSeek}
          aria-label="Seek"
        />
        <span className="player-time">{formatTime(fileDuration)}</span>
      </div>

      {totalDuration > 0 && (
        <div className="player-book-progress">
          <span className="player-time">{formatTime(bookPosition)}</span>
          <div className="player-book-bar" role="progressbar" aria-valuenow={bookPosition} aria-valuemax={totalDuration} aria-label="Book progress">
            <div className="player-book-bar-fill" style={{ width: `${Math.min(100, (bookPosition / totalDuration) * 100)}%` }} />
          </div>
          <span className="player-time">{formatTime(totalDuration)}</span>
        </div>
      )}

      <div className="player-aux">
        <div className="player-vol">
          <button className="player-vol-icon" onClick={toggleMute} aria-label={muted ? "Unmute" : "Mute"}>
            {muted || volume === 0 ? <VolumeX size={17} /> : <Volume2 size={17} />}
          </button>
          <input
            type="range"
            className="player-vol-slider"
            min={0}
            max={1}
            step={0.02}
            value={muted ? 0 : volume}
            onChange={handleVolumeChange}
            aria-label="Volume"
          />
        </div>

        <div className="player-speed">
          <button
            className={`player-speed-btn${speedOpen ? " open" : ""}`}
            onClick={toggleSpeedMenu}
            aria-expanded={speedOpen}
            aria-label="Playback speed"
          >
            <span>{playbackRate === 1 ? "1×" : `${playbackRate}×`}</span>
            <ChevronDown size={13} />
          </button>
          {speedOpen && (
            <div className="player-speed-menu" onClick={(e) => e.stopPropagation()}>
              {RATES.map((rate) => (
                <button
                  key={rate}
                  className={`player-speed-option${playbackRate === rate ? " active" : ""}`}
                  onClick={() => changeRate(rate)}
                  aria-pressed={playbackRate === rate}
                >
                  {rate === 1 ? "1×" : `${rate}×`}
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          className={`player-speed-btn${chaptersOpen ? " open" : ""}`}
          onClick={() => setChaptersOpen((o) => !o)}
          aria-expanded={chaptersOpen}
          aria-label="Chapter list"
        >
          <List size={15} />
          <span>Chapters</span>
        </button>
      </div>

      {chaptersOpen && (
        <div className="player-chapter-list">
          {availableFiles.map((file, index) => (
            <button
              key={file.id}
              className={`player-chapter-item${index === fileIndex ? " active" : ""}`}
              onClick={() => jumpToChapter(index)}
            >
              <span className="player-chapter-item-num">{index + 1}</span>
              <span className="player-chapter-item-title">
                {file.chapterTitle || file.relativePath.split("/").at(-1) || `Chapter ${index + 1}`}
              </span>
              {file.durationSeconds != null && (
                <span className="player-chapter-item-dur">{formatTime(file.durationSeconds)}</span>
              )}
            </button>
          ))}
        </div>
      )}

      {playerError && <MessageBox tone="error" title="Playback error">{playerError}</MessageBox>}
    </div>
  );
}
