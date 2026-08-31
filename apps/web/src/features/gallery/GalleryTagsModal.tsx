import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Tags, X } from "lucide-react";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";

// Tag a whole selection at once from the multi-select bar — the holiday folder
// that should all read "Crete 2019". Add and Remove rather than replace: a photo
// keeps whatever tags it already carries, so a mis-typed batch is undone by
// removing the same tag again. Suggestions come from the gallery facets, which
// already list every tag in scope. Single-item edits live in the lightbox Info
// panel; this is the batch door onto the same taggables rows.
export function GalleryTagsModal({
  itemIds,
  suggestions,
  onClose,
  onApplied
}: {
  itemIds: string[];
  suggestions: string[];
  onClose: () => void;
  onApplied: (updated: number, forbidden: number, mode: "add" | "remove", tags: string[]) => void;
}) {
  const { t } = useTranslation(["common", "galleryModals"]);
  const [mode, setMode] = useState<"add" | "remove">("add");
  const [tags, setTags] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const count = itemIds.length;

  // A tag is "the same" when it only differs by case or padding — the server
  // normalizes further, but this keeps the chip row from showing a duplicate.
  const addTag = (raw: string) => {
    const value = raw.trim();
    if (!value) return;
    setTags((current) => (
      current.some((tag) => tag.toLowerCase() === value.toLowerCase()) ? current : [...current, value]
    ));
    setDraft("");
  };

  const dropTag = (value: string) => setTags((current) => current.filter((tag) => tag !== value));

  // Enter and comma both commit the draft; backspace on an empty box takes the
  // last chip back, the usual chip-input reflex.
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      addTag(draft);
    } else if (event.key === "Backspace" && draft === "" && tags.length > 0) {
      dropTag(tags[tags.length - 1]);
    }
  };

  // Anything still in the box counts — nobody expects an unconfirmed word to be
  // dropped on Apply.
  const pending = [...tags];
  if (draft.trim() && !pending.some((tag) => tag.toLowerCase() === draft.trim().toLowerCase())) {
    pending.push(draft.trim());
  }
  const ready = pending.length > 0;

  const unusedSuggestions = suggestions
    .filter((tag) => !pending.some((chosen) => chosen.toLowerCase() === tag.toLowerCase()))
    .slice(0, 12);

  const apply = async () => {
    if (!ready) return;
    setBusy(true);
    setError("");
    try {
      const body = mode === "add" ? { ids: itemIds, add: pending } : { ids: itemIds, remove: pending };
      const result = await api<{ updated: number; forbidden: number }>(
        "/api/library/gallery/assets/bulk-tags",
        { method: "POST", body: JSON.stringify(body) }
      );
      onApplied(result.updated, result.forbidden, mode, pending);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("galleryModals:tags.unableToUpdate"));
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
      <p className="muted">{t("galleryModals:tags.appliesTo", { count })}</p>

      {error && <MessageBox tone="error" title={t("common:errors.unableToSave")}>{error}</MessageBox>}

      <div className="gallery-bulk-edit-modes" role="radiogroup" aria-label={t("galleryModals:tags.modeAria")}>
        <label>
          <input type="radio" name="tag-mode" checked={mode === "add"} onChange={() => setMode("add")} disabled={busy} />
          <span>{t("galleryModals:tags.modeAdd")}</span>
        </label>
        <label>
          <input type="radio" name="tag-mode" checked={mode === "remove"} onChange={() => setMode("remove")} disabled={busy} />
          <span>{t("galleryModals:tags.modeRemove")}</span>
        </label>
      </div>

      <div className="gallery-bulk-edit-field">
        {tags.length > 0 && (
          <ul className="gallery-tag-chips">
            {tags.map((tag) => (
              <li key={tag}>
                <span>{tag}</span>
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => dropTag(tag)}
                  disabled={busy}
                  title={t("galleryModals:tags.removeChipTitle", { tag })}
                  aria-label={t("galleryModals:tags.removeChipTitle", { tag })}
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}

        <label>
          <span className="sr-only">{t("galleryModals:tags.inputSr")}</span>
          <input
            list="gallery-bulk-tag-suggestions"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t("galleryModals:tags.placeholder")}
            maxLength={80}
            disabled={busy}
            autoFocus
          />
        </label>
        <datalist id="gallery-bulk-tag-suggestions">
          {suggestions.map((tag) => <option key={tag} value={tag} />)}
        </datalist>
        <span className="muted gallery-bulk-edit-hint">
          {mode === "add" ? t("galleryModals:tags.addHint") : t("galleryModals:tags.removeHint")}
        </span>

        {unusedSuggestions.length > 0 && (
          <div className="gallery-tag-suggestions">
            <span className="muted">{t("galleryModals:tags.suggestionsLabel")}</span>
            {unusedSuggestions.map((tag) => (
              <button
                key={tag}
                type="button"
                className="secondary-button compact-button"
                onClick={() => addTag(tag)}
                disabled={busy}
              >
                {tag}
              </button>
            ))}
          </div>
        )}
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
