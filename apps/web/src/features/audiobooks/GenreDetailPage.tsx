import { useEffect, useState } from "react";
import { BookOpen, Pencil, Plus, Save, Trash2, X } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { navigate } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import { AudiobookNav } from "./AudiobookNav";
import type { AudiobookBook, GenreDetail } from "./types";

interface EditableBook {
  id: string;
  title: string;
  authors: string[];
  coverUrl: string | null;
}

export function GenreDetailPage({
  genreId,
  user,
  logout
}: {
  genreId: string;
  user: PublicUser;
  logout: () => Promise<void>;
}) {
  const [genre, setGenre] = useState<GenreDetail | null>(null);
  const [books, setBooks] = useState<EditableBook[]>([]);
  const [libraryBooks, setLibraryBooks] = useState<AudiobookBook[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editName, setEditName] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState("");

  useEffect(() => {
    setError("");
    setGenre(null);
    api<{ genre: GenreDetail }>(`/api/library/genres/${genreId}`)
      .then((payload) => {
        setGenre(payload.genre);
        setBooks(payload.genre.books.map((b) => ({
          id: b.id,
          title: b.title,
          authors: b.authors,
          coverUrl: b.coverUrl
        })));
        return api<{ books: AudiobookBook[] }>(`/api/library/audiobook-libraries/${payload.genre.libraryId}/books`);
      })
      .then((payload) => setLibraryBooks(payload.books))
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load genre"));
  }, [genreId]);

  const currentIds = new Set(books.map((b) => b.id));
  const availableBooks = libraryBooks.filter((b) => !currentIds.has(b.id));

  const removeBook = (id: string) => setBooks((prev) => prev.filter((b) => b.id !== id));

  const openAddModal = () => {
    setSelectedIds(new Set());
    setAddModalOpen(true);
  };

  const confirmAddBooks = () => {
    const toAdd = availableBooks
      .filter((b) => selectedIds.has(b.id))
      .map((b) => ({ id: b.id, title: b.title, authors: b.authors, coverUrl: b.coverUrl }));
    setBooks((prev) => [...prev, ...toAdd]);
    setAddModalOpen(false);
  };

  const saveBooks = async () => {
    setSaving(true);
    setSaveError("");
    try {
      await api(`/api/library/genres/${genreId}/books`, {
        method: "PUT",
        body: JSON.stringify({ bookIds: books.map((b) => b.id) })
      });
      setGenre((prev) => prev ? { ...prev, books } : prev);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Unable to save");
    } finally {
      setSaving(false);
    }
  };

  const openEditModal = () => {
    setEditName(genre?.name ?? "");
    setEditError("");
    setEditModalOpen(true);
  };

  const saveEdit = async () => {
    if (!editName.trim()) return;
    setEditSaving(true);
    setEditError("");
    try {
      await api(`/api/library/genres/${genreId}`, {
        method: "PATCH",
        body: JSON.stringify({ name: editName.trim() })
      });
      setGenre((prev) => prev ? { ...prev, name: editName.trim() } : prev);
      setEditModalOpen(false);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Unable to save changes");
    } finally {
      setEditSaving(false);
    }
  };

  const deleteGenre = async () => {
    setDeleting(true);
    try {
      await api(`/api/library/genres/${genreId}`, { method: "DELETE" });
      navigate("/audiobooks/genres");
    } catch {
      setDeleting(false);
      setDeleteConfirm(false);
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  if (error) {
    return (
      <DashboardShell active="audiobooks" user={user} logout={logout} sideNav={<AudiobookNav active="genres" />}>
        <section className="work-area scene-page audiobook-scene">
          <button className="back-link" onClick={() => navigate("/audiobooks/genres")}>← Genres</button>
          <MessageBox tone="error" title="Error">{error}</MessageBox>
        </section>
      </DashboardShell>
    );
  }

  if (!genre) {
    return (
      <DashboardShell active="audiobooks" user={user} logout={logout} sideNav={<AudiobookNav active="genres" />}>
        <section className="work-area scene-page audiobook-scene">
          <p className="management-empty">Loading genre…</p>
        </section>
      </DashboardShell>
    );
  }

  return (
    <DashboardShell active="audiobooks" user={user} logout={logout} sideNav={<AudiobookNav active="genres" />}>
      <section className="work-area scene-page audiobook-scene">
        <button className="back-link" onClick={() => navigate("/audiobooks/genres")}>← Genres</button>

        <div className="series-detail-head">
          <div className="series-name-edit">
            <h1>{genre.name}</h1>
            <button className="icon-button" onClick={openEditModal} aria-label="Edit genre">
              <Pencil size={16} />
            </button>
          </div>
          <p className="muted series-library-label">{genre.libraryName}</p>
        </div>

        <div className="series-detail-actions">
          <button className="secondary-button" onClick={openAddModal}>
            <Plus size={16} /> Add books
          </button>
          <button className="primary-button" onClick={saveBooks} disabled={saving}>
            <Save size={16} /> {saving ? "Saving…" : "Save"}
          </button>
          <button className="secondary-button" onClick={() => setDeleteConfirm(true)} style={{ marginLeft: "auto" }}>
            <Trash2 size={16} /> Delete genre
          </button>
        </div>

        {saveError && <MessageBox tone="error" title="Save error">{saveError}</MessageBox>}

        {books.length === 0 ? (
          <div className="empty-state">
            <BookOpen size={40} aria-hidden="true" />
            <h2>No books yet</h2>
            <p className="muted">Click "Add books" to assign books to this genre.</p>
          </div>
        ) : (
          <div className="series-book-list">
            {books.map((book) => (
              <div key={book.id} className="genre-book-row">
                <div className="series-book-cover" aria-hidden="true">
                  {book.coverUrl ? <img src={book.coverUrl} alt="" /> : <BookOpen size={14} />}
                </div>
                <div className="series-book-info">
                  <button className="series-book-title-link" onClick={() => navigate(`/audiobooks/books/${book.id}`)}>
                    {book.title}
                  </button>
                  {book.authors.length > 0 && <span>{book.authors.join(", ")}</span>}
                </div>
                <button className="icon-button danger" onClick={() => removeBook(book.id)} aria-label="Remove from genre">
                  <X size={16} />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {editModalOpen && (
        <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) setEditModalOpen(false); }}>
          <div className="confirm-modal" role="dialog" aria-modal="true" aria-label="Edit genre" style={{ width: "min(100%, 520px)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
              <h2 style={{ margin: 0 }}>Edit genre</h2>
              <button className="modal-close" onClick={() => setEditModalOpen(false)} aria-label="Close"><X size={18} /></button>
            </div>

            <div className="field" style={{ marginBottom: 12 }}>
              <span>Name</span>
              <input
                autoFocus
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) saveEdit(); }}
              />
            </div>

            {editError && <MessageBox tone="error" title="Error">{editError}</MessageBox>}

            <div className="modal-actions" style={{ marginTop: 16 }}>
              <button className="secondary-button" onClick={() => setEditModalOpen(false)} disabled={editSaving}>Cancel</button>
              <button className="primary-button" onClick={saveEdit} disabled={editSaving || !editName.trim()}>
                {editSaving ? "Saving…" : "Save changes"}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteConfirm && (
        <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) setDeleteConfirm(false); }}>
          <div className="confirm-modal" role="dialog" aria-modal="true" aria-label="Delete genre">
            <h2>Delete "{genre.name}"?</h2>
            <p>This will remove the genre tag from all books. The books themselves will not be deleted.</p>
            <div className="modal-actions">
              <button className="secondary-button" onClick={() => setDeleteConfirm(false)} disabled={deleting}>Cancel</button>
              <button className="danger-button" onClick={deleteGenre} disabled={deleting}>
                <Trash2 size={16} /> {deleting ? "Deleting…" : "Yes, delete genre"}
              </button>
            </div>
          </div>
        </div>
      )}

      {addModalOpen && (
        <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) setAddModalOpen(false); }}>
          <div className="series-add-modal" role="dialog" aria-modal="true" aria-label="Add books">
            <div className="modal-header">
              <h2>Add books to genre</h2>
              <button className="modal-close" onClick={() => setAddModalOpen(false)} aria-label="Close"><X size={18} /></button>
            </div>

            <div className="series-add-list">
              {availableBooks.length === 0 ? (
                <p className="management-empty">All books in this library are already in this genre.</p>
              ) : (
                availableBooks.map((book) => (
                  <label key={book.id} className="series-add-row">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(book.id)}
                      onChange={() => toggleSelect(book.id)}
                    />
                    <div className="series-book-cover" aria-hidden="true">
                      {book.coverUrl ? <img src={book.coverUrl} alt="" /> : <BookOpen size={14} />}
                    </div>
                    <div className="series-book-info">
                      <strong>{book.title}</strong>
                      {book.authors.length > 0 && <span>{book.authors.join(", ")}</span>}
                    </div>
                  </label>
                ))
              )}
            </div>

            <div className="modal-actions" style={{ padding: "12px 16px 16px" }}>
              <button className="secondary-button" onClick={() => setAddModalOpen(false)}>Cancel</button>
              <button
                className="primary-button"
                onClick={confirmAddBooks}
                disabled={selectedIds.size === 0}
              >
                Add {selectedIds.size > 0 ? `${selectedIds.size} ` : ""}selected
              </button>
            </div>
          </div>
        </div>
      )}
    </DashboardShell>
  );
}
