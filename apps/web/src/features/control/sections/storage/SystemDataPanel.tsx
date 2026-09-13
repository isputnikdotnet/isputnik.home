// The Storage page's System data block — docs/system-data-plan.md, phase 2.
//
// The one folder the app needs: chosen here (or in the setup guide) before the
// first library, with the folders that live in it listed below — the database
// (fixed at install), thumbnails and backups (each can have a folder of its own)
// and metadata. Every change goes chooser → confirmation naming the folder → save;
// whatever has to move follows as a task.
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../../../api";
import { Button } from "../../../../shared/Button";
import { ConfirmDialog } from "../../../../shared/ConfirmDialog";
import { Field } from "../../../../shared/Field";
import { InfoHint } from "../../../../shared/InfoHint";
import { MessageBox } from "../../../../shared/MessageBox";
import { Modal } from "../../../../shared/Modal";
import { formatBytes } from "../../../../shared/utils";
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
    stats: { files: number; bytes: number; complete: boolean };
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

  const typedSpace = useDiskSpace(view && !view.path ? (input.trim() || view.suggested) : "");
  const editorSpace = useDiskSpace(editor && (editor.target === "system" || editor.own) ? editor.path : "");

  const load = useCallback(async () => {
    const payload = await api<SystemDataView>("/api/storage/system-data");
    setView(payload);
  }, []);

  useEffect(() => {
    load().catch((err) => setError(err instanceof Error ? err.message : t("controlAdmin:systemData.loadFailed")));
  }, [load, refreshKey, t]);

  // While a folder is being moved, keep its row's count fresh.
  const moving = Boolean(view && (view.thumbnails.move.running || view.backups.move.running || view.metadata.move.running));
  useEffect(() => {
    if (!moving) return;
    const timer = setInterval(() => { load().catch(() => { /* next tick */ }); }, 2000);
    return () => clearInterval(timer);
  }, [moving, load]);

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
  const thumbnailCount = stats.files === 0 ? "" : stats.complete
    ? t("controlAdmin:systemData.files", { count: stats.files, size: formatBytes(stats.bytes) })
    : t("controlAdmin:systemData.filesAtLeast", { count: stats.files, size: formatBytes(stats.bytes) });
  const backupCount = view.backups.count === 0
    ? t("controlAdmin:systemData.backupsNone")
    : t("controlAdmin:systemData.backupsCount", { count: view.backups.count, size: formatBytes(view.backups.bytes) });
  const pendingCopy = pending ? confirmCopy(pending) : null;

  return (
    <section className="library-settings-panel storage-settings-panel system-data-panel">
      <div>
        <h2 className="system-data-title">
          <span>{t("controlAdmin:systemData.title")}</span>
          <span className="count-badge">{t("controlAdmin:systemData.required")}</span>
          <InfoHint label={t("controlAdmin:systemData.spaceInfoTitle")}>
            <strong>{t("controlAdmin:systemData.spaceInfoTitle")}</strong>
            <span>{t("controlAdmin:systemData.spaceInfoThumbnails")}</span>
            <span>{t("controlAdmin:systemData.spaceInfoBackups")}</span>
            <span>{t("controlAdmin:systemData.spaceInfoMetadata")}</span>
          </InfoHint>
        </h2>
        <p>{view.path ? t("controlAdmin:systemData.desc") : t("controlAdmin:systemData.descUnset")}</p>
      </div>

      {error && <MessageBox tone="error" title={t("controlAdmin:systemData.loadFailed")}>{error}</MessageBox>}

      {!view.path ? (
        <div className="system-data-choose">
          <Field
            label={t("controlAdmin:systemData.folderLabel")}
            value={input}
            onChange={setInput}
            placeholder={view.suggested}
            required={false}
          />
          <p className="datagrid-muted">{t("controlAdmin:systemData.suggestion", { path: view.suggested })}</p>
          <SpaceMeter space={typedSpace} />
          {isLowSpace(typedSpace) && (
            <MessageBox tone="warning" title={t("controlAdmin:systemData.lowTitle")}>{t("controlAdmin:systemData.lowBody")}</MessageBox>
          )}
          <MessageBox tone="warning" title={t("controlAdmin:systemData.noLibraryTitle")}>{t("controlAdmin:systemData.noLibraryBody")}</MessageBox>
          <div className="library-settings-actions">
            <Button variant="primary" onClick={() => { setSaveError(""); setPending({ target: "system", path: input.trim() || view.suggested }); }}>
              {t("controlAdmin:systemData.useFolder")}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="storage-path-summary system-data-summary">
            <strong>{view.path}</strong>
            <SpaceMeter space={view.space} />
          </div>
          {view.problem && <MessageBox tone="error" title={t("controlAdmin:systemData.problemTitle")}>{view.problem}</MessageBox>}
          {isLowSpace(view.space) && (
            <MessageBox tone="warning" title={t("controlAdmin:systemData.lowTitle")}>{t("controlAdmin:systemData.lowBody")}</MessageBox>
          )}
          <div className="library-settings-actions">
            <Button
              variant="secondary"
              compact
              disabled={view.moving}
              title={view.moving ? t("controlAdmin:systemData.movingTitle") : undefined}
              onClick={() => openEditor("system")}
            >
              {t("controlAdmin:systemData.change")}
            </Button>
          </div>

          <div className="datagrid-wrap system-data-rows">
            <table className="datagrid">
              <thead>
                <tr>
                  <th>{t("controlAdmin:systemData.thWhat")}</th>
                  <th>{t("controlAdmin:systemData.thWhere")}</th>
                  <th className="col-actions"></th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <strong>{t("controlAdmin:systemData.database")}</strong>
                    <div className="datagrid-muted app-storage-hint">{t("controlAdmin:systemData.databaseHint")}</div>
                  </td>
                  <td className="storage-path-cell">
                    <code className="app-storage-path">{view.database}</code>
                    <div className="datagrid-muted app-storage-from">{t("controlAdmin:systemData.databaseFixed")}</div>
                  </td>
                  <td className="col-actions"></td>
                </tr>
                <tr>
                  <td>
                    <strong>{t("controlAdmin:systemData.thumbnails")}</strong>
                    <div className="datagrid-muted app-storage-hint">{t("controlAdmin:systemData.thumbnailsHint")}</div>
                  </td>
                  <td className="storage-path-cell">
                    <code className="app-storage-path">{view.thumbnails.path ?? t("controlAdmin:systemData.thumbnailsNowhere")}</code>
                    <div className="datagrid-muted app-storage-from">
                      {[view.thumbnails.source ? thumbnailSource[view.thumbnails.source] : "", thumbnailCount].filter(Boolean).join(" · ")}
                    </div>
                    {view.thumbnails.problem && (
                      <div className="app-storage-move needs-attention"><span>{view.thumbnails.problem}</span></div>
                    )}
                    {moveLine(view.thumbnails.move, "thumbnails")}
                  </td>
                  <td className="col-actions">
                    <Button variant="secondary" compact disabled={view.thumbnails.move.running} onClick={() => openEditor("thumbnails")}>
                      {t("controlAdmin:systemData.change")}
                    </Button>
                  </td>
                </tr>
                <tr>
                  <td>
                    <strong>{t("controlAdmin:systemData.backups")}</strong>
                    <div className="datagrid-muted app-storage-hint">{t("controlAdmin:systemData.backupsHint")}</div>
                  </td>
                  <td className="storage-path-cell">
                    <code className="app-storage-path">{view.backups.path}</code>
                    <div className="datagrid-muted app-storage-from">
                      {[backupSource[view.backups.source], backupCount].join(" · ")}
                    </div>
                    {view.backups.sameDiskAsDatabase && (
                      <div className="system-data-note">{t("controlAdmin:systemData.sameDisk")}</div>
                    )}
                    {moveLine(view.backups.move, "backups")}
                  </td>
                  <td className="col-actions">
                    <Button variant="secondary" compact disabled={view.backups.move.running} onClick={() => openEditor("backups")}>
                      {t("controlAdmin:systemData.change")}
                    </Button>
                  </td>
                </tr>
                <tr>
                  <td>
                    <strong>{t("controlAdmin:systemData.metadata")}</strong>
                    <div className="datagrid-muted app-storage-hint">{t("controlAdmin:systemData.metadataHint")}</div>
                  </td>
                  <td className="storage-path-cell">
                    <code className="app-storage-path">{view.metadata.path ?? t("controlAdmin:systemData.metadataNowhere")}</code>
                    {view.metadata.source && (
                      <div className="datagrid-muted app-storage-from">
                        {view.metadata.source === "env" ? t("controlAdmin:systemData.sourceEnvMetadata") : t("controlAdmin:systemData.sourceSystem")}
                      </div>
                    )}
                    {moveLine(view.metadata.move, "metadata")}
                  </td>
                  <td className="col-actions"></td>
                </tr>
              </tbody>
            </table>
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
              <Field
                label={t("controlAdmin:systemData.folderLabel")}
                value={editor.path}
                onChange={(path) => setEditor({ ...editor, path })}
                required={false}
              />
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
