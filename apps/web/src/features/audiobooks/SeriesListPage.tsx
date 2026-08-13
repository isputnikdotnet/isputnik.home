import { useEffect, useState } from "react";
import { BookOpen, LibraryBig, Plus } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { navigate, queryParam, replaceQuery } from "../../router";
import { AlphabetBar } from "../../shared/AlphabetBar";
import { LibraryMenu } from "../../shared/LibraryMenu";
import { LibraryPageHeader } from "../../shared/LibraryPageHeader";
import { LibraryPageToolbar } from "../../shared/LibraryPageToolbar";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { Button } from "../../shared/Button";
import { SectionNav } from "../../shared/SectionNav";
import { SortMenu } from "../../shared/SortMenu";
import { bookSectionNav, sectionNavProps } from "./sectionNavItems";
import type { AudiobookLibrary, SeriesSummary } from "./types";

export function SeriesListPage({
  user,
  logout,
  kind = "audiobook"
}: {
  user: PublicUser;
  logout: () => Promise<void>;
  kind?: "audiobook" | "ebook";
}) {
  const mediaLabel = kind === "ebook" ? "ebooks" : "audiobooks";
  const base = `/${mediaLabel}`;
  const libPrefix = `/api/library/${kind}-libraries`;
  const [libraries, setLibraries] = useState<AudiobookLibrary[]>([]);
  const [seriesByLibrary, setSeriesByLibrary] = useState<Record<string, SeriesSummary[]>>({});
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [libraryFilter, setLibraryFilter] = useState("all");
  const [sort, setSort] = useState<"name" | "books">("name");
  // Navigation-shaped, like every other A–Z strip: read from the URL, written back
  // with replaceState so Back leaves the page rather than walking letters.
  const [letter, setLetter] = useState<string | null>(() => queryParam("letter"));
  const [modalOpen, setModalOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newLibraryId, setNewLibraryId] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");

  const loadSeries = async (libraryId: string) => {
    const payload = await api<{ series: SeriesSummary[] }>(`${libPrefix}/${libraryId}/series`);
    setSeriesByLibrary((prev) => ({ ...prev, [libraryId]: payload.series }));
  };

  useEffect(() => {
    replaceQuery("letter", letter);
  }, [letter]);

  useEffect(() => {
    api<{ libraries: AudiobookLibrary[] }>(libPrefix)
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
  type SeriesRow = (typeof allSeries)[number];

  const term = search.trim().toLowerCase();
  const matchesSearch = (s: SeriesRow) => !term || s.name.toLowerCase().includes(term);
  const matchesLibrary = (s: SeriesRow) => libraryFilter === "all" || s.libraryId === libraryFilter;

  // Offered from what the other filters allow, so a letter never empties its own strip.
  const availableLetters = [...new Set(allSeries.filter((s) => matchesSearch(s) && matchesLibrary(s)).map((s) => s.alphaKey))];

  const filteredSeries = allSeries
    .filter((s) => matchesSearch(s) && matchesLibrary(s) && (!letter || s.alphaKey === letter))
    .slice()
    // sortKey is the server's folded form (Ё → Е, accents stripped).
    .sort((a, b) => (sort === "books" ? b.bookCount - a.bookCount : a.sortKey.localeCompare(b.sortKey)));

  const libraryOptions = [
    { value: "all", label: "All libraries" },
    ...libraries.map((lib) => ({ value: lib.id, label: lib.name }))
  ];

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
      const payload = await api<{ series: SeriesSummary }>(`${libPrefix}/${newLibraryId}/series`, {
        method: "POST",
        body: JSON.stringify({ name: newName.trim(), description: newDescription.trim() || null })
      });
      setModalOpen(false);
      navigate(`${base}/series/${payload.series.id}`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Unable to create series");
    } finally {
      setCreating(false);
    }
  };

  return (
    <DashboardShell
      active={kind === "ebook" ? "ebooks" : "audiobooks"}
      user={user}
      logout={logout}
      sideNav={<SectionNav {...sectionNavProps(bookSectionNav(kind))} activeKey="series" />}
    >
      <section className="audiobook-main-page">
        <LibraryPageHeader
          title="Series"
          subtitle={`${filteredSeries.length} series`}
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder="Search series..."
          primaryAction={
            <Button variant="primary" onClick={openModal}>
              <Plus size={16} aria-hidden="true" />
              <span>New series</span>
            </Button>
          }
        />

        {error && <MessageBox tone="error" title="Series error">{error}</MessageBox>}

        {allSeries.length > 0 && (
          <LibraryPageToolbar
            scope={libraries.length > 1 && (
              <LibraryMenu
                value={libraryFilter}
                options={libraryOptions}
                icon={<LibraryBig size={19} aria-hidden="true" />}
                label="Library"
                onChange={setLibraryFilter}
              />
            )}
            tools={
              <SortMenu
                presentation="labelled"
                value={sort}
                ariaLabel="Sort series"
                onChange={setSort}
                options={[
                  { value: "name", label: "Name (A–Z)" },
                  { value: "books", label: "Most books" }
                ]}
              />
            }
            strip={
              <AlphabetBar
                available={availableLetters}
                value={letter}
                onChange={setLetter}
                ariaLabel="Filter series by letter"
              />
            }
          />
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
                onClick={() => navigate(`${base}/series/${s.id}`)}
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
        <Modal title="New Series" busy={creating} onClose={() => setModalOpen(false)}>
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
              <Button variant="secondary" onClick={() => setModalOpen(false)}>Cancel</Button>
              <Button
                variant="primary"
                onClick={createSeries}
                disabled={creating || !newName.trim()}
              >
                {creating ? "Creating…" : "Create Series"}
              </Button>
            </div>
        </Modal>
      )}
    </DashboardShell>
  );
}
