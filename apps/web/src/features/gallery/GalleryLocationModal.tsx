import { lazy, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";
import { MapPinned } from "lucide-react";
import { api } from "../../api";
import { PartialBulkError, sendInBatches } from "../../shared/bulk";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { GalleryPlaceSearch } from "./GalleryPlaceSearch";

const GalleryLocationPicker = lazy(() => import("./GalleryLocationPicker").then((m) => ({ default: m.GalleryLocationPicker })));

// Put the selected photos and videos on the map — the camera that had no GPS, or
// scans that never carried any. One point for the whole selection. Date taken is
// a separate dialog; single-item edits live in the lightbox Info panel.
export function GalleryLocationModal({
  itemIds,
  onClose,
  onApplied
}: {
  itemIds: string[];
  onClose: () => void;
  onApplied: (updated: number, forbidden: number) => void;
}) {
  const { t } = useTranslation(["common", "galleryModals"]);
  const [gps, setGps] = useState<{ lat: number; lng: number } | null>(null);
  const [focus, setFocus] = useState<{ lat: number; lng: number; zoom?: number; nonce: number } | null>(null);
  const [pickedLabel, setPickedLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const count = itemIds.length;

  // Move the map and the pin together, so what's shown is what will be saved.
  const place = (point: { lat: number; lng: number }, label: string, zoom?: number) => {
    setGps(point);
    setPickedLabel(label);
    setFocus({ ...point, zoom, nonce: Date.now() });
  };

  const apply = async () => {
    if (!gps) return;
    setBusy(true);
    setError("");
    try {
      const result = await sendInBatches<{ updated: number; forbidden: number }>(itemIds, (ids) =>
        api("/api/library/gallery/assets/bulk-place-time", {
          method: "POST",
          body: JSON.stringify({ ids, gps })
        }));
      onApplied(result.updated, result.forbidden);
      onClose();
    } catch (err) {
      // Batched: a failure part-way through has already changed everything the
      // earlier batches carried, and saying only "unable to update" would hide it.
      setError(err instanceof PartialBulkError
        ? t("galleryModals:common.partiallyApplied", { count: err.applied, error: err.message })
        : err instanceof Error ? err.message : t("galleryModals:location.unableToUpdate"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t("galleryModals:location.title")}
      icon={<MapPinned size={20} />}
      busy={busy}
      className="gallery-bulk-edit-modal"
      onClose={onClose}
      onSubmit={(event) => { event.preventDefault(); void apply(); }}
    >
      <p className="muted">
        {t("galleryModals:location.appliesTo", { count })}
      </p>

      {error && <MessageBox tone="error" title={t("common:errors.unableToSave")}>{error}</MessageBox>}

      <div className="gallery-bulk-edit-field">
        <GalleryPlaceSearch onPick={place} disabled={busy} autoFocus />

        <Suspense fallback={<div className="gallery-mini-map gallery-mini-map--loading" />}>
          <GalleryLocationPicker
            value={gps}
            focus={focus}
            onChange={(next) => { setGps(next); setPickedLabel(""); }}
          />
        </Suspense>
        <span className="muted gallery-bulk-edit-hint">
          {gps
            ? `${pickedLabel ? `${pickedLabel} — ` : ""}${gps.lat.toFixed(5)}, ${gps.lng.toFixed(5)}`
            : t("galleryModals:location.hintEmpty")}
        </span>
      </div>

      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose} disabled={busy}>{t("common:common.cancel")}</Button>
        <Button variant="primary" type="submit" disabled={!gps || busy}>
          {busy ? t("galleryModals:common.applying") : t("galleryModals:common.apply")}
        </Button>
      </div>
    </Modal>
  );
}
