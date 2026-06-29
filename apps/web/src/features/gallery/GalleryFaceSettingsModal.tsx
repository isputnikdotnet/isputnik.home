import { useEffect, useState } from "react";
import { ScanFace } from "lucide-react";
import { api } from "../../api";
import { Modal } from "../../shared/Modal";
import { Button } from "../../shared/Button";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { MessageBox } from "../../shared/MessageBox";
import type { GalleryFaceLibrary, GalleryFaceSettings } from "./types";

// Admin popup: turn face recognition on/off per gallery library and trigger a full
// rescan. Enabling a library kicks off an initial scan automatically (server side);
// "Rescan" reprocesses every photo from scratch.
export function GalleryFaceSettingsModal({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [libraries, setLibraries] = useState<GalleryFaceLibrary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmRescan, setConfirmRescan] = useState<GalleryFaceLibrary | null>(null);

  const load = async () => {
    try {
      const payload = await api<GalleryFaceSettings>("/api/library/gallery/faces/settings");
      setLibraries(payload.libraries);
      setLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load face-recognition settings");
    }
  };

  useEffect(() => { void load(); }, []);

  const toggle = async (library: GalleryFaceLibrary, enabled: boolean) => {
    setBusyId(library.id);
    setError("");
    setNotice("");
    try {
      const payload = await api<GalleryFaceSettings>("/api/library/gallery/faces/settings", {
        method: "PATCH",
        body: JSON.stringify({ libraryId: library.id, enabled })
      });
      setLibraries(payload.libraries);
      if (enabled) setNotice(`Face recognition on for "${library.name}" — scanning has started.`);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update");
    } finally {
      setBusyId(null);
    }
  };

  const rescan = async (library: GalleryFaceLibrary) => {
    setBusyId(library.id);
    setError("");
    setNotice("");
    try {
      await api("/api/library/gallery/faces/scan", { method: "POST", body: JSON.stringify({ libraryId: library.id, force: true }) });
      setNotice(`Full rescan started for "${library.name}". People update as photos are reprocessed.`);
      setConfirmRescan(null);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to start the rescan");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
    <Modal variant="card" title="Face recognition" icon={<ScanFace size={22} />} onClose={onClose}>
      <p className="muted gallery-face-modal-intro">
        Find faces in your photos and group the same person together — entirely on this server, nothing
        is sent to the internet. Turn it on per library.
      </p>

      {error && <MessageBox tone="error" title="Unable to save">{error}</MessageBox>}
      {notice && <MessageBox tone="success" title="Started">{notice}</MessageBox>}

      {loaded && libraries.length === 0 ? (
        <p className="management-empty">No gallery libraries yet.</p>
      ) : (
        <ul className="gallery-face-lib-list">
          {libraries.map((library) => (
            <li key={library.id} className="gallery-face-lib-row">
              <label className="field-checkbox gallery-face-lib-toggle">
                <input
                  type="checkbox"
                  checked={library.enabled}
                  disabled={busyId === library.id}
                  onChange={(event) => void toggle(library, event.target.checked)}
                />
                <span>
                  {library.name}
                  <small>
                    {library.enabled
                      ? `${library.scanned.toLocaleString()} of ${library.photos.toLocaleString()} photos scanned`
                      : `${library.photos.toLocaleString()} photos`}
                  </small>
                </span>
              </label>
              {library.enabled && (
                <Button variant="secondary" compact disabled={busyId === library.id} onClick={() => setConfirmRescan(library)}>
                  {busyId === library.id ? "Working…" : "Rescan"}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose}>Close</Button>
      </div>
    </Modal>

    {confirmRescan && (
      <ConfirmDialog
        title={`Rescan "${confirmRescan.name}"?`}
        confirmLabel="Rescan"
        busyLabel="Starting…"
        busy={busyId === confirmRescan.id}
        onConfirm={() => void rescan(confirmRescan)}
        onCancel={() => { if (busyId == null) setConfirmRescan(null); }}
      >
        This rebuilds the automatic face groups for this library from scratch. Your person names,
        manual tags, and the photos you've removed from named people are kept.
      </ConfirmDialog>
    )}
    </>
  );
}
