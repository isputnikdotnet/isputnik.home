import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Search, UserPlus, UserRound } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { navigate } from "../../router";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import type { AudiobookBook, AudiobookLibrary } from "./types";

// Narrators are an audiobook-only credit, so this list stays per-section (unlike
// Authors, which are unified across types in AuthorListPage). Each narrator
// still opens the cross-type person page at /people/:name.
export function NarratorListPage({
  user,
  logout
}: {
  user: PublicUser;
  logout: () => Promise<void>;
}) {
  const [libraries, setLibraries] = useState<AudiobookLibrary[]>([]);
  const [booksByLibrary, setBooksByLibrary] = useState<Record<string, AudiobookBook[]>>({});
  const [photos, setPhotos] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newLibraryId, setNewLibraryId] = useState("");
  const [newBio, setNewBio] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");

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
    api<{ photos: Record<string, string> }>("/api/library/people/photos")
      .then((payload) => setPhotos(payload.photos))
      .catch(() => {}); // avatars are decoration — the list works without them
  }, [loadBooks]);

  const allBooks = libraries.flatMap((lib) => booksByLibrary[lib.id] ?? []);
  const persons = [...new Set(allBooks.flatMap((book) => book.narrators))]
    .map((name) => ({ name, bookCount: allBooks.filter((b) => b.narrators.includes(name)).length }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const term = search.trim().toLowerCase();
  const filtered = term ? persons.filter((person) => person.name.toLowerCase().includes(term)) : persons;

  // Everyone lands on the canonical, cross-type person page; `from` lets its
  // Back button return to this list.
  const personHref = (name: string) =>
    `/people/${encodeURIComponent(name)}?from=${encodeURIComponent(window.location.pathname)}`;
  const writableLibraries = libraries.filter((lib) => lib.canWrite);
  const canCreate = writableLibraries.length > 0;

  const openCreate = () => {
    setNewName("");
    setNewBio("");
    setNewLibraryId(writableLibraries.length === 1 ? writableLibraries[0].id : "");
    setCreateError("");
    setCreateOpen(true);
  };

  const createNarrator = async () => {
    const name = newName.trim();
    if (!name || !newLibraryId) return;
    setCreating(true);
    setCreateError("");
    try {
      await api("/api/library/people", {
        method: "POST",
        body: JSON.stringify({ name, libraryId: newLibraryId, bio: newBio.trim() || null })
      });
      navigate(`/people/${encodeURIComponent(name)}`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Unable to create narrator");
      setCreating(false);
    }
  };

  return (
    <DashboardShell active="audiobooks" user={user} logout={logout}>
      <section className="audiobook-main-page">
        <button className="audiobook-back-button" type="button" onClick={() => navigate("/audiobooks")}>
          <ArrowLeft size={18} aria-hidden="true" />
          <span>Back to audiobooks</span>
        </button>

        <div className="audiobook-page-title">
          <h1>Narrators</h1>
          <p>{filtered.length} {filtered.length === 1 ? "narrator" : "narrators"}</p>
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
                placeholder="Search narrators"
                aria-label="Search narrators"
              />
            </label>
            {canCreate && (
              <Button variant="primary" onClick={openCreate}>
                <UserPlus size={16} />
                <span>New narrator</span>
              </Button>
            )}
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
            <h2>No narrators match</h2>
          </div>
        ) : (
          <div className="person-grid">
            {filtered.map((person) => (
              <button
                key={person.name}
                className="person-card"
                onClick={() => navigate(personHref(person.name))}
              >
                <div className="person-avatar" aria-hidden="true">
                  {photos[person.name] ? (
                    <img src={photos[person.name]} alt="" />
                  ) : (
                    <UserRound size={26} />
                  )}
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

      {createOpen && (
        <Modal title="New narrator" busy={creating} onClose={() => setCreateOpen(false)}>
          <p className="muted">
            Create a narrator ahead of time. They become available when editing a book and appear on this page once a book credits them.
          </p>
          {createError && <MessageBox tone="error" title="Unable to create narrator">{createError}</MessageBox>}
          <label className="field">
            <span>Name</span>
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Full name" autoFocus />
          </label>
          {writableLibraries.length > 1 && (
            <label className="field">
              <span>Library</span>
              <select value={newLibraryId} onChange={(e) => setNewLibraryId(e.target.value)}>
                <option value="">Choose a library…</option>
                {writableLibraries.map((lib) => (
                  <option key={lib.id} value={lib.id}>{lib.name}</option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            <span>Biography <span className="muted">(optional)</span></span>
            <textarea
              rows={5}
              value={newBio}
              onChange={(e) => setNewBio(e.target.value)}
              placeholder="Write a short biography…"
              maxLength={10000}
            />
          </label>
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setCreateOpen(false)} disabled={creating}>Cancel</Button>
            <Button variant="primary" onClick={createNarrator} disabled={creating || !newName.trim() || !newLibraryId}>
              <UserPlus size={15} />
              <span>{creating ? "Creating…" : "Create narrator"}</span>
            </Button>
          </div>
        </Modal>
      )}
    </DashboardShell>
  );
}
