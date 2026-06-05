import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, BookOpen, Merge, Pencil, Search, X } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { getReferrer, navigate } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import { formatDuration } from "../../shared/utils";
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
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeTarget, setMergeTarget] = useState("");
  const [mergeQuery, setMergeQuery] = useState("");
  const [merging, setMerging] = useState(false);
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
  const backTo = getReferrer();

  // Other people of the same role to merge this one into.
  const mergeCandidates = [...new Set(
    allBooks.flatMap((book) => (role === "author" ? book.authors : book.narrators))
  )].filter((name) => name !== personName).sort((a, b) => a.localeCompare(b));
  const filteredCandidates = mergeQuery.trim()
    ? mergeCandidates.filter((name) => name.toLowerCase().includes(mergeQuery.trim().toLowerCase()))
    : mergeCandidates;

  const runMerge = async () => {
    if (!mergeTarget) return;
    setMerging(true);
    setError("");
    try {
      await api("/api/library/people/merge", {
        method: "POST",
        body: JSON.stringify({ from: personName, into: mergeTarget })
      });
      navigate(`/audiobooks/${navActive}/${encodeURIComponent(mergeTarget)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Merge failed");
      setMerging(false);
    }
  };

  return (
    <DashboardShell active="audiobooks" user={user} logout={logout}>
      <section className="audiobook-main-page">
        <button className="audiobook-back-button" type="button" onClick={() => navigate(backTo ?? `/audiobooks/${navActive}`)}>
          <ArrowLeft size={17} aria-hidden="true" />
          <span>{backTo ? "Back" : `Back to ${navActive}`}</span>
        </button>
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
              {user.role === "admin" && mergeCandidates.length > 0 && (
                <button
                  className="icon-button"
                  onClick={() => { setMergeTarget(""); setMergeQuery(""); setMergeOpen(true); }}
                  title={`Merge this ${roleLabel.toLowerCase()} into another`}
                >
                  <Merge size={17} />
                </button>
              )}
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

      {mergeOpen && (
        <div className="modal-backdrop" onMouseDown={() => !merging && setMergeOpen(false)}>
          <div className="confirm-modal merge-modal" role="dialog" aria-modal="true" aria-label="Merge person" onMouseDown={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Merge “{personName}”</h2>
              <button className="modal-close" onClick={() => setMergeOpen(false)} aria-label="Close"><X size={18} /></button>
            </div>
            <p>
              Pick the {roleLabel.toLowerCase()} to merge <strong>{personName}</strong> into. Their {personBooks.length} {personBooks.length === 1 ? "book moves" : "books move"} to
              the chosen name, and future scans will map “{personName}” there automatically.
            </p>
            <label className="facet-search merge-search">
              <Search size={14} aria-hidden="true" />
              <input
                value={mergeQuery}
                onChange={(e) => setMergeQuery(e.target.value)}
                placeholder={`Search ${navActive}`}
                aria-label="Search people"
                autoFocus
              />
            </label>
            <div className="merge-candidate-list">
              {filteredCandidates.map((name) => (
                <button
                  key={name}
                  className={`merge-candidate${mergeTarget === name ? " selected" : ""}`}
                  onClick={() => setMergeTarget(name)}
                >
                  {name}
                </button>
              ))}
              {filteredCandidates.length === 0 && <p className="facet-empty">No matches</p>}
            </div>
            <div className="modal-actions">
              <button className="secondary-button" onClick={() => setMergeOpen(false)} disabled={merging}>Cancel</button>
              <button className="primary-button" onClick={runMerge} disabled={merging || !mergeTarget}>
                <Merge size={15} /> {merging ? "Merging…" : "Merge"}
              </button>
            </div>
          </div>
        </div>
      )}
    </DashboardShell>
  );
}
