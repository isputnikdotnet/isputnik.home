import { useCallback, useEffect, useState } from "react";
import { BookOpen, Pencil } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { navigate } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import { formatDuration } from "../../shared/utils";
import { AudiobookNav } from "./AudiobookNav";
import { PersonProfileModal } from "./PersonProfileModal";
import type { AudiobookBook, AudiobookLibrary } from "./types";

export function PersonDetailPage({
  personName,
  role,
  user,
  logout
}: {
  personName: string;
  role: "author" | "narrator";
  user: PublicUser;
  logout: () => Promise<void>;
}) {
  const [libraries, setLibraries] = useState<AudiobookLibrary[]>([]);
  const [booksByLibrary, setBooksByLibrary] = useState<Record<string, AudiobookBook[]>>({});
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [error, setError] = useState("");

  const loadBooks = useCallback(async (libraryId: string) => {
    const payload = await api<{ books: AudiobookBook[] }>(`/api/library/audiobook-libraries/${libraryId}/books`);
    setBooksByLibrary((current) => ({ ...current, [libraryId]: payload.books }));
  }, []);

  useEffect(() => {
    api<{ libraries: AudiobookLibrary[] }>("/api/library/audiobook-libraries")
      .then(async (payload) => {
        setLibraries(payload.libraries);
        await Promise.all(payload.libraries.map((lib) => loadBooks(lib.id)));
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load data"));
  }, [personName, loadBooks]);

  const allBooks = libraries.flatMap((lib) =>
    (booksByLibrary[lib.id] ?? []).map((book) => ({ ...book, libraryName: lib.name }))
  );
  const personBooks = allBooks.filter((book) =>
    (role === "author" ? book.authors : book.narrators).includes(personName)
  );

  const roleLabel = role === "author" ? "Author" : "Narrator";
  const navActive = role === "author" ? "authors" : "narrators";

  return (
    <DashboardShell
      active="audiobooks"
      user={user}
      logout={logout}
      sideNav={<AudiobookNav active={navActive} />}
    >
      <section className="work-area scene-page audiobook-scene">
        <div className="section-head">
          <div>
            <p className="eyebrow">{roleLabel}</p>
            <div className="person-detail-head">
              <h1>{personName}</h1>
              <button
                className="icon-button"
                onClick={() => setProfileModalOpen(true)}
                title={`Edit ${roleLabel.toLowerCase()} profile`}
              >
                <Pencil size={17} />
              </button>
            </div>
          </div>
        </div>

        {error && <MessageBox tone="error" title="Error">{error}</MessageBox>}

        <p className="person-book-count muted">
          {personBooks.length} {personBooks.length === 1 ? "book" : "books"}
        </p>

        {personBooks.length > 0 && (
          <div className="audiobook-grid">
            {personBooks.map((book) => (
              <button
                className="audiobook-card"
                key={book.id}
                onClick={() => navigate(`/audiobooks/books/${book.id}`)}
              >
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
          </div>
        )}
      </section>

      {profileModalOpen && (
        <PersonProfileModal
          personName={personName}
          role={role}
          onClose={() => setProfileModalOpen(false)}
        />
      )}
    </DashboardShell>
  );
}
