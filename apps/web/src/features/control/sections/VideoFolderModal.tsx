import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../../api";
import { Button } from "../../../shared/Button";
import { MessageBox } from "../../../shared/MessageBox";
import { Modal } from "../../../shared/Modal";
import { FolderPickerModal, type FolderBrowse } from "../libraries/FolderPickerModal";
import type { ConversionState } from "./VideoSettingsSection";

// Videos › Video Streaming › Disk & memory › Change (engine 0.42+): where the video
// container keeps video, chosen here instead of in the container's own settings —
// with the SAME picker Add library chooses a folder with (owner, 2026-11-22): a
// location on top, its folders under it, Use this folder. The locations are the
// video container's own: where the libraries are, its cache folder, and any other
// disk mapped into it; never its Config & Data folder, which is backed up. The
// engine works in a folder of its own inside the one picked, and uses it from its
// next start — the card says so afterwards, so the dialog does not have to.

/** The place chosen in home, as the engine keeps it. */
export interface VideoFolderChoice {
  /** Null: the container's own setting (its Video Cache mapping). */
  folder: string | null;
  /** Saved, and in force once the container has restarted. */
  pending: boolean;
  /** Why the saved place was set aside at the last start, if it was. */
  problem: string | null;
}

/** GET {prefix}/api/admin/conversion/folders. */
interface FoldersAnswer {
  places: { id: string; kind: "libraries" | "cache" | "disk"; path: string; writable: boolean }[];
  choice: VideoFolderChoice;
  /** The container's own cache folder, when it has one. */
  container: string | null;
}

export function VideoFolderModal({ url, onSaved, onClose }: {
  /** {prefix}/api/admin/conversion. */
  url: string;
  onSaved: (state: ConversionState) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const [answer, setAnswer] = useState<FoldersAnswer | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api<FoldersAnswer>(`${url}/folders`).then(
      (loaded) => { if (live) setAnswer(loaded); },
      (err) => { if (live) setError(err instanceof Error ? err.message : t("controlAdmin:apps.videoFolder.loadFailed")); }
    );
    return () => { live = false; };
  }, [url, t]);

  const title = t("controlAdmin:apps.videoFolder.title");
  // Nothing to walk yet, or nowhere to keep video at all: said in a line.
  if (!answer || answer.places.length === 0) {
    return (
      <Modal variant="card" title={title} onClose={onClose}>
        {error
          ? <MessageBox tone="error" title={t("controlAdmin:apps.videoFolder.loadFailed")}>{error}</MessageBox>
          : <p className="muted">{answer ? t("controlAdmin:apps.videoFolder.noPlaces") : t("controlAdmin:ui.loading")}</p>}
        <div className="modal-actions">
          <Button variant="secondary" onClick={onClose}>{t("common.close")}</Button>
        </div>
      </Modal>
    );
  }

  const name = (place: FoldersAnswer["places"][number]) => (
    place.kind === "libraries" ? `${t("controlAdmin:apps.videoFolder.placeLibraries")} (${place.path})`
      : place.kind === "cache" ? `${t("controlAdmin:apps.videoFolder.placeCache")} (${place.path})`
      : place.path
  );
  // Opens where the choice is; else on the cache folder, the usual answer; else the first.
  const current = answer.choice.folder ?? answer.container;
  const opened = answer.places.find((place) => current !== null && (current === place.path || current.startsWith(`${place.path}/`) || current.startsWith(`${place.path}\\`)))
    ?? answer.places.find((place) => place.kind === "cache")
    ?? answer.places.find((place) => place.writable)
    ?? answer.places[0];

  return (
    <FolderPickerModal
      title={title}
      intro={t("controlAdmin:apps.videoFolder.intro")}
      rootLabel={t("controlAdmin:apps.videoFolder.location")}
      storageRoots={answer.places.map((place) => ({ id: place.id, name: name(place) }))}
      initialRootId={opened.id}
      confirmLabel={t("controlAdmin:apps.videoFolder.save")}
      browseFolders={(place, relative) => api<FolderBrowse>(`${url}/folders/browse?${new URLSearchParams({ place, path: relative })}`)}
      blocked={(place) => (answer.places.find((entry) => entry.id === place)?.writable === false
        ? { title: t("controlAdmin:apps.videoFolder.readOnly"), body: t("controlAdmin:apps.videoFolder.readOnlyBody") }
        : null)}
      error={error}
      busy={busy}
      onError={setError}
      onClose={onClose}
      onPick={({ absolutePath }) => {
        setBusy(true);
        setError("");
        return api<ConversionState>(`${url}/folder`, { method: "PUT", body: JSON.stringify({ folder: absolutePath }) })
          .then((state) => { onSaved(state); onClose(); })
          .catch((err) => setError(err instanceof Error ? err.message : t("controlAdmin:apps.videoFolder.saveFailed")))
          .finally(() => setBusy(false));
      }}
    />
  );
}
