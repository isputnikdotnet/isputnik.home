import { useCallback, useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { ScanFace, Trash2 } from "lucide-react";
import { api } from "../../../api";
import { controlHref } from "../../../router";
import { formatNumber } from "../../../shared/dates";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { ActionRow, GroupedList, ToggleRow } from "../../../shared/GroupedList";
import { MessageBox } from "../../../shared/MessageBox";
import { Modal } from "../../../shared/Modal";
import { Button } from "../../../shared/Button";
import type { GalleryFaceEngineStatus, GalleryFaceLibrary, GalleryFaceSettings } from "../../gallery/types";

// Face recognition for ONE gallery library, opened from that library's Manage
// page: its switch, a full rescan, and removing what was found in it. What is the
// same for every library (the engine, how strongly faces are grouped, the people
// check, the nightly job) is on Applications › Gallery › Recognition, linked below.
export function LibraryFacesDialog({ libraryId, libraryName, onClose, onChanged }: {
  libraryId: string;
  libraryName: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useTranslation(["common", "galleryModals", "controlAdmin"]);
  const [library, setLibrary] = useState<GalleryFaceLibrary | null>(null);
  const [engine, setEngine] = useState<GalleryFaceEngineStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirm, setConfirm] = useState<"rescan" | "clear" | null>(null);
  // Nothing can find faces: switching ON and rescanning wait for the engine.
  // Switching OFF and removing data always work.
  const noEngine = engine?.where === "none";

  const take = useCallback((payload: GalleryFaceSettings) => {
    setLibrary(payload.libraries.find((entry) => entry.id === libraryId) ?? null);
    setLoaded(true);
  }, [libraryId]);

  useEffect(() => {
    api<GalleryFaceSettings>("/api/library/gallery/faces/settings").then(take)
      .catch((err) => setError(err instanceof Error ? err.message : t("galleryModals:faceSettings.unableToLoad")));
    api<GalleryFaceEngineStatus>("/api/library/gallery/faces/engine").then(setEngine).catch(() => undefined);
  }, [take, t]);

  const run = async (work: () => Promise<void>, failed: string) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
      setConfirm(null);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : failed);
      setConfirm(null);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (enabled: boolean) => run(async () => {
    take(await api<GalleryFaceSettings>("/api/library/gallery/faces/settings", { method: "PATCH", body: JSON.stringify({ libraryId, enabled }) }));
    if (enabled) setNotice(t("galleryModals:faceSettings.enabledNotice", { name: libraryName }));
  }, t("galleryModals:faceSettings.unableToUpdate"));

  const rescan = () => run(async () => {
    await api("/api/library/gallery/faces/scan", { method: "POST", body: JSON.stringify({ libraryId, force: true }) });
    setNotice(t("galleryModals:faceSettings.rescanNotice", { name: libraryName }));
    take(await api<GalleryFaceSettings>("/api/library/gallery/faces/settings"));
  }, t("galleryModals:faceSettings.unableToRescan"));

  const clear = () => run(async () => {
    take(await api<GalleryFaceSettings>("/api/library/gallery/faces/data", { method: "DELETE", body: JSON.stringify({ libraryId }) }));
    setNotice(t("galleryModals:faceSettings.clearedNotice", { name: libraryName }));
  }, t("galleryModals:faceSettings.unableToClear"));

  return (
    <>
      <Modal
        variant="card"
        title={t("controlAdmin:recognition.libraryDialogTitle", { name: libraryName })}
        icon={<ScanFace size={22} />}
        busy={busy}
        onClose={onClose}
      >
        {noEngine && (
          <MessageBox tone="warning" title={t("galleryModals:faceSettings.engineNoneTitle")}>{engine?.reason}</MessageBox>
        )}
        {error && <MessageBox tone="error" title={t("common:errors.unableToSave")}>{error}</MessageBox>}
        {notice && <MessageBox tone="success" title={t("galleryModals:faceSettings.startedTitle")}>{notice}</MessageBox>}

        {loaded && !library && <p className="management-empty">{t("controlAdmin:recognition.libraryNotScanned")}</p>}
        {library && (
          <GroupedList>
            <ToggleRow
              label={t("controlAdmin:recognition.libraryDialogSwitch")}
              sub={library.enabled
                ? <>
                    {t("galleryModals:faceSettings.scannedOf", { scanned: formatNumber(library.scanned), count: library.photos })}
                    {library.unreadable > 0 && <span title={t("galleryModals:faceSettings.unreadableHint")}>{t("galleryModals:faceSettings.unreadableCount", { count: library.unreadable })}</span>}
                  </>
                : t("galleryModals:common.photoCount", { count: library.photos })}
              checked={library.enabled}
              disabled={busy || (noEngine && !library.enabled)}
              onChange={(next) => void toggle(next)}
            />
            {library.enabled && (
              <ActionRow
                label={t("controlAdmin:recognition.libraryDialogRescan")}
                disabled={busy || noEngine}
                onClick={() => { setError(""); setConfirm("rescan"); }}
              />
            )}
            {(library.enabled || library.scanned > 0) && (
              <ActionRow
                tone="danger"
                label={t("galleryModals:faceSettings.removeDataTitle")}
                disabled={busy}
                onClick={() => { setError(""); setConfirm("clear"); }}
              />
            )}
          </GroupedList>
        )}

        <p className="muted">
          {t("controlAdmin:recognition.libraryDialogElsewhere")}{" "}
          <a href={`${controlHref("recognition")}#recognition-faces`}>{t("controlAdmin:recognition.openRecognition")}</a>
        </p>

        <div className="modal-actions">
          <Button variant="secondary" disabled={busy} onClick={onClose}>{t("common:common.close")}</Button>
        </div>
      </Modal>

      {confirm === "rescan" && (
        <ConfirmDialog
          title={t("galleryModals:faceSettings.rescanConfirmTitle", { name: libraryName })}
          confirmLabel={t("galleryModals:faceSettings.rescanConfirmLabel")}
          busyLabel={t("galleryModals:faceSettings.starting")}
          busy={busy}
          onConfirm={() => void rescan()}
          onCancel={() => { if (!busy) setConfirm(null); }}
        >
          {t("galleryModals:faceSettings.rescanConfirmBody")}
        </ConfirmDialog>
      )}

      {confirm === "clear" && (
        <ConfirmDialog
          title={t("galleryModals:faceSettings.clearConfirmTitle", { name: libraryName })}
          confirmLabel={t("galleryModals:faceSettings.clearConfirmLabel")}
          busyLabel={t("galleryModals:faceSettings.removing")}
          confirmIcon={<Trash2 size={15} />}
          danger
          rich
          busy={busy}
          onConfirm={() => void clear()}
          onCancel={() => { if (!busy) setConfirm(null); }}
        >
          <p><Trans i18nKey="faceSettings.clearConfirmBody1" ns="galleryModals" values={{ name: libraryName }} components={{ bold: <strong /> }} /></p>
          <p><Trans i18nKey="faceSettings.clearConfirmBody2" ns="galleryModals" components={{ bold: <strong /> }} /></p>
        </ConfirmDialog>
      )}
    </>
  );
}
