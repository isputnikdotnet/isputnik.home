import { useState } from "react";
import { useTranslation } from "react-i18next";
import { MapPin } from "lucide-react";
import { Modal } from "../../shared/Modal";
import { Button } from "../../shared/Button";
import { GalleryLocationPicker } from "../gallery/GalleryLocationPicker";
import { GalleryPlaceSearch } from "../gallery/GalleryPlaceSearch";

// Place a map block: search for a place (or drop a pin), name it, done. Both
// halves are the gallery's own location controls, so a story pins a place the
// same way a photo does.
export function StoryMapModal({
  initial,
  onSave,
  onClose
}: {
  initial: { lat: number; lng: number; zoom: number | null; label: string | null } | null;
  onSave: (value: { lat: number; lng: number; zoom: number; label: string | null }) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(["common", "stories"]);
  const [point, setPoint] = useState<{ lat: number; lng: number } | null>(
    initial ? { lat: initial.lat, lng: initial.lng } : null
  );
  const [label, setLabel] = useState(initial?.label ?? "");
  const [zoom, setZoom] = useState(initial?.zoom ?? 12);
  const [focus, setFocus] = useState<{ lat: number; lng: number; zoom?: number; nonce: number } | null>(null);

  const submit = () => {
    if (!point) return;
    onSave({ lat: point.lat, lng: point.lng, zoom, label: label.trim() || null });
  };

  return (
    <Modal
      variant="panel"
      title={initial ? t("stories:map.editTitle") : t("stories:map.addTitle")}
      icon={<MapPin size={20} />}
      onClose={onClose}
      onSubmit={(event) => { event.preventDefault(); submit(); }}
    >
      <div className="modal-tab-content story-map-modal">
        <GalleryPlaceSearch
          autoFocus
          onPick={(next, name, nextZoom) => {
            setPoint(next);
            setZoom(nextZoom ?? 12);
            setFocus({ ...next, zoom: nextZoom, nonce: Date.now() });
            // The place's own name is almost always the caption wanted; an
            // author who disagrees just types over it.
            if (!label.trim()) setLabel(name);
          }}
        />

        <GalleryLocationPicker value={point} onChange={setPoint} focus={focus} />

        <label className="field">
          <span>{t("stories:map.labelField")} <small className="muted">{t("stories:fields.optional")}</small></span>
          <input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder={t("stories:map.labelPlaceholder")}
            maxLength={200}
          />
        </label>

        <div className="modal-actions">
          <Button variant="secondary" onClick={onClose}>{t("common:common.cancel")}</Button>
          <Button variant="primary" type="submit" disabled={!point}>
            {initial ? t("stories:actions.save") : t("stories:map.addBlock")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
