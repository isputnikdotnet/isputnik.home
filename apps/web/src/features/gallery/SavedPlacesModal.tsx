import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Home, MapPin, MapPinned, Pencil, Trash2 } from "lucide-react";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { SAVED_PLACE_NAME_MAX, savedPlaceName, type SavedPlace } from "./savedPlaces";

// The whole list: rename a place, or delete it. One list for everyone who can
// edit photos, so a change here is a change for the household. Deleting a place
// takes away the shortcut and nothing else — photos pinned there keep their pin.
export function SavedPlacesModal({
  places,
  onClose,
  onChanged
}: {
  places: SavedPlace[];
  onClose: () => void;
  /** The list changed on the server: read it again. */
  onChanged: () => void;
}) {
  const { t } = useTranslation(["common", "gallery"]);
  const homeName = t("gallery:savedPlaces.home");

  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<SavedPlace | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ title: string; text: string } | null>(null);
  const [deleteError, setDeleteError] = useState("");

  const rename = async () => {
    if (!renaming || busy) return;
    const name = renaming.name.trim();
    const place = places.find((entry) => entry.id === renaming.id);
    if (!name || !place) return;
    if (name === place.name) { setRenaming(null); return; }
    setBusy(true);
    setError(null);
    try {
      await api(`/api/library/gallery/saved-places/${encodeURIComponent(renaming.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ name })
      });
      setRenaming(null);
      onChanged();
    } catch (err) {
      const title = t("gallery:savedPlaces.manageDialog.renameFailed");
      setError({ title, text: err instanceof Error ? err.message : title });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!deleting || busy) return;
    setBusy(true);
    setDeleteError("");
    try {
      await api(`/api/library/gallery/saved-places/${encodeURIComponent(deleting.id)}`, { method: "DELETE" });
      setDeleting(null);
      onChanged();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : t("gallery:savedPlaces.manageDialog.deleteFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t("gallery:savedPlaces.manageDialog.title")}
      icon={<MapPinned size={20} />}
      busy={busy}
      className="gallery-saved-places-modal"
      onClose={onClose}
    >
      <p className="muted">{t("gallery:savedPlaces.manageDialog.intro")}</p>

      {error && <MessageBox tone="error" title={error.title}>{error.text}</MessageBox>}

      {places.length === 0 ? (
        <p className="muted">{t("gallery:savedPlaces.manageDialog.empty")}</p>
      ) : (
        <ul className="gallery-saved-list">
          {places.map((place) => {
            const name = savedPlaceName(place, homeName);
            const editing = renaming?.id === place.id;
            return (
              <li key={place.id}>
                {place.home ? <Home size={16} aria-hidden="true" /> : <MapPin size={16} aria-hidden="true" />}
                {editing ? (
                  <>
                    <input
                      value={renaming.name}
                      onChange={(event) => setRenaming({ id: place.id, name: event.target.value })}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); void rename(); }
                        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setRenaming(null); }
                      }}
                      maxLength={SAVED_PLACE_NAME_MAX}
                      aria-label={t("gallery:savedPlaces.manageDialog.nameAria")}
                      disabled={busy}
                      autoFocus
                    />
                    <Button variant="primary" compact onClick={() => void rename()} disabled={busy || !renaming.name.trim()}>
                      {busy ? t("gallery:common.saving") : t("gallery:common.save")}
                    </Button>
                    <Button variant="secondary" compact onClick={() => setRenaming(null)} disabled={busy}>
                      {t("common:common.cancel")}
                    </Button>
                  </>
                ) : (
                  <>
                    <span className="gallery-saved-list-name">
                      <strong>{name}</strong>
                      <span className="muted">{place.lat.toFixed(5)}, {place.lng.toFixed(5)}</span>
                    </span>
                    <Button
                      variant="icon"
                      aria-label={t("gallery:savedPlaces.manageDialog.rename", { name })}
                      title={t("gallery:savedPlaces.manageDialog.rename", { name })}
                      onClick={() => { setError(null); setRenaming({ id: place.id, name }); }}
                      disabled={busy}
                    >
                      <Pencil size={16} aria-hidden="true" />
                    </Button>
                    <Button
                      variant="icon"
                      danger
                      aria-label={t("gallery:savedPlaces.manageDialog.delete", { name })}
                      title={t("gallery:savedPlaces.manageDialog.delete", { name })}
                      onClick={() => { setDeleteError(""); setDeleting(place); }}
                      disabled={busy}
                    >
                      <Trash2 size={16} aria-hidden="true" />
                    </Button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose} disabled={busy}>{t("common:common.close")}</Button>
      </div>

      {deleting && (
        <ConfirmDialog
          title={t("gallery:savedPlaces.manageDialog.deleteTitle", { name: savedPlaceName(deleting, homeName) })}
          confirmLabel={t("gallery:savedPlaces.manageDialog.deleteConfirm")}
          busyLabel={t("gallery:savedPlaces.manageDialog.deleting")}
          danger
          busy={busy}
          error={deleteError}
          onConfirm={() => void remove()}
          onCancel={() => setDeleting(null)}
        >
          {t("gallery:savedPlaces.manageDialog.deleteBody")}
        </ConfirmDialog>
      )}
    </Modal>
  );
}
