import { useEffect, useState } from "react";
import { ArrowLeft, BookOpen, Pencil, Plus, Save, Trash2, Upload, X } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { getReferrer, navigate } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import type { AudiobookBook, SeriesDetail } from "./types";

interface EditableBook {
  id: string;
  title: string;
  authors: string[];
  coverUrl: string | null;
  position: string;
}

export function SeriesDetailPage({
  seriesId,
  user,
  logout
}: {
  seriesId: string;
  user: PublicUser;
  logout: () => Promise<void>;
}) {
  const [series, setSeries] = useState<SeriesDetail | null>(null);
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
  const [editDescription, setEditDescription] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState("");
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [coverPreview, setCoverPreview] = useState<string | null>(null);
  const [removeCover, setRemoveCover] = useState(false);

  useEffect(() => () => {
    if (coverPreview) URL.revokeObjectURL(coverPreview);
  }, [coverPreview]);

  useEffect(() => {
    setError("");
    setSeries(null);
    api<{ series: SeriesDetail }>(`/api/library/series/${seriesId}`)
      .then((payload) => {
        setSeries(payload.series);
        setBooks(
          payload.series.books.map((b) => ({
            id: b.id,
            title: b.title,
            authors: b.authors,
            coverUrl: b.coverUrl,
            position: b.seriesPosition?.toString() ?? ""
          }))
        );
        return api<{ books: AudiobookBook[] }>(`/api/library/audiobook-libraries/${payload.series.libraryId}/books`);
      })
      .then((payload) => setLibraryBooks(payload.books))
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load series"));
  }, [seriesId]);

  const backTo = getReferrer();
  const currentIds = new Set(books.map((b) => b.id));
  const availableBooks = libraryBooks.filter((b) => !currentIds.has(b.id));

  const removeBook = (id: string) => {
    setBooks((prev) => prev.filter((b) => b.id !== id));
  };

  const openAddModal = () => {
    setSelectedIds(new Set());
    setAddModalOpen(true);
  };

  const confirmAddBooks = () => {
    const nextPos = books.length > 0
      ? Math.max(...books.map((b) => Number(b.position) || 0)) + 1
      : 1;

    const toAdd = availableBooks
      .filter((b) => selectedIds.has(b.id))
      .map((b, i) => ({
        id: b.id,
        title: b.title,
        authors: b.authors,
        coverUrl: b.coverUrl,
        position: String(nextPos + i)
      }));

    setBooks((prev) => [...prev, ...toAdd]);
    setAddModalOpen(false);
  };

  const saveBooks = async () => {
    setSaving(true);
    setSaveError("");
    try {
      await api(`/api/library/series/${seriesId}/books`, {
        method: "PUT",
        body: JSON.stringify({
          books: books.map((b) => ({
            bookId: b.id,
            position: b.position ? Number(b.position) : null
          }))
        })
      });
      setSeries((prev) => prev ? {
        ...prev,
        books: books.map((b) => ({
          id: b.id,
          title: b.title,
          authors: b.authors,
          coverUrl: b.coverUrl,
          seriesPosition: b.position ? Number(b.position) : null
        }))
      } : prev);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Unable to save");
    } finally {
      setSaving(false);
    }
  };

  const chooseCover = (file: File) => {
    if (coverPreview) URL.revokeObjectURL(coverPreview);
    setCoverFile(file);
    setCoverPreview(URL.createObjectURL(file));
    setRemoveCover(false);
  };

  const clearCover = () => {
    if (coverPreview) URL.revokeObjectURL(coverPreview);
    setCoverFile(null);
    setCoverPreview(null);
    setRemoveCover(true);
  };

  const openEditModal = () => {
    setEditName(series?.name ?? "");
    setEditDescription(series?.description ?? "");
    if (coverPreview) URL.revokeObjectURL(coverPreview);
    setCoverFile(null);
    setCoverPreview(null);
    setRemoveCover(false);
    setEditError("");
    setEditModalOpen(true);
  };

  const saveEdit = async () => {
    if (!editName.trim()) return;
    setEditSaving(true);
    setEditError("");
    try {
      await api(`/api/library/series/${seriesId}`, {
        method: "PATCH",
        body: JSON.stringify({ name: editName.trim(), description: editDescription.trim() || null })
      });

      let nextCoverUrl = series?.coverUrl ?? null;
      if (coverFile) {
        const res = await api<{ coverUrl: string }>(`/api/library/series/${seriesId}/cover`, {
          method: "PUT",
          headers: { "Content-Type": coverFile.type || "application/octet-stream" },
          body: coverFile
        });
        nextCoverUrl = res.coverUrl;
      } else if (removeCover && series?.coverUrl) {
        await api(`/api/library/series/${seriesId}/cover`, { method: "DELETE" });
        nextCoverUrl = null;
      }

      setSeries((prev) => prev ? {
        ...prev,
        name: editName.trim(),
        description: editDescription.trim() || null,
        coverUrl: nextCoverUrl
      } : prev);
      if (coverPreview) URL.revokeObjectURL(coverPreview);
      setCoverFile(null);
      setCoverPreview(null);
      setRemoveCover(false);
      setEditModalOpen(false);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Unable to save changes");
    } finally {
      setEditSaving(false);
    }
  };

  const deleteSeries = async () => {
    setDeleting(true);
    try {
      await api(`/api/library/series/${seriesId}`, { method: "DELETE" });
      navigate("/audiobooks/series");
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
      <DashboardShell active="audiobooks" user={user} logout={logout}>
        <section className="audiobook-main-page">
          <button className="audiobook-back-button" type="button" onClick={() => navigate(backTo ?? "/audiobooks/series")}>
            <ArrowLeft size={17} aria-hidden="true" />
            <span>{backTo ? "Back" : "Back to series"}</span>
          </button>
          <MessageBox tone="error" title="Error">{error}</MessageBox>
        </section>
      </DashboardShell>
    );
  }

  if (!series) {
    return (
      <DashboardShell active="audiobooks" user={user} logout={logout}>
        <section className="audiobook-main-page">
          <p className="management-empty">Loading series…</p>
        </section>
      </DashboardShell>
    );
  }

  // Compare the working list against the loaded baseline so we can surface a
  // clear "unsaved changes" state — removing/adding a book or editing a position
  // only mutates local state until the user saves.
  const baselinePositions = new Map(series.books.map((b) => [b.id, b.seriesPosition?.toString() ?? ""]));
  const isDirty =
    books.length !== series.books.length ||
    books.some((b) => !baselinePositions.has(b.id) || baselinePositions.get(b.id) !== b.position);

  return (
    <DashboardShell active="audiobooks" user={user} logout={logout}>
      <section className="audiobook-main-page">
        <button className="audiobook-back-button" type="button" onClick={() => navigate(backTo ?? "/audiobooks/series")}>
          <ArrowLeft size={17} aria-hidden="true" />
          <span>{backTo ? "Back" : "Back to series"}</span>
        </button>

        <div className="series-detail-head">
          <div className="series-name-edit">
            <h1>{series.name}</h1>
            <button className="icon-button" onClick={openEditModal} aria-label="Edit series">
              <Pencil size={16} />
            </button>
          </div>
          <p className="muted series-library-label">{series.libraryName}</p>
          {series.description && <p className="series-description">{series.description}</p>}
        </div>

        <div className="series-detail-actions">
          <button className="secondary-button" onClick={openAddModal}>
            <Plus size={16} /> Add books
          </button>
          <button className="primary-button" onClick={saveBooks} disabled={saving || !isDirty}>
            <Save size={16} /> {saving ? "Saving…" : "Save changes"}
          </button>
          {isDirty && <span className="series-unsaved-badge">Unsaved changes</span>}
          <button className="secondary-button" onClick={() => setDeleteConfirm(true)} style={{ marginLeft: "auto" }}>
            <Trash2 size={16} /> Delete series
          </button>
        </div>

        {saveError && <MessageBox tone="error" title="Save error">{saveError}</MessageBox>}
        {isDirty && !saveError && (
          <MessageBox tone="info" title="Unsaved changes">
            Your changes to this series aren't saved yet. Click "Save changes" to apply them.
          </MessageBox>
        )}

        {books.length === 0 ? (
          <div className="empty-state">
            <BookOpen size={40} aria-hidden="true" />
            <h2>No books yet</h2>
            <p className="muted">Click "Add books" to add books to this series.</p>
          </div>
        ) : (
          <div className="series-book-list">
            {books.map((book) => (
              <div key={book.id} className="series-book-row">
                <input
                  type="number"
                  className="series-position-input"
                  value={book.position}
                  onChange={(e) => setBooks((prev) => prev.map((b) => b.id === book.id ? { ...b, position: e.target.value } : b))}
                  placeholder="#"
                  min="0"
                  step="1"
                  aria-label="Position"
                />
                <div className="series-book-cover" aria-hidden="true">
                  {book.coverUrl ? <img src={book.coverUrl} alt="" /> : <BookOpen size={14} />}
                </div>
                <div className="series-book-info">
                  <button className="series-book-title-link" onClick={() => navigate(`/audiobooks/books/${book.id}`)}>
                    {book.title}
                  </button>
                  {book.authors.length > 0 && <span>{book.authors.join(", ")}</span>}
                </div>
                <button className="icon-button danger" onClick={() => removeBook(book.id)} aria-label="Remove from series">
                  <X size={16} />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {editModalOpen && (
        <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) setEditModalOpen(false); }}>
          <div className="confirm-modal" role="dialog" aria-modal="true" aria-label="Edit series" style={{ width: "min(100%, 520px)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
              <h2 style={{ margin: 0 }}>Edit series</h2>
              <button className="modal-close" onClick={() => setEditModalOpen(false)} aria-label="Close"><X size={18} /></button>
            </div>

            <div className="field" style={{ marginBottom: 12 }}>
              <span>Cover</span>
              <div className="series-cover-edit">
                <div className="series-cover-preview" aria-hidden="true">
                  {(coverPreview ?? (!removeCover ? series.coverUrl : null))
                    ? <img src={coverPreview ?? series.coverUrl ?? ""} alt="" />
                    : <BookOpen size={28} />}
                </div>
                <div className="series-cover-buttons">
                  <label className="secondary-button compact-button">
                    <Upload size={15} />
                    <span>Upload cover</span>
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      style={{ display: "none" }}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) chooseCover(file);
                        e.currentTarget.value = "";
                      }}
                    />
                  </label>
                  {(coverPreview ?? (!removeCover ? series.coverUrl : null)) && (
                    <button type="button" className="secondary-button compact-button" onClick={clearCover}>
                      <X size={15} /> Remove
                    </button>
                  )}
                </div>
              </div>
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

            <div className="field" style={{ marginBottom: 12 }}>
              <span>Description</span>
              <textarea
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                rows={4}
                placeholder="Optional description…"
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
          <div className="confirm-modal" role="dialog" aria-modal="true" aria-label="Delete series">
            <h2>Delete "{series.name}"?</h2>
            <p>This will remove the series and unlink all its books. The books themselves will not be deleted.</p>
            <div className="modal-actions">
              <button className="secondary-button" onClick={() => setDeleteConfirm(false)} disabled={deleting}>
                Cancel
              </button>
              <button className="danger-button" onClick={deleteSeries} disabled={deleting}>
                <Trash2 size={16} /> {deleting ? "Deleting…" : "Yes, delete series"}
              </button>
            </div>
          </div>
        </div>
      )}

      {addModalOpen && (
        <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) setAddModalOpen(false); }}>
          <div className="series-add-modal" role="dialog" aria-modal="true" aria-label="Add books">
            <div className="modal-header">
              <h2>Add books to series</h2>
              <button className="modal-close" onClick={() => setAddModalOpen(false)} aria-label="Close"><X size={18} /></button>
            </div>

            <div className="series-add-list">
              {availableBooks.length === 0 ? (
                <p className="management-empty">All books in this library are already in the series.</p>
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
                      {book.series && <small>Currently in: {book.series}</small>}
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
