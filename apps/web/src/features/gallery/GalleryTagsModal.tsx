import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Tags } from "lucide-react";
import { api } from "../../api";
import { PartialBulkError, sendInBatches } from "../../shared/bulk";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { BulkTagEditor, hasTagChange, NO_TAG_CHANGE, type BulkTagChange } from "../../shared/tags/BulkTagEditor";
import { useTagSuggestions } from "../../shared/tags/useTagSuggestions";

// Tag a whole selection at once from the multi-select bar — the holiday folder
// that should all read "Crete 2019". The dialog is the shared BulkTagEditor: the
// tags the selection already wears, × to take one off all of it, the search box
// to put one on all of it; a photo keeps every other tag it carries. Single-item
// edits live in the lightbox's Details panel, which wears the same editor.
export function GalleryTagsModal({
  itemIds,
  onClose,
  onApplied
}: {
  itemIds: string[];
  onClose: () => void;
  onApplied: (updated: number, forbidden: number, change: BulkTagChange) => void;
}) {
  const { t } = useTranslation(["common", "galleryModals"]);
  const suggestions = useTagSuggestions("gallery");
  const [change, setChange] = useState<BulkTagChange>(NO_TAG_CHANGE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const ready = hasTagChange(change);

  const apply = async () => {
    if (!ready) return;
    setBusy(true);
    setError("");
    try {
      const body = {
        ...(change.add.length > 0 ? { add: change.add } : {}),
        ...(change.remove.length > 0 ? { remove: change.remove } : {})
      };
      const result = await sendInBatches<{ updated: number; forbidden: number }>(itemIds, (ids) =>
        api("/api/library/gallery/assets/bulk-tags", {
          method: "POST",
          body: JSON.stringify({ ids, ...body })
        }));
      onApplied(result.updated, result.forbidden, change);
      onClose();
    } catch (err) {
      // Batched: a failure part-way through has already changed everything the
      // earlier batches carried, and saying only "unable to update" would hide it.
      setError(err instanceof PartialBulkError
        ? t("galleryModals:common.partiallyApplied", { count: err.applied, error: err.message })
        : err instanceof Error ? err.message : t("galleryModals:tags.unableToUpdate"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t("galleryModals:tags.title")}
      icon={<Tags size={20} />}
      busy={busy}
      className="gallery-bulk-edit-modal"
      onClose={onClose}
      onSubmit={(event) => { event.preventDefault(); void apply(); }}
    >
      <p className="muted">{t("galleryModals:tags.appliesTo", { count: itemIds.length })}</p>

      {error && <MessageBox tone="error" title={t("common:errors.unableToSave")}>{error}</MessageBox>}

      <div className="gallery-bulk-edit-field">
        <BulkTagEditor itemIds={itemIds} suggestions={suggestions} value={change} onChange={setChange} busy={busy} />
      </div>

      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose} disabled={busy}>{t("common:common.cancel")}</Button>
        <Button variant="primary" type="submit" disabled={!ready || busy}>
          {busy ? t("galleryModals:common.applying") : t("galleryModals:common.apply")}
        </Button>
      </div>
    </Modal>
  );
}
