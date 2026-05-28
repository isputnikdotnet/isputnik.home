import React, { useCallback, useEffect, useState } from "react";
import { BookOpen, Search } from "lucide-react";
import { api, type PublicUser } from "../../api";
import type { AudiobookBook, AudiobookBookDetail, AudiobookLibrary } from "./types";

type DashboardShellComponent = React.ComponentType<{
  active: "audiobooks";
  user: PublicUser;
  logout: () => Promise<void>;
  children: React.ReactNode;
}>;

type MessageBoxComponent = React.ComponentType<{
  tone: "info" | "warning" | "error" | "success";
  title: string;
  children: React.ReactNode;
}>;

export function AudiobooksPage({
  user,
  logout,
  DashboardShell,
  MessageBox
}: {
  user: PublicUser;
  logout: () => Promise<void>;
  DashboardShell: DashboardShellComponent;
  MessageBox: MessageBoxComponent;
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
                    <small>{book.fileCount} {book.fileCount === 1 ? "file" : "files"}</small>
                  </div>
                </button>
              ))}
              {visibleBooks.length === 0 && <p className="management-empty">No audiobooks match this filter.</p>}
            </div>
          </>
        )}
        {selectedBookDetail && (
          <div className="modal-backdrop" onMouseDown={() => setSelectedBookDetail(null)}>
            <section
              className="book-detail-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="book-detail-title"
              onMouseDown={(event) => event.stopPropagation()}
            >
              <div className="book-detail-head">
                <div className="book-detail-cover" aria-hidden="true">
                  {selectedBookDetail.coverUrl ? (
                    <img src={selectedBookDetail.coverUrl} alt="" />
                  ) : (
                    <>
                      <BookOpen size={18} />
                      <strong>{selectedBookDetail.title.slice(0, 2).toUpperCase()}</strong>
                    </>
                  )}
                </div>
                <div>
                  <p className="eyebrow">{selectedBookDetail.libraryName}</p>
                  <h2 id="book-detail-title">{selectedBookDetail.title}</h2>
                  <p>{selectedBookDetail.authors.length > 0 ? selectedBookDetail.authors.join(", ") : "Unknown author"}</p>
                  <dl className="book-detail-meta">
                    <div><dt>Files</dt><dd>{selectedBookDetail.files.length}</dd></div>
                    {selectedBookDetail.yearPublished && <div><dt>Year</dt><dd>{selectedBookDetail.yearPublished}</dd></div>}
                    {selectedBookDetail.language && <div><dt>Language</dt><dd>{selectedBookDetail.language}</dd></div>}
                    {selectedBookDetail.isbn && <div><dt>ISBN</dt><dd>{selectedBookDetail.isbn}</dd></div>}
                  </dl>
                </div>
              </div>

              {selectedBookDetail.description && <p className="book-description">{selectedBookDetail.description}</p>}

              <section className="book-files-section">
                <h3>Files</h3>
                <div className="book-file-list">
                  {selectedBookDetail.files.map((file) => (
                    <article className="book-file-row" key={file.id}>
                      <span>{file.trackNumber ?? "-"}</span>
                      <div>
                        <strong>{file.chapterTitle || file.relativePath.split("/").at(-1) || file.relativePath}</strong>
                        <small>{file.relativePath}</small>
                      </div>
                      <small>{formatBytes(file.size)}</small>
                    </article>
                  ))}
                </div>
              </section>

              <div className="modal-actions">
                <button className="primary-button" onClick={() => setSelectedBookDetail(null)} autoFocus>
                  Close
                </button>
              </div>
            </section>
          </div>
        )}
      </section>
    </DashboardShell>
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}
