import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Eye, Image as ImageIcon, Library } from "lucide-react";
import { api } from "../../api";
import { navigate } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { Button } from "../../shared/Button";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { PhotoPicker } from "../gallery/PhotoPicker";
import type { GalleryAsset } from "../gallery/types";

/** What the form needs of an existing shelf to edit it. */
export interface CollectionFormTarget {
  id: string;
  title: string;
  description: string | null;
  coverItemId: string | null;
  coverUrl: string | null;
  /** Drives the extra warning in the delete dialog. */
  restricted: boolean;
}

/** Only the two fields the cover preview and the PATCH need. */
type CoverChoice = { id: string; coverUrl: string | null };

// One form for both doors into a collection: creating a new shelf, and editing
// the one you are standing on. Same fields, same live preview — an edit should
// look like what it changes, not like a different dialog. In edit mode the
// footer also carries Delete, so the collection page's hero keeps to the three
// things you do *with* a shelf (add, edit, share).
export function StoryCollectionFormModal({
  collection,
  storyCount = 0,
  onClose,
  onSaved
}: {
  /** Absent = create a new collection. Present = edit that one. */
  collection?: CollectionFormTarget;
  /** Shown in the preview card; the real count when editing. */
  storyCount?: number;
  onClose: () => void;
  /** Edit mode: the page reloads itself after a successful save. */
  onSaved?: () => void;
}) {
  const { t } = useTranslation(["common", "stories"]);
  const editing = Boolean(collection);
  const [title, setTitle] = useState(collection?.title ?? "");
  const [description, setDescription] = useState(collection?.description ?? "");
  const [cover, setCover] = useState<CoverChoice | null>(
    collection?.coverItemId ? { id: collection.coverItemId, coverUrl: collection.coverUrl } : null
  );
  const [pickingCover, setPickingCover] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const previewTitle = title.trim() || t("stories:collections.titlePlaceholder");
  const previewDescription = description.trim() || t("stories:collections.descriptionPlaceholder");

  const submit = async () => {
    const trimmed = title.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setError("");
    try {
      if (collection) {
        await api(`/api/stories/collections/${collection.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            title: trimmed,
            description: description.trim() || null,
            coverItemId: cover?.id ?? null
          })
        });
        onSaved?.();
        onClose();
        return;
      }
      const { collectionId } = await api<{ collectionId: string }>("/api/stories/collections", {
        method: "POST",
        body: JSON.stringify({ title: trimmed, description: description.trim() || null })
      });
      // Creation itself takes no cover — it's a follow-up PATCH, same as
      // setting one later from the collection page. A failure here shouldn't
      // strand an otherwise-successful create; the cover stays settable after.
      if (cover) {
        await api(`/api/stories/collections/${collectionId}`, {
          method: "PATCH",
          body: JSON.stringify({ coverItemId: cover.id })
        }).catch(() => {});
      }
      navigate(`/stories/collections/${collectionId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : t(editing ? "stories:errors.save" : "stories:errors.create"));
      setSaving(false);
    }
  };

  // Deleting takes the shelf, not its stories — so it leaves the page for the
  // index rather than reloading a collection that no longer exists.
  const remove = async () => {
    if (!collection) return;
    setDeleting(true);
    try {
      await api(`/api/stories/collections/${collection.id}`, { method: "DELETE" });
      navigate("/stories");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("stories:errors.delete"));
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  return (
    <Modal
      variant="panel"
      title={editing ? t("stories:collections.editTitle") : t("stories:collections.new")}
      subtitle={editing ? t("stories:collections.editIntro") : t("stories:collections.createIntro")}
      icon={<Library size={24} />}
      className="story-new-collection-modal"
      busy={saving || deleting}
      onClose={onClose}
      onSubmit={(event) => { event.preventDefault(); void submit(); }}
    >
      <div className="modal-tab-content story-new-collection-content">
        {error && (
          <MessageBox tone="error" title={t(editing ? "stories:errors.saveTitle" : "stories:errors.createTitle")}>
            {error}
          </MessageBox>
        )}

        <div className="story-new-collection-layout">
          <div className="story-new-collection-fields">
            <label className="field story-new-collection-field">
              <span>{t("stories:fields.title")}</span>
              <input
                autoFocus
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder={t("stories:collections.titlePlaceholder")}
                maxLength={160}
              />
              <small>{t("stories:collections.titleHint")}</small>
            </label>

            <label className="field story-new-collection-field">
              <span>{t("stories:collections.descriptionField")} <small className="muted">{t("stories:fields.optional")}</small></span>
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder={t("stories:collections.descriptionPlaceholder")}
                rows={5}
                maxLength={2000}
              />
              <small>{t("stories:collections.descriptionHint")}</small>
            </label>
          </div>

          <aside className="story-collection-preview-panel" aria-label={t("stories:collections.preview")}>
            <h3>
              <Eye size={20} aria-hidden="true" />
              <span>{t("stories:collections.preview")}</span>
            </h3>

            <div className="story-collection-preview-card">
              <div className="story-preview-covers" aria-hidden="true">
                {cover?.coverUrl ? (
                  <img src={cover.coverUrl} alt="" />
                ) : (
                  <>
                    <span className="story-preview-photo is-back-left" />
                    <span className="story-preview-photo is-back-right" />
                    <span className="story-preview-photo is-main" />
                    <span className="story-preview-photo is-side" />
                  </>
                )}
              </div>
              <strong>{previewTitle}</strong>
              <p>{previewDescription}</p>
              <span className="story-preview-divider" />
              <span className="story-preview-count">
                <Library size={14} aria-hidden="true" />
                {t("stories:collections.storyCount", { count: storyCount })}
              </span>
            </div>

            <div className="story-cover-field">
              <span>
                {t("stories:collections.coverImage")} <small className="muted">{t("stories:fields.optional")}</small>
              </span>
              {cover ? (
                <div className="story-chapter-hero-row">
                  <img className="story-chapter-hero-thumb" src={cover.coverUrl ?? undefined} alt="" />
                  <Button variant="secondary" compact onClick={() => setPickingCover(true)} disabled={saving}>
                    {t("stories:fields.changeCover")}
                  </Button>
                  <Button variant="text" compact onClick={() => setCover(null)} disabled={saving}>
                    {t("stories:fields.clearCover")}
                  </Button>
                </div>
              ) : (
                <Button
                  variant="secondary"
                  className="story-cover-picker-button"
                  onClick={() => setPickingCover(true)}
                  disabled={saving}
                >
                  <ImageIcon size={20} aria-hidden="true" />
                  <span>{t("stories:collections.setCover")}</span>
                </Button>
              )}
            </div>
          </aside>
        </div>

        <div className="modal-actions story-new-collection-actions">
          {editing && (
            <Button
              variant="danger"
              className="story-collection-delete-action"
              onClick={() => setConfirmDelete(true)}
              disabled={saving || deleting}
            >
              {t("stories:collections.deleteAction")}
            </Button>
          )}
          <Button variant="secondary" onClick={onClose} disabled={saving || deleting}>{t("common:common.cancel")}</Button>
          <Button variant="primary" type="submit" disabled={saving || deleting || !title.trim()}>
            {editing
              ? (saving ? t("stories:collections.saving") : t("stories:collections.save"))
              : (saving ? t("stories:collections.creating") : t("stories:collections.create"))}
          </Button>
        </div>
      </div>

      {pickingCover && (
        <PhotoPicker
          title={t("stories:collections.coverPickerTitle")}
          pick="any"
          onPick={(asset: GalleryAsset) => { setPickingCover(false); setCover({ id: asset.id, coverUrl: asset.coverUrl }); }}
          onClose={() => setPickingCover(false)}
        />
      )}

      {confirmDelete && collection && (
        <ConfirmDialog
          title={t("stories:collections.deleteTitle", { name: collection.title })}
          confirmLabel={t("stories:collections.deleteConfirm")}
          busyLabel={t("stories:collections.deleting")}
          danger
          busy={deleting}
          onConfirm={() => void remove()}
          onCancel={() => setConfirmDelete(false)}
        >
          {t("stories:collections.deleteBody")}
          {collection.restricted && (
            <>
              {" "}
              <strong>{t("stories:collections.deleteRestrictedWarning")}</strong>
            </>
          )}
        </ConfirmDialog>
      )}
    </Modal>
  );
}
