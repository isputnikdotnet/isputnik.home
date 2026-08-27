import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, BookOpen, Pencil, Plus, Save, Trash2, Upload, X } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { getReferrer, goBack, navigate } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { Modal } from "../../shared/Modal";
import { Button } from "../../shared/Button";
import { SectionNav } from "../../shared/SectionNav";
import { bookSectionNav, sectionNavProps } from "./sectionNavItems";
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
  logout,
  kind = "audiobook"
}: {
  seriesId: string;
  user: PublicUser;
  logout: () => Promise<void>;
  kind?: "audiobook" | "ebook";
}) {
  const { t } = useTranslation(["common", "book"]);
  const mediaLabel = kind === "ebook" ? "ebooks" : "audiobooks";
  const base = `/${mediaLabel}`;
  const libPrefix = `/api/library/${kind}-libraries`;
  const sideNav = <SectionNav {...sectionNavProps(bookSectionNav(kind))} activeKey="series" />;
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
        return api<{ books: AudiobookBook[] }>(`${libPrefix}/${payload.series.libraryId}/books`);
      })
      .then((payload) => setLibraryBooks(payload.books))
      .catch((err) => setError(err instanceof Error ? err.message : t("book:series.unableLoad")));
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
      setSaveError(err instanceof Error ? err.message : t("common:errors.unableToSave"));
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
      setEditError(err instanceof Error ? err.message : t("book:series.unableSaveChanges"));
    } finally {
      setEditSaving(false);
    }
  };

  const deleteSeries = async () => {
    setDeleting(true);
    try {
      await api(`/api/library/series/${seriesId}`, { method: "DELETE" });
      navigate(`${base}/series`);
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
      <DashboardShell active={kind === "ebook" ? "ebooks" : "audiobooks"} user={user} logout={logout} sideNav={sideNav}>
        <section className="audiobook-main-page">
          <button className="audiobook-back-button" type="button" onClick={() => goBack(backTo ?? `${base}/series`)}>
            <ArrowLeft size={17} aria-hidden="true" />
            <span>{backTo ? t("book:catalog.back") : t("book:series.backToSeries")}</span>
          </button>
          <MessageBox tone="error" title={t("book:detail.errorTitle")}>{error}</MessageBox>
        </section>
      </DashboardShell>
    );
  }

  if (!series) {
    return (
      <DashboardShell active={kind === "ebook" ? "ebooks" : "audiobooks"} user={user} logout={logout} sideNav={sideNav}>
        <section className="audiobook-main-page">
          <p className="management-empty">{t("book:catalog.loadingSeries")}</p>
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
    <DashboardShell active={kind === "ebook" ? "ebooks" : "audiobooks"} user={user} logout={logout} sideNav={sideNav}>
      <section className="audiobook-main-page">
        <button className="audiobook-back-button" type="button" onClick={() => goBack(backTo ?? `${base}/series`)}>
          <ArrowLeft size={17} aria-hidden="true" />
          <span>{backTo ? t("book:catalog.back") : t("book:series.backToSeries")}</span>
        </button>

        <div className="series-detail-head">
          <div className="series-name-edit">
            <h1>{series.name}</h1>
            <button className="icon-button" onClick={openEditModal} aria-label={t("book:series.editSeriesAria")}>
              <Pencil size={16} />
            </button>
          </div>
          <p className="muted series-library-label">{series.libraryName}</p>
          {series.description && <p className="series-description">{series.description}</p>}
        </div>

        <div className="series-detail-actions">
          <button className="secondary-button" onClick={openAddModal}>
            <Plus size={16} /> {t("book:series.addBooks")}
          </button>
          <button className="primary-button" onClick={saveBooks} disabled={saving || !isDirty}>
            <Save size={16} /> {saving ? t("book:detail.saving") : t("book:person.saveChanges")}
          </button>
          {isDirty && <span className="series-unsaved-badge">{t("book:series.unsavedChanges")}</span>}
          <button className="secondary-button" onClick={() => setDeleteConfirm(true)} style={{ marginLeft: "auto" }}>
            <Trash2 size={16} /> {t("book:series.deleteSeriesButton")}
          </button>
        </div>

        {saveError && <MessageBox tone="error" title={t("book:series.saveErrorTitle")}>{saveError}</MessageBox>}
        {isDirty && !saveError && (
          <MessageBox tone="info" title={t("book:series.unsavedChanges")}>
            {t("book:series.unsavedChangesBody")}
          </MessageBox>
        )}

        {books.length === 0 ? (
          <div className="empty-state">
            <BookOpen size={40} aria-hidden="true" />
            <h2>{t("book:series.noBooksYetTitle")}</h2>
            <p className="muted">{t("book:series.noBooksYetBody")}</p>
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
                  aria-label={t("book:series.positionAria")}
                />
                <div className="series-book-cover" aria-hidden="true">
                  {book.coverUrl ? <img src={book.coverUrl} alt="" /> : <BookOpen size={14} />}
                </div>
                <div className="series-book-info">
                  <button className="series-book-title-link" onClick={() => navigate(`${base}/books/${book.id}`)}>
                    {book.title}
                  </button>
                  {book.authors.length > 0 && <span>{book.authors.join(", ")}</span>}
                </div>
                <button className="icon-button danger" onClick={() => removeBook(book.id)} aria-label={t("book:series.removeFromSeriesAria")}>
                  <X size={16} />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {editModalOpen && (
        <Modal
          title={t("book:series.editSeriesModalTitle")}
          style={{ width: "min(100%, 520px)" }}
          busy={editSaving}
          onClose={() => setEditModalOpen(false)}
        >
            <div className="field" style={{ marginBottom: 12 }}>
              <span>{t("book:compare.cover")}</span>
              <div className="series-cover-edit">
                <div className="series-cover-preview" aria-hidden="true">
                  {(coverPreview ?? (!removeCover ? series.coverUrl : null))
                    ? <img src={coverPreview ?? series.coverUrl ?? ""} alt="" />
                    : <BookOpen size={28} />}
                </div>
                <div className="series-cover-buttons">
                  <label className="secondary-button compact-button">
                    <Upload size={15} />
                    <span>{t("book:series.uploadCover")}</span>
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
                      <X size={15} /> {t("book:series.removeCover")}
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div className="field" style={{ marginBottom: 12 }}>
              <span>{t("book:person.fieldName")}</span>
              <input
                autoFocus
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) saveEdit(); }}
              />
            </div>

            <div className="field" style={{ marginBottom: 12 }}>
              <span>{t("book:metadata.fieldDescription")}</span>
              <textarea
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                rows={4}
                placeholder={t("book:series.descriptionPlaceholder")}
              />
            </div>

            {editError && <MessageBox tone="error" title={t("book:detail.errorTitle")}>{editError}</MessageBox>}

            <div className="modal-actions" style={{ marginTop: 16 }}>
              <Button variant="secondary" onClick={() => setEditModalOpen(false)} disabled={editSaving}>{t("common:common.cancel")}</Button>
              <Button variant="primary" onClick={saveEdit} disabled={editSaving || !editName.trim()}>
                {editSaving ? t("book:detail.saving") : t("book:person.saveChanges")}
              </Button>
            </div>
        </Modal>
      )}

      {deleteConfirm && (
        <ConfirmDialog
          title={t("book:series.deleteConfirmTitle", { name: series.name })}
          confirmLabel={t("book:series.deleteConfirmButton")}
          busyLabel={t("book:series.deletingLabel")}
          confirmIcon={<Trash2 size={16} />}
          danger
          busy={deleting}
          onConfirm={deleteSeries}
          onCancel={() => setDeleteConfirm(false)}
        >
          {t("book:series.deleteConfirmBody")}
        </ConfirmDialog>
      )}

      {addModalOpen && (
        <Modal
          variant="panel"
          title={t("book:series.addBooksModalTitle")}
          surfaceClassName="series-add-modal"
          onClose={() => setAddModalOpen(false)}
        >
            <div className="series-add-list">
              {availableBooks.length === 0 ? (
                <p className="management-empty">{t("book:series.allBooksAlreadyInSeries")}</p>
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
                      {book.series && <small>{t("book:series.currentlyIn", { series: book.series })}</small>}
                    </div>
                  </label>
                ))
              )}
            </div>

            <div className="modal-actions" style={{ padding: "12px 16px 16px" }}>
              <Button variant="secondary" onClick={() => setAddModalOpen(false)}>{t("common:common.cancel")}</Button>
              <Button
                variant="primary"
                onClick={confirmAddBooks}
                disabled={selectedIds.size === 0}
              >
                {t("book:series.addSelectedButton", { count: selectedIds.size })}
              </Button>
            </div>
        </Modal>
      )}
    </DashboardShell>
  );
}
