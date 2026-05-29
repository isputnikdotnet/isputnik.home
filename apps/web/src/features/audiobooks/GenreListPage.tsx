import { useEffect, useState } from "react";
import { Plus, Tag, X } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { navigate } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import { AudiobookNav } from "./AudiobookNav";
import type { AudiobookLibrary, GenreSummary } from "./types";

export function GenreListPage({
  user,
  logout
}: {
  user: PublicUser;
  logout: () => Promise<void>;
}) {
  const [libraries, setLibraries] = useState<AudiobookLibrary[]>([]);
  const [genresByLibrary, setGenresByLibrary] = useState<Record<string, GenreSummary[]>>({});
  const [error, setError] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newLibraryId, setNewLibraryId] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");

  const loadGenres = async (libraryId: string) => {
    const payload = await api<{ genres: GenreSummary[] }>(`/api/library/audiobook-libraries/${libraryId}/genres`);
    setGenresByLibrary((prev) => ({ ...prev, [libraryId]: payload.genres }));
  };

  useEffect(() => {
    api<{ libraries: AudiobookLibrary[] }>("/api/library/audiobook-libraries")
      .then(async (payload) => {
        setLibraries(payload.libraries);
        setNewLibraryId(payload.libraries[0]?.id ?? "");
        await Promise.all(payload.libraries.map((lib) => loadGenres(lib.id)));
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load genres"));
  }, []);

  const allGenres = libraries.flatMap((lib) =>
    (genresByLibrary[lib.id] ?? []).map((g) => ({ ...g, libraryName: lib.name, libraryId: lib.id }))
  );

  const openModal = () => {
    setNewName("");
    setCreateError("");
    setModalOpen(true);
  };

  const createGenre = async () => {
    if (!newName.trim() || !newLibraryId) return;
    setCreating(true);
    setCreateError("");
    try {
      const payload = await api<{ genre: GenreSummary }>(`/api/library/audiobook-libraries/${newLibraryId}/genres`, {
        method: "POST",
        body: JSON.stringify({ name: newName.trim() })
      });
      setModalOpen(false);
      navigate(`/audiobooks/genres/${payload.genre.id}`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Unable to create genre");
    } finally {
      setCreating(false);
    }
  };

  return (
    <DashboardShell active="audiobooks" user={user} logout={logout} sideNav={<AudiobookNav active="genres" />}>
      <section className="work-area scene-page audiobook-scene">
        <div className="section-head">
          <div>
            <p className="eyebrow">Digital Library</p>
            <h1>Genres</h1>
          </div>
          <button className="primary-button" onClick={openModal}>
            <Plus size={16} />
            <span>New Genre</span>
          </button>
        </div>

        {error && <MessageBox tone="error" title="Genres error">{error}</MessageBox>}

        {allGenres.length === 0 && !error ? (
          <div className="empty-state">
            <Tag size={48} aria-hidden="true" />
            <h2>No genres yet</h2>
            <p className="muted">Create a genre or scan books that include genre tags.</p>
          </div>
        ) : (
          <div className="series-grid">
            {allGenres.map((g) => (
              <button
                key={g.id}
                className="series-card"
                onClick={() => navigate(`/audiobooks/genres/${g.id}`)}
              >
                <div className="series-card-cover" aria-hidden="true">
                  <Tag size={18} />
                  <strong>{g.name.slice(0, 2).toUpperCase()}</strong>
                </div>
                <div className="series-card-body">
                  <strong>{g.name}</strong>
                  <span>{g.bookCount} {g.bookCount === 1 ? "book" : "books"}</span>
                  {libraries.length > 1 && <small>{g.libraryName}</small>}
                </div>
              </button>
            ))}
          </div>
        )}
      </section>

      {modalOpen && (
        <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) setModalOpen(false); }}>
          <div className="confirm-modal" role="dialog" aria-modal="true" aria-label="New Genre">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
              <h2 style={{ margin: 0 }}>New Genre</h2>
              <button className="modal-close" onClick={() => setModalOpen(false)} aria-label="Close"><X size={18} /></button>
            </div>

            <div className="field" style={{ marginBottom: 12 }}>
              <span>Genre name</span>
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) createGenre(); }}
                placeholder="e.g. Science Fiction"
              />
            </div>

            {libraries.length > 1 && (
              <div className="field" style={{ marginBottom: 12 }}>
                <span>Library</span>
                <select value={newLibraryId} onChange={(e) => setNewLibraryId(e.target.value)}>
                  {libraries.map((lib) => (
                    <option key={lib.id} value={lib.id}>{lib.name}</option>
                  ))}
                </select>
              </div>
            )}

            {createError && <MessageBox tone="error" title="Error">{createError}</MessageBox>}

            <div className="modal-actions" style={{ marginTop: 16 }}>
              <button className="secondary-button" onClick={() => setModalOpen(false)}>Cancel</button>
              <button
                className="primary-button"
                onClick={createGenre}
                disabled={creating || !newName.trim()}
              >
                {creating ? "Creating…" : "Create Genre"}
              </button>
            </div>
          </div>
        </div>
      )}
    </DashboardShell>
  );
}
