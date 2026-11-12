// The Storage page's System data block — docs/system-data-plan.md, phase 2.
//
// The one folder the app needs: chosen here (or in the setup guide) before the
// first library, with the folders that live in it listed below — the database
// (fixed at install), thumbnails and backups (each can have a folder of its own)
// and metadata. Every change goes chooser → confirmation naming the folder → save;
// whatever has to move follows as a task. Drawn as grouped rows (control panel v2):
// the folder (tap to change), then what lives in it, one row each.
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Archive, Database, FileText, HardDrive, Images } from "lucide-react";
import { api } from "../../../../api";
import { Button } from "../../../../shared/Button";
import { ConfirmDialog } from "../../../../shared/ConfirmDialog";
import { Field } from "../../../../shared/Field";
import { ActionRow, FieldRow, InfoRow, NavRow } from "../../../../shared/GroupedList";
import { InfoHint } from "../../../../shared/InfoHint";
import { MessageBox } from "../../../../shared/MessageBox";
import { Modal } from "../../../../shared/Modal";
import { formatBytes } from "../../../../shared/utils";
import { ServerFolderPicker } from "./ServerFolderPicker";
import { isLowSpace, SpaceMeter, useDiskSpace, type DiskSpace } from "./SpaceMeter";
// The panel's stylesheet: it arrives with the panel, on the Storage page and in the setup guide (docs/css-map.md).
import "../../../../styles/system-data.css";

interface StorageMove {
  running: boolean;
  done: number;
  pending: number;
  failed: { name: string; error: string }[];
}

export interface SystemDataView {
  path: string | null;
  suggested: string;
  problem: string;
  database: string;
  space: DiskSpace | null;
  thumbnails: {
    path: string | null;
    source: "setting" | "env" | "system" | null;
    problem: string;
    /** null while the server counts the folder for the first time. */
    stats: { files: number; bytes: number; complete: boolean } | null;
    move: StorageMove;
  };
  backups: {
    path: string;
    source: "setting" | "env" | "system" | "default";
    count: number;
    bytes: number;
    sameDiskAsDatabase: boolean;
    move: StorageMove;
  };
  metadata: { path: string | null; source: "env" | "system" | null; move: StorageMove };
  moving: boolean;
}

type Target = "system" | "thumbnails" | "backups";
type MoveRoom = "thumbnails" | "backups" | "metadata";

/** What an admin has picked and not yet confirmed. `path` null = back to system data. */
interface Pending {
  target: Target;
  path: string | null;
}

export function SystemDataPanel({ refreshKey = 0, onChanged }: {
  /** Bumped by the page's Refresh button. */
  refreshKey?: number;
  /** Told after a change, so the page can re-read what depends on it. */
  onChanged?: (view: SystemDataView) => void;
}) {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const [view, setView] = useState<SystemDataView | null>(null);
  const [error, setError] = useState("");
  const [input, setInput] = useState("");
  const [editor, setEditor] = useState<{ target: Target; own: boolean; path: string } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [moveBusy, setMoveBusy] = useState(false);
  const [browsing, setBrowsing] = useState<{ start: string; onPick: (path: string) => void } | null>(null);

  const typedSpace = useDiskSpace(view && !view.path ? (input.trim() || view.suggested) : "");
  const editorSpace = useDiskSpace(editor && (editor.target === "system" || editor.own) ? editor.path : "");

  const load = useCallback(async () => {
    const payload = await api<SystemDataView>("/api/storage/system-data");
    setView(payload);
  }, []);

  useEffect(() => {
    load().catch((err) => setError(err instanceof Error ? err.message : t("controlAdmin:systemData.loadFailed")));
  }, [load, refreshKey, t]);

  // While a folder is being moved, keep its row's count fresh; while the server is
  // still counting the thumbnails (it counts in the background, never while you wait),
  // ask again until the numbers are there.
  const moving = Boolean(view && (view.thumbnails.move.running || view.backups.move.running || view.metadata.move.running));
  const counting = Boolean(view && view.thumbnails.path && view.thumbnails.stats === null);
  useEffect(() => {
    if (!moving && !counting) return;
    const timer = setInterval(() => { load().catch(() => { /* next tick */ }); }, moving ? 2000 : 3000);
    return () => clearInterval(timer);
  }, [moving, counting, load]);

  if (!view) {
    return error ? <MessageBox tone="error" title={t("controlAdmin:systemData.loadFailed")}>{error}</MessageBox> : null;
  }

  const save = async () => {
    if (!pending) return;
    setSaving(true);
    setSaveError("");
    try {
      const url = pending.target === "system" ? "/api/storage/system-data" : `/api/storage/system-data/${pending.target}`;
      const payload = await api<SystemDataView>(url, { method: "PUT", body: JSON.stringify({ path: pending.path }) });
      setView(payload);
      setPending(null);
      setInput("");
      onChanged?.(payload);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t("controlAdmin:systemData.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const moveAction = async (method: "POST" | "DELETE", room: MoveRoom) => {
    setMoveBusy(true);
    try {
      setView(await api<SystemDataView>(`/api/storage/system-data/moves/${room}`, { method }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:systemData.loadFailed"));
    } finally {
      setMoveBusy(false);
    }
  };

  const openEditor = (target: Target) => {
    setSaveError("");
    if (target === "system") setEditor({ target, own: true, path: "" });
    else if (target === "thumbnails") setEditor({ target, own: view.thumbnails.source === "setting", path: view.thumbnails.source === "setting" ? view.thumbnails.path ?? "" : "" });
    else setEditor({ target, own: view.backups.source === "setting", path: view.backups.source === "setting" ? view.backups.path : "" });
  };

  const continueFromEditor = () => {
    if (!editor) return;
    const path = editor.target === "system" || editor.own ? editor.path.trim() : null;
    if ((editor.target === "system" || editor.own) && !path) return;
    setEditor(null);
    setPending({ target: editor.target, path });
  };

  const confirmCopy = (item: Pending): { title: string; body: string; label: string } => {
    switch (item.target) {
      case "system":
        return view.path
          ? { title: t("controlAdmin:systemData.confirmMoveTitle", { path: item.path }), body: t("controlAdmin:systemData.confirmMoveBody"), label: t("controlAdmin:systemData.confirmMoveLabel") }
          : { title: t("controlAdmin:systemData.confirmSetTitle", { path: item.path }), body: t("controlAdmin:systemData.confirmSetBody"), label: t("controlAdmin:systemData.useFolder") };
      case "thumbnails":
        return {
          title: item.path ? t("controlAdmin:systemData.confirmThumbsOwnTitle", { path: item.path }) : t("controlAdmin:systemData.confirmThumbsSystemTitle"),
          body: t("controlAdmin:systemData.confirmThumbsBody"),
          label: t("controlAdmin:systemData.confirmThumbsLabel")
        };
      case "backups":
        return {
          title: item.path ? t("controlAdmin:systemData.confirmBackupsOwnTitle", { path: item.path }) : t("controlAdmin:systemData.confirmBackupsSystemTitle"),
          body: t("controlAdmin:systemData.confirmBackupsBody"),
          label: t("controlAdmin:systemData.confirmBackupsLabel")
        };
    }
  };

  const moveLine = (move: StorageMove, room: MoveRoom) => (
    <>
      {move.running && (
        <div className="app-storage-move">
          <span>{t("controlAdmin:systemData.moving", { moved: move.done, total: move.done + move.pending })}</span>
          <Button variant="text" compact disabled={moveBusy} onClick={() => void moveAction("DELETE", room)}>
            {t("controlAdmin:storage.moveCancel")}
          </Button>
        </div>
      )}
      {!move.running && move.failed.length > 0 && (
        <div className="app-storage-move needs-attention">
          <span title={move.failed.map((f) => `${f.name}: ${f.error}`).join("\n")}>
            {t("controlAdmin:systemData.moveFailed", { count: move.failed.length })}
          </span>
          <Button variant="text" compact disabled={moveBusy} onClick={() => void moveAction("POST", room)}>
            {t("controlAdmin:storage.moveRetry")}
          </Button>
        </div>
      )}
    </>
  );

  const thumbnailSource = {
    setting: t("controlAdmin:systemData.sourceSetting"),
    env: t("controlAdmin:systemData.sourceEnvThumbnails"),
    system: t("controlAdmin:systemData.sourceSystem")
  };
  const backupSource = {
    setting: t("controlAdmin:systemData.sourceSetting"),
    env: t("controlAdmin:systemData.sourceEnvBackups"),
    system: t("controlAdmin:systemData.sourceSystem"),
    default: t("controlAdmin:systemData.sourceDefaultBackups")
  };
  const stats = view.thumbnails.stats;
  const thumbnailCount = !stats ? (view.thumbnails.path ? t("controlAdmin:systemData.counting") : "") : stats.files === 0 ? "" : stats.complete
    ? t("controlAdmin:systemData.files", { count: stats.files, size: formatBytes(stats.bytes) })
    : t("controlAdmin:systemData.filesAtLeast", { count: stats.files, size: formatBytes(stats.bytes) });
  const backupCount = view.backups.count === 0
    ? t("controlAdmin:systemData.backupsNone")
    : t("controlAdmin:systemData.backupsCount", { count: view.backups.count, size: formatBytes(view.backups.bytes) });
  const pendingCopy = pending ? confirmCopy(pending) : null;

  const folderField = (value: string, onChange: (path: string) => void, placeholder?: string) => (
    <div className="system-data-folder">
      <Field label={t("controlAdmin:systemData.folderLabel")} value={value} onChange={onChange} placeholder={placeholder} required={false} />
      <Button variant="secondary" onClick={() => setBrowsing({ start: value, onPick: onChange })}>
        {t("controlAdmin:systemData.browse")}
      </Button>
    </div>
  );

  // A move's progress or failure, as a row under the part it belongs to.
  const moveRow = (move: StorageMove, room: MoveRoom) => (move.running || move.failed.length > 0) && (
    <FieldRow>{moveLine(move, room)}</FieldRow>
  );
  const pathSub = (hint: string, path: string, meta?: string) => (
    <>
      {hint}
      <span className="storage-row-path"><code>{path}</code>{meta && <> · {meta}</>}</span>
    </>
  );

  return (
    <section id="system-data" className="storage-rows">
      <h3 className="grouped-list-title storage-rows-title">
        <span>{t("controlAdmin:systemData.title")}</span>
        <span className="count-badge">{t("controlAdmin:systemData.required")}</span>
        <InfoHint label={t("controlAdmin:systemData.spaceInfoTitle")}>
          <strong>{t("controlAdmin:systemData.spaceInfoTitle")}</strong>
          <span>{t("controlAdmin:systemData.spaceInfoThumbnails")}</span>
          <span>{t("controlAdmin:systemData.spaceInfoBackups")}</span>
          <span>{t("controlAdmin:systemData.spaceInfoMetadata")}</span>
        </InfoHint>
      </h3>

      {error && <MessageBox tone="error" title={t("controlAdmin:systemData.loadFailed")}>{error}</MessageBox>}

      {!view.path ? (
        <>
          <div className="grouped-list-rows">
            <FieldRow>
              <div className="system-data-choose">
                {folderField(input, setInput, view.suggested)}
                <p className="datagrid-muted">{t("controlAdmin:systemData.suggestion", { path: view.suggested })}</p>
                <SpaceMeter space={typedSpace} />
              </div>
            </FieldRow>
            <ActionRow
              label={t("controlAdmin:systemData.useFolder")}
              onClick={() => { setSaveError(""); setPending({ target: "system", path: input.trim() || view.suggested }); }}
            />
          </div>
          <p className="grouped-list-note">{t("controlAdmin:systemData.descUnset")}</p>
          {isLowSpace(typedSpace) && (
            <MessageBox tone="warning" title={t("controlAdmin:systemData.lowTitle")}>{t("controlAdmin:systemData.lowBody")}</MessageBox>
          )}
          <MessageBox tone="warning" title={t("controlAdmin:systemData.noLibraryTitle")}>{t("controlAdmin:systemData.noLibraryBody")}</MessageBox>
        </>
      ) : (
        <>
          {/* The folder itself: tapping it is Change. */}
          <div className="grouped-list-rows">
            <NavRow
              icon={<HardDrive size={17} />}
              iconTone={view.problem ? "danger" : isLowSpace(view.space) ? "warn" : "ok"}
              label={<code className="storage-row-folder">{view.path}</code>}
              sub={<SpaceMeter space={view.space} />}
              value={t("controlAdmin:systemData.change")}
              disabled={view.moving}
              onClick={() => openEditor("system")}
            />
          </div>
          <p className="grouped-list-note">{view.moving ? t("controlAdmin:systemData.movingTitle") : t("controlAdmin:systemData.desc")}</p>
          {view.problem && <MessageBox tone="error" title={t("controlAdmin:systemData.problemTitle")}>{view.problem}</MessageBox>}
          {isLowSpace(view.space) && (
            <MessageBox tone="warning" title={t("controlAdmin:systemData.lowTitle")}>{t("controlAdmin:systemData.lowBody")}</MessageBox>
          )}

          {/* What lives in it: the database (fixed), thumbnails and backups (each can
              have a folder of its own — tap to change), and metadata. */}
          <div className="grouped-list-rows">
            <InfoRow
              icon={<Database size={17} />}
              iconTone="muted"
              label={t("controlAdmin:systemData.database")}
              sub={pathSub(t("controlAdmin:systemData.databaseHint"), view.database, t("controlAdmin:systemData.databaseFixed"))}
            />
            <NavRow
              icon={<Images size={17} />}
              iconTone={view.thumbnails.problem ? "danger" : undefined}
              label={t("controlAdmin:systemData.thumbnails")}
              sub={pathSub(
                t("controlAdmin:systemData.thumbnailsHint"),
                view.thumbnails.path ?? t("controlAdmin:systemData.thumbnailsNowhere"),
                [view.thumbnails.source ? thumbnailSource[view.thumbnails.source] : "", thumbnailCount].filter(Boolean).join(" · ")
              )}
              disabled={view.thumbnails.move.running}
              onClick={() => openEditor("thumbnails")}
            />
            {view.thumbnails.problem && (
              <FieldRow><div className="app-storage-move needs-attention"><span>{view.thumbnails.problem}</span></div></FieldRow>
            )}
            {moveRow(view.thumbnails.move, "thumbnails")}
            <NavRow
              icon={<Archive size={17} />}
              iconTone={view.backups.sameDiskAsDatabase ? "warn" : undefined}
              label={t("controlAdmin:systemData.backups")}
              sub={pathSub(t("controlAdmin:systemData.backupsHint"), view.backups.path, [backupSource[view.backups.source], backupCount].join(" · "))}
              disabled={view.backups.move.running}
              onClick={() => openEditor("backups")}
            />
            {view.backups.sameDiskAsDatabase && (
              <FieldRow><div className="system-data-note">{t("controlAdmin:systemData.sameDisk")}</div></FieldRow>
            )}
            {moveRow(view.backups.move, "backups")}
            <InfoRow
              icon={<FileText size={17} />}
              iconTone="muted"
              label={t("controlAdmin:systemData.metadata")}
              sub={pathSub(
                t("controlAdmin:systemData.metadataHint"),
                view.metadata.path ?? t("controlAdmin:systemData.metadataNowhere"),
                view.metadata.source ? (view.metadata.source === "env" ? t("controlAdmin:systemData.sourceEnvMetadata") : t("controlAdmin:systemData.sourceSystem")) : undefined
              )}
            />
            {moveRow(view.metadata.move, "metadata")}
          </div>
        </>
      )}

      {editor && (
        <Modal
          title={t(editor.target === "system"
            ? "controlAdmin:systemData.editTitleSystem"
            : editor.target === "thumbnails" ? "controlAdmin:systemData.editTitleThumbnails" : "controlAdmin:systemData.editTitleBackups")}
          className="system-data-chooser"
          onClose={() => setEditor(null)}
          onSubmit={(event) => { event.preventDefault(); continueFromEditor(); }}
        >
          {editor.target === "system" ? (
            <p>{t("controlAdmin:systemData.editIntroSystem", { path: view.path })}</p>
          ) : (
            <div className="app-storage-options">
              <label className="app-storage-option">
                <input type="radio" name="system-data-where" checked={!editor.own} onChange={() => setEditor({ ...editor, own: false })} />
                <span>
                  <strong>{t("controlAdmin:systemData.optionSystem")}</strong>
                  <small className="datagrid-muted">{view.path}</small>
                </span>
              </label>
              <label className="app-storage-option">
                <input type="radio" name="system-data-where" checked={editor.own} onChange={() => setEditor({ ...editor, own: true })} />
                <span>
                  <strong>{t("controlAdmin:systemData.optionOwn")}</strong>
                  <small className="datagrid-muted">{t(editor.target === "thumbnails" ? "controlAdmin:systemData.optionOwnThumbnailsHint" : "controlAdmin:systemData.optionOwnBackupsHint")}</small>
                </span>
              </label>
            </div>
          )}
          {(editor.target === "system" || editor.own) && (
            <>
              {folderField(editor.path, (path) => setEditor({ ...editor, path }))}
              <SpaceMeter space={editorSpace} />
              {isLowSpace(editorSpace) && (
                <MessageBox tone="warning" title={t("controlAdmin:systemData.lowTitle")}>{t("controlAdmin:systemData.lowBody")}</MessageBox>
              )}
            </>
          )}
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setEditor(null)} autoFocus>
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              type="submit"
              disabled={(editor.target === "system" || editor.own) ? !editor.path.trim() : (editor.target === "thumbnails" ? view.thumbnails.source !== "setting" : view.backups.source !== "setting")}
            >
              {t("controlAdmin:systemData.continue")}
            </Button>
          </div>
        </Modal>
      )}

      {browsing && (
        <ServerFolderPicker
          start={browsing.start}
          onPick={(path) => { browsing.onPick(path); setBrowsing(null); }}
          onClose={() => setBrowsing(null)}
        />
      )}

      {pending && pendingCopy && (
        <ConfirmDialog
          title={pendingCopy.title}
          confirmLabel={pendingCopy.label}
          busyLabel={t("controlAdmin:ui.saving")}
          busy={saving}
          error={saveError || undefined}
          onConfirm={() => void save()}
          onCancel={() => { setPending(null); setSaveError(""); }}
        >
          {pendingCopy.body}
        </ConfirmDialog>
      )}
    </section>
  );
}
