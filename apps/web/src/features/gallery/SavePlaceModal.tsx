import { useState } from "react";
import { useTranslation } from "react-i18next";
import { BookmarkPlus } from "lucide-react";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { SAVED_PLACE_NAME_MAX, type Point, type SavedPlace } from "./savedPlaces";

/** "12 Lenina Street, Ratomka, Minsk District, Belarus" suggests "12 Lenina
 *  Street": the first part is what people call the spot. */
function suggestName(label: string): string {
  return (label.split(",")[0] ?? "").trim().slice(0, SAVED_PLACE_NAME_MAX);
}

// Name the pin and keep it. Opened over the location editor, which may itself be
// a form (the bulk dialog): this one is not, so Enter is handled by hand and
// never reaches that form's submit.
export function SavePlaceModal({
  point,
  suggestedName,
  onClose,
  onSaved
}: {
  point: Point;
  suggestedName: string;
  onClose: () => void;
  onSaved: (place: SavedPlace) => void;
}) {
  const { t } = useTranslation(["common", "gallery"]);
  const [name, setName] = useState(() => suggestName(suggestedName));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const ready = name.trim().length > 0;

  const save = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError("");
    try {
      const payload = await api<{ place: SavedPlace }>("/api/library/gallery/saved-places", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), lat: point.lat, lng: point.lng })
      });
      onSaved(payload.place);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("gallery:savedPlaces.saveDialog.failed"));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t("gallery:savedPlaces.saveDialog.title")}
      icon={<BookmarkPlus size={20} />}
      busy={busy}
      className="gallery-save-place-modal"
      onClose={onClose}
    >
      <p className="muted">{t("gallery:savedPlaces.saveDialog.intro")}</p>

      {error && <MessageBox tone="error" title={t("gallery:savedPlaces.saveDialog.failed")}>{error}</MessageBox>}

      <label className="field gallery-save-place-field">
        <span>{t("gallery:savedPlaces.saveDialog.nameLabel")}</span>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            event.stopPropagation();
            void save();
          }}
          onFocus={(event) => event.currentTarget.select()}
          placeholder={t("gallery:savedPlaces.saveDialog.namePlaceholder")}
          maxLength={SAVED_PLACE_NAME_MAX}
          disabled={busy}
          autoFocus
        />
      </label>
      <span className="muted gallery-bulk-edit-hint">{point.lat.toFixed(5)}, {point.lng.toFixed(5)}</span>

      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose} disabled={busy}>{t("common:common.cancel")}</Button>
        <Button variant="primary" onClick={() => void save()} disabled={!ready || busy}>
          {busy ? t("gallery:common.saving") : t("gallery:savedPlaces.saveDialog.confirm")}
        </Button>
      </div>
    </Modal>
  );
}
