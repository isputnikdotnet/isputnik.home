import { Suspense, lazy, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { House } from "lucide-react";
import { api } from "../../../../api";
import { Button } from "../../../../shared/Button";
import { MessageBox } from "../../../../shared/MessageBox";
import { Modal } from "../../../../shared/Modal";
import type { HomeLocation } from "../../types";

// Where the household lives, for the Locations map. Its own connections never
// leave the LAN, so no database can place them — but the people who live here can,
// once, by clicking the map. Reuses the gallery's click-to-place picker (lazy, so
// Leaflet stays off this page's bundle unless someone opens this dialog).
const LocationPicker = lazy(() =>
  import("../../../gallery/GalleryLocationPicker").then((m) => ({ default: m.GalleryLocationPicker }))
);

export function HomeLocationModal({
  home,
  onSaved,
  onClose
}: {
  home: HomeLocation | null;
  onSaved: (home: HomeLocation | null) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(["common", "controlDash"]);
  const [point, setPoint] = useState<{ lat: number; lng: number } | null>(
    home ? { lat: home.latitude, lng: home.longitude } : null
  );
  const [label, setLabel] = useState(home?.label ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!point) return;
    setBusy(true);
    setError("");
    try {
      const payload = await api<{ home: HomeLocation | null }>("/api/dashboard/locations/home", {
        method: "PUT",
        body: JSON.stringify({ latitude: point.lat, longitude: point.lng, label: label.trim() })
      });
      onSaved(payload.home);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlDash:homeLoc.saveFailed"));
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    setError("");
    try {
      await api<{ home: HomeLocation | null }>("/api/dashboard/locations/home", {
        method: "PUT",
        body: JSON.stringify({ latitude: null })
      });
      onSaved(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlDash:homeLoc.clearFailed"));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t("controlDash:homeLoc.title")}
      icon={<House size={20} />}
      busy={busy}
      className="gallery-bulk-edit-modal"
      onClose={onClose}
      onSubmit={save}
    >
      <p className="muted">{t("controlDash:homeLoc.intro")}</p>

      {error && <MessageBox tone="error" title={t("controlDash:homeLoc.saveFailed")}>{error}</MessageBox>}

      <div className="gallery-bulk-edit-field">
        <Suspense fallback={<div className="gallery-mini-map gallery-mini-map--loading" />}>
          <LocationPicker value={point} onChange={setPoint} />
        </Suspense>
        <span className="muted gallery-bulk-edit-hint">
          {point ? `${point.lat.toFixed(4)}, ${point.lng.toFixed(4)}` : t("controlDash:homeLoc.nothingPicked")}
        </span>
      </div>

      <label className="field">
        <span>{t("controlDash:homeLoc.labelField")}</span>
        <input
          type="text"
          value={label}
          maxLength={60}
          placeholder={t("controlDash:homeLoc.labelPlaceholder")}
          disabled={busy}
          onChange={(event) => setLabel(event.target.value)}
        />
      </label>

      <div className="modal-actions">
        {home && (
          <Button variant="text" danger disabled={busy} onClick={clear}>
            {t("controlDash:homeLoc.clear")}
          </Button>
        )}
        <Button variant="secondary" onClick={onClose} disabled={busy}>{t("common.cancel")}</Button>
        <Button variant="primary" type="submit" disabled={!point || busy}>
          {busy ? t("controlDash:homeLoc.saving") : t("controlDash:homeLoc.save")}
        </Button>
      </div>
    </Modal>
  );
}
