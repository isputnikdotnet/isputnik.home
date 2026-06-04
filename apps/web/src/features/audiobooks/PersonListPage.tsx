import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Search, UserRound } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { navigate } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import type { AudiobookBook, AudiobookLibrary } from "./types";

export function PersonListPage({
  role,
  user,
  logout
}: {
  role: "author" | "narrator";
  user: PublicUser;
  logout: () => Promise<void>;
}) {
  const [libraries, setLibraries] = useState<AudiobookLibrary[]>([]);
  const [booksByLibrary, setBooksByLibrary] = useState<Record<string, AudiobookBook[]>>({});
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");

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
  }, [loadBooks]);

  const allBooks = libraries.flatMap((lib) => booksByLibrary[lib.id] ?? []);
  const getNames = (book: AudiobookBook) => (role === "author" ? book.authors : book.narrators);

  const persons = [...new Set(allBooks.flatMap(getNames))]
    .map((name) => ({ name, bookCount: allBooks.filter((b) => getNames(b).includes(name)).length }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const term = search.trim().toLowerCase();
  const filtered = term ? persons.filter((person) => person.name.toLowerCase().includes(term)) : persons;

  const title = role === "author" ? "Authors" : "Narrators";
  const detailBase = role === "author" ? "/audiobooks/authors" : "/audiobooks/narrators";

  return (
    <DashboardShell active="audiobooks" user={user} logout={logout}>
      <section className="audiobook-main-page">
        <button className="audiobook-back-button" type="button" onClick={() => navigate("/audiobooks")}>
          <ArrowLeft size={18} aria-hidden="true" />
          <span>Back to audiobooks</span>
        </button>

        <div className="audiobook-page-title">
          <h1>{title}</h1>
          <p>{filtered.length} {filtered.length === 1 ? title.slice(0, -1).toLowerCase() : title.toLowerCase()}</p>
        </div>

        {error && <MessageBox tone="error" title="Error">{error}</MessageBox>}

        {libraries.length > 0 && (
          <div className="audiobook-toolbar">
            <label className="search-field">
              <Search size={17} aria-hidden="true" />
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={`Search ${title.toLowerCase()}`}
                aria-label={`Search ${title.toLowerCase()}`}
              />
            </label>
          </div>
        )}

        {libraries.length === 0 ? (
          <div className="empty-state library-empty">
            <UserRound size={58} aria-hidden="true" />
            <h2>No audiobook libraries yet</h2>
            <p className="muted">An administrator can add libraries from the control panel.</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="empty-state library-empty">
            <UserRound size={48} aria-hidden="true" />
            <h2>No {title.toLowerCase()} match</h2>
          </div>
        ) : (
          <div className="person-grid">
            {filtered.map((person) => (
              <button
                key={person.name}
                className="person-card"
                onClick={() => navigate(`${detailBase}/${encodeURIComponent(person.name)}`)}
              >
                <div className="person-avatar" aria-hidden="true">
                  <UserRound size={26} />
                </div>
                <div className="person-card-body">
                  <strong>{person.name}</strong>
                  <span>{person.bookCount} {person.bookCount === 1 ? "book" : "books"}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </section>
    </DashboardShell>
  );
}
