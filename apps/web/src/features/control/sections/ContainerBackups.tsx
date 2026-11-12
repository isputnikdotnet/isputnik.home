import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { DatabaseBackup, RotateCcw, Trash2, Undo2, UploadCloud } from "lucide-react";
import { api } from "../../../api";
import { appPageHref } from "../links";
import { controlHref, followRoute } from "../../../router";
import { Button } from "../../../shared/Button";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { FileUpload } from "../../../shared/FileUpload";
import { MessageBox } from "../../../shared/MessageBox";
import { Modal } from "../../../shared/Modal";
import { ActionRow, CommandRow, GroupedList, InfoRow, InputRow, NavRow, ToggleRow } from "../../../shared/GroupedList";
import { queryPageHref, useQueryPage } from "../../../shared/useQueryPage";
import { ControlSectionHead } from "../ControlSectionHead";
import { formatBytes, formatManagedDate } from "../../../shared/utils";
import { useAppName } from "./AppsSection";

// A row per container, opening its own backup page: back it up, download it and restore it
// apart from Home and from the other containers (server: backups/app-backups.ts).
// Its backups are its own files and the copies inside Home's full and minimal zips;
// both download and restore alike, and only its own files can be deleted here.

interface AppBackupFile {
  name: string;
  sizeBytes: number;
  createdAt: string;
  version: string | null;
  source: "own" | "full" | "minimal";
}

interface AppBackupView {
  id: string;
  configured: boolean;
  problem: string | null;
  include: boolean;
  keep: number;
  files: AppBackupFile[];
  restoreSupported: boolean | null;
  undo: { takenAt: string; version: string; bytes: number } | null;
}

const apiPath = (id: string) => `/api/backups/apps/${encodeURIComponent(id)}`;
const filePath = (id: string, name: string) => `${apiPath(id)}/files/${encodeURIComponent(name)}`;

export function ContainerBackups({ appId, onOpen }: { appId?: string; onOpen: (id: string) => void }) {
  const { t } = useTranslation(["common", "control"]);
  const appName = useAppName();
  const [apps, setApps] = useState<AppBackupView[] | null>(null);
  const [loadError, setLoadError] = useState("");

  const load = useCallback(async () => {
    const payload = await api<{ apps: AppBackupView[] }>("/api/backups/apps");
    setApps(payload.apps);
  }, []);

  useEffect(() => {
    load().catch((err) => setLoadError(err instanceof Error ? err.message : t("control:containerBackup.loadFailed")));
  }, [load, t]);

  const app = apps?.find((candidate) => candidate.id === appId);
  if (app) return <ContainerDetail key={app.id} app={app} reload={load} />;

  return (
    <>
      {appId && <ControlSectionHead section="backup" title={appName(appId)} back={{ href: controlHref("backup"), label: t("control:backup.back") }} />}
      {loadError ? <MessageBox tone="error" title={t("control:containerBackup.loadFailed")}>{loadError}</MessageBox>
        : appId ? <p className="muted">{apps ? t("control:backup.gone") : t("control:ui.loading")}</p>
          : <GroupedList id="container-backups" title={t("control:backup.applicationsTitle")}>
            {!apps && <InfoRow label={t("control:ui.loading")} />}
            {apps?.map((item) => {
              const latest = [...item.files].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
              return <NavRow key={item.id} label={appName(item.id)}
                sub={item.configured && item.restoreSupported === null ? t("control:containerBackup.noAnswerTitle") : undefined}
                value={!item.configured ? t("control:backup.notConnected") : latest ? formatManagedDate(latest.createdAt) : t("control:backup.emptyTitle")}
                onClick={() => onOpen(item.id)} />;
            })}
          </GroupedList>}
    </>
  );
}

function ContainerDetail({ app, reload }: { app: AppBackupView; reload: () => Promise<void> }) {
  const { t } = useTranslation(["common", "control"]);
  const appName = useAppName();
  const name = appName(app.id);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [backingUp, setBackingUp] = useState(false);
  const [keep, setKeep] = useState(app.keep);
  const [saving, setSaving] = useState(false);
  const [pendingRestore, setPendingRestore] = useState<AppBackupFile | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AppBackupFile | null>(null);
  const [undoOpen, setUndoOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fileKey, openFile] = useQueryPage("file");
  const fileKeyOf = (file: AppBackupFile) => JSON.stringify([file.source, file.name]);
  const selectedFile = app.files.find((file) => fileKeyOf(file) === fileKey);

  useEffect(() => { setKeep(app.keep); }, [app.keep]);

  const canRestore = app.configured && app.restoreSupported === true;
  const clear = () => { setError(""); setNotice(""); };

  const backUp = async () => {
    setBackingUp(true);
    clear();
    try {
      const payload = await api<{ backup: { name: string } }>(apiPath(app.id), { method: "POST" });
      setNotice(t("control:containerBackup.backedUp", { name: payload.backup.name }));
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("control:containerBackup.backUpFailed"));
    } finally {
      setBackingUp(false);
    }
  };

  const saveSettings = async (patch: { include?: boolean; keep?: number }) => {
    setSaving(true);
    clear();
    try {
      await api(`${apiPath(app.id)}/settings`, { method: "PATCH", body: JSON.stringify(patch) });
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("control:containerBackup.saveFailed"));
      setKeep(app.keep);
    } finally {
      setSaving(false);
    }
  };

  /** A box left empty or out of range goes back to what the server last said. */
  const commitKeep = () => {
    const wanted = Math.floor(keep);
    if (!Number.isFinite(wanted) || wanted < 1 || wanted > 100) {
      setKeep(app.keep);
      return;
    }
    if (wanted !== app.keep) void saveSettings({ keep: wanted });
  };

  const act = async (run: () => Promise<unknown>, done: string, failed: string, close: () => void) => {
    setBusy(true);
    clear();
    try {
      await run();
      setNotice(done);
      close();
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : failed);
    } finally {
      setBusy(false);
    }
  };

  const restore = (file: AppBackupFile) =>
    act(
      () => api(`${filePath(app.id, file.name)}/restore`, { method: "POST", body: "{}" }),
      t("control:containerBackup.restored", { app: name, date: formatManagedDate(file.createdAt) }),
      t("control:containerBackup.restoreFailed"),
      () => setPendingRestore(null)
    );

  const undo = () =>
    act(
      () => api(`${apiPath(app.id)}/undo`, { method: "POST", body: "{}" }),
      t("control:containerBackup.undone", { app: name }),
      t("control:containerBackup.undoFailed"),
      () => setUndoOpen(false)
    );

  const remove = (file: AppBackupFile) =>
    act(
      () => api(filePath(app.id, file.name), { method: "DELETE" }),
      t("control:containerBackup.deleted", { name: file.name }),
      t("control:containerBackup.deleteFailed"),
      () => { setPendingDelete(null); openFile(null); }
    );

  const sourceLabel = (file: AppBackupFile) =>
    file.source === "own"
      ? t("control:containerBackup.sourceOwn")
      : file.source === "full"
        ? t("control:containerBackup.sourceFull")
        : t("control:containerBackup.sourceMinimal");

  const setupHref = appPageHref("appsSetup", app.id);

  return (
    <>
      <ControlSectionHead section="backup" title={selectedFile ? `${name} · ${formatManagedDate(selectedFile.createdAt)}` : name}
        back={{ href: fileKey ? queryPageHref(null, "file") : controlHref("backup"), label: t("control:backup.back") }} />
      <div className="grouped-page">

      {!app.configured && (
        <MessageBox tone="info" title={t("control:containerBackup.notSetUpTitle", { app: name })}>
          {app.problem ?? t("control:containerBackup.notSetUpBody")}{" "}
          <a href={setupHref} onClick={(event) => followRoute(event, setupHref)}>{t("control:containerBackup.setupLink")}</a>
        </MessageBox>
      )}
      {app.configured && app.restoreSupported === false && (
        <MessageBox tone="warning" title={t("control:containerBackup.tooOldTitle")}>
          {t("control:containerBackup.tooOldBody", { app: name })}
        </MessageBox>
      )}
      {app.configured && app.restoreSupported === null && (
        <MessageBox tone="warning" title={t("control:containerBackup.noAnswerTitle", { app: name })}>
          {t("control:containerBackup.noAnswerBody")}
        </MessageBox>
      )}
      {error && <MessageBox tone="error" title={t("control:backup.errorTitle")}>{error}</MessageBox>}
      {notice && <MessageBox tone="success" title={t("control:containerBackup.doneTitle")}>{notice}</MessageBox>}

      {fileKey ? selectedFile ? (
        <>
          <GroupedList>
            <InfoRow label={t("control:backup.fileName")} sub={selectedFile.name} />
            <InfoRow label={t("control:containerBackup.thFrom")} value={sourceLabel(selectedFile)} />
            <InfoRow label={t("control:containerBackup.thVersion")} value={selectedFile.version ?? "—"} />
            <InfoRow label={t("control:backup.thSize")} value={formatBytes(selectedFile.sizeBytes)} />
          </GroupedList>
          <GroupedList>
            <ActionRow label={t("control:backup.restore")} disabled={!canRestore} onClick={() => { clear(); setPendingRestore(selectedFile); }} />
            <ActionRow label={t("control:backup.download")} href={filePath(app.id, selectedFile.name) + "/download"} download />
          </GroupedList>
          {selectedFile.source === "own" && <GroupedList>
            <ActionRow tone="danger" label={t("control:backup.deleteConfirmLabel")} onClick={() => { clear(); setPendingDelete(selectedFile); }} />
          </GroupedList>}
        </>
      ) : <p className="muted">{t("control:backup.gone")}</p> : (
        <>
          <GroupedList note={t("control:containerBackup.intro")}>
            <CommandRow icon={<DatabaseBackup size={17} />} label={t("control:containerBackup.backUpNow")}
              value={backingUp ? t("control:backup.backingUp") : t("control:backup.createAction")}
              disabled={!app.configured || backingUp} onClick={() => void backUp()} />
            <ActionRow label={t("control:containerBackup.upload")} onClick={() => { clear(); setUploadOpen(true); }} />
          </GroupedList>
          <GroupedList>
            <ToggleRow checked={app.include} disabled={saving} label={t("control:containerBackup.includeLabel")}
              onChange={(next) => void saveSettings({ include: next })} />
            <InputRow label={t("control:containerBackup.keepLabel")} type="number" min={1} max={100}
              value={Number.isNaN(keep) ? "" : String(keep)} disabled={saving}
              onChange={(value) => setKeep(value === "" ? Number.NaN : Number(value))} onCommit={commitKeep} />
          </GroupedList>
          {app.undo && <GroupedList note={t("control:containerBackup.undoNote", { date: formatManagedDate(app.undo.takenAt) })}>
            <ActionRow label={t("control:containerBackup.undoOpen")} onClick={() => { clear(); setUndoOpen(true); }} />
          </GroupedList>}
          <GroupedList title={t("control:backup.listTitle")}>
            {app.files.length === 0 ? <InfoRow label={t("control:containerBackup.empty")} />
              : [...app.files].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((file) => (
                <NavRow key={fileKeyOf(file)} label={formatManagedDate(file.createdAt)} sub={sourceLabel(file)}
                  value={formatBytes(file.sizeBytes)} onClick={() => openFile(fileKeyOf(file))} />
              ))}
          </GroupedList>
        </>
      )}
      </div>

      {pendingRestore && (
        <ConfirmDialog
          title={t("control:containerBackup.restoreConfirmTitle", { app: name, date: formatManagedDate(pendingRestore.createdAt) })}
          confirmLabel={t("control:containerBackup.restoreConfirm", { app: name })}
          busyLabel={t("control:containerBackup.restoring")}
          confirmIcon={<RotateCcw size={15} />}
          danger
          rich
          busy={busy}
          error={error}
          onConfirm={() => void restore(pendingRestore)}
          onCancel={() => setPendingRestore(null)}
        >
          <p>{app.id === "games" ? t("control:containerBackup.restoreBodyGames") : app.id === "video" ? t("control:containerBackup.restoreBodyVideo") : t("control:containerBackup.restoreBodyOther")}</p>
          <p>{t("control:containerBackup.restoreKept")}</p>
        </ConfirmDialog>
      )}

      {undoOpen && (
        <ConfirmDialog
          title={t("control:containerBackup.undoConfirmTitle", { app: name })}
          confirmLabel={t("control:containerBackup.undoConfirm")}
          busyLabel={t("control:containerBackup.undoing")}
          confirmIcon={<Undo2 size={15} />}
          danger
          rich
          busy={busy}
          error={error}
          onConfirm={() => void undo()}
          onCancel={() => setUndoOpen(false)}
        >
          <p>{t("control:containerBackup.undoBody", { date: app.undo ? formatManagedDate(app.undo.takenAt) : "" })}</p>
        </ConfirmDialog>
      )}

      {pendingDelete && (
        <ConfirmDialog
          title={t("control:containerBackup.deleteConfirmTitle", { name: pendingDelete.name })}
          confirmLabel={t("control:backup.deleteConfirmLabel")}
          busyLabel={t("control:ui.deleting")}
          confirmIcon={<Trash2 size={15} />}
          danger
          busy={busy}
          error={error}
          onConfirm={() => void remove(pendingDelete)}
          onCancel={() => setPendingDelete(null)}
        >
          {t("control:containerBackup.deleteBody", { app: name, size: formatBytes(pendingDelete.sizeBytes) })}
        </ConfirmDialog>
      )}

      {uploadOpen && (
        <Modal
          variant="card"
          className="backup-upload-modal"
          title={t("control:containerBackup.uploadTitle", { app: name })}
          icon={<UploadCloud size={20} />}
          busy={uploadBusy}
          onClose={() => setUploadOpen(false)}
        >
          <p className="muted">{t("control:containerBackup.uploadBody")}</p>
          <FileUpload
            endpoint={`${apiPath(app.id)}/upload`}
            accept={["sqlite"]}
            maxBytes={512 * 1024 * 1024}
            hint={t("control:containerBackup.uploadHint")}
            onUploaded={(payload) => {
              const uploaded = (payload as { backup?: { name?: string } }).backup?.name;
              setUploadOpen(false);
              setNotice(t("control:containerBackup.uploaded", { name: uploaded ?? "" }));
              void reload();
            }}
            onBusyChange={setUploadBusy}
          />
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setUploadOpen(false)} disabled={uploadBusy}>
              {t("control:ui.close")}
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
