import { useCallback, useEffect, useState } from "react";
import { BookOpen, CheckCircle2, ChevronDown, ChevronUp, Pencil, Save, Search, Sparkles } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { MessageBox } from "../../shared/MessageBox";
import { formatBytes, formatDuration } from "../../shared/utils";
import type { AudiobookBook, AudiobookBookDetail, AudiobookLibrary, MetadataCandidate } from "./types";

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
  const [lookupOpen, setLookupOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [metadataQuery, setMetadataQuery] = useState(`${book.title} ${book.authors[0] ?? ""}`.trim());
  const [metadataProvider, setMetadataProvider] = useState<"all" | MetadataCandidate["source"]>("all");
  const [updateDetails, setUpdateDetails] = useState(true);
  const [updateCover, setUpdateCover] = useState(true);
  const [metadataResults, setMetadataResults] = useState<MetadataCandidate[]>([]);
  const [metadataLoading, setMetadataLoading] = useState(false);
  const [applyingIndex, setApplyingIndex] = useState<number | null>(null);
  const [metadataError, setMetadataError] = useState("");
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
      setLookupOpen(false);
    } catch (err) {
      setMetadataError(err instanceof Error ? err.message : "Unable to apply metadata");
    } finally {
      setApplyingIndex(null);
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
      setEditOpen(false);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Unable to save metadata");
    } finally {
      setEditSaving(false);
    }
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

      <section className="metadata-lookup-section">
        <button
          className="book-files-toggle"
          onClick={() => setEditOpen((open) => !open)}
          aria-expanded={editOpen}
        >
          <span>Edit metadata</span>
          <Pencil size={18} />
          {editOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
        </button>

        {editOpen && (
          <div className="metadata-lookup-panel">
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
            </div>
          </div>
        )}
      </section>

      <section className="metadata-lookup-section">
        <button
          className="book-files-toggle"
          onClick={() => setLookupOpen((open) => !open)}
          aria-expanded={lookupOpen}
        >
          <span>Metadata lookup</span>
          <Sparkles size={18} />
          {lookupOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
        </button>

        {lookupOpen && (
          <div className="metadata-lookup-panel">
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
                <input
                  type="checkbox"
                  checked={updateDetails}
                  onChange={(event) => setUpdateDetails(event.target.checked)}
                />
                <span>Update details</span>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={updateCover}
                  onChange={(event) => setUpdateCover(event.target.checked)}
                />
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
                    <strong>{candidate.title}</strong>
                    {candidate.subtitle && <span>{candidate.subtitle}</span>}
                    <small>
                      {[candidate.authors.join(", "), candidate.year, candidate.publisher, candidate.source]
                        .filter(Boolean)
                        .join(" · ")}
                    </small>
                    {candidate.description && <p>{candidate.description}</p>}
                  </div>
                  <button
                    className="secondary-button compact-button"
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
          </div>
        )}
      </section>

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
