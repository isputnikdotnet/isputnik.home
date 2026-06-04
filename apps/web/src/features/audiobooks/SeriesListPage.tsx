import { useEffect, useState } from "react";
import { ArrowLeft, BookOpen, Plus, Search, X } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { navigate } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import type { AudiobookLibrary, SeriesSummary } from "./types";

export function SeriesListPage({
  user,
  logout
}: {
  user: PublicUser;
  logout: () => Promise<void>;
}) {
  const [libraries, setLibraries] = useState<AudiobookLibrary[]>([]);
  const [seriesByLibrary, setSeriesByLibrary] = useState<Record<string, SeriesSummary[]>>({});
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newLibraryId, setNewLibraryId] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");

  const loadSeries = async (libraryId: string) => {
    const payload = await api<{ series: SeriesSummary[] }>(`/api/library/audiobook-libraries/${libraryId}/series`);
    setSeriesByLibrary((prev) => ({ ...prev, [libraryId]: payload.series }));
  };

  useEffect(() => {
    api<{ libraries: AudiobookLibrary[] }>("/api/library/audiobook-libraries")
      .then(async (payload) => {
        setLibraries(payload.libraries);
        setNewLibraryId(payload.libraries[0]?.id ?? "");
        await Promise.all(payload.libraries.map((lib) => loadSeries(lib.id)));
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load series"));
  }, []);

  const allSeries = libraries.flatMap((lib) =>
    (seriesByLibrary[lib.id] ?? []).map((s) => ({ ...s, libraryName: lib.name, libraryId: lib.id }))
  );
  const term = search.trim().toLowerCase();
  const filteredSeries = term ? allSeries.filter((s) => s.name.toLowerCase().includes(term)) : allSeries;

  const openModal = () => {
    setNewName("");
    setNewDescription("");
    setCreateError("");
    setModalOpen(true);
  };

  const createSeries = async () => {
    if (!newName.trim() || !newLibraryId) return;
    setCreating(true);
    setCreateError("");
    try {
      const payload = await api<{ series: SeriesSummary }>(`/api/library/audiobook-libraries/${newLibraryId}/series`, {
        method: "POST",
        body: JSON.stringify({ name: newName.trim(), description: newDescription.trim() || null })
      });
      setModalOpen(false);
      navigate(`/audiobooks/series/${payload.series.id}`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Unable to create series");
    } finally {
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

        <div className="section-head">
          <div className="audiobook-page-title">
            <h1>Series</h1>
            <p>{filteredSeries.length} series</p>
          </div>
          <button className="primary-button" onClick={openModal}>
            <Plus size={16} />
            <span>New Series</span>
          </button>
        </div>

        {error && <MessageBox tone="error" title="Series error">{error}</MessageBox>}

        {allSeries.length > 0 && (
          <div className="audiobook-toolbar">
            <label className="search-field">
              <Search size={17} aria-hidden="true" />
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search series"
                aria-label="Search series"
              />
            </label>
          </div>
        )}

        {allSeries.length === 0 && !error ? (
          <div className="empty-state library-empty">
            <BookOpen size={48} aria-hidden="true" />
            <h2>No series yet</h2>
            <p className="muted">Create a series and add books to it.</p>
          </div>
        ) : filteredSeries.length === 0 ? (
          <div className="empty-state library-empty">
            <BookOpen size={48} aria-hidden="true" />
            <h2>No series match</h2>
          </div>
        ) : (
          <div className="series-grid">
            {filteredSeries.map((s) => (
              <button
                key={s.id}
                className="series-card"
                onClick={() => navigate(`/audiobooks/series/${s.id}`)}
              >
                <div className="series-card-cover" aria-hidden="true">
                  {s.coverUrl ? (
                    <img src={s.coverUrl} alt="" />
                  ) : (
                    <>
                      <BookOpen size={18} />
                      <strong>{s.name.slice(0, 2).toUpperCase()}</strong>
                    </>
                  )}
                </div>
                <div className="series-card-body">
                  <strong>{s.name}</strong>
                  <span>{s.bookCount} {s.bookCount === 1 ? "book" : "books"}</span>
                  {libraries.length > 1 && <small>{s.libraryName}</small>}
                </div>
              </button>
            ))}
          </div>
        )}
      </section>

      {modalOpen && (
        <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) setModalOpen(false); }}>
          <div className="confirm-modal" role="dialog" aria-modal="true" aria-label="New Series">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
              <h2 style={{ margin: 0 }}>New Series</h2>
              <button className="modal-close" onClick={() => setModalOpen(false)} aria-label="Close"><X size={18} /></button>
            </div>

            <div className="field" style={{ marginBottom: 12 }}>
              <span>Series name</span>
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. The Stormlight Archive"
              />
            </div>

            <div className="field" style={{ marginBottom: 12 }}>
              <span>Description</span>
              <textarea
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                rows={3}
                placeholder="Optional description…"
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
                onClick={createSeries}
                disabled={creating || !newName.trim()}
              >
                {creating ? "Creating…" : "Create Series"}
              </button>
            </div>
          </div>
        </div>
      )}
    </DashboardShell>
  );
}
