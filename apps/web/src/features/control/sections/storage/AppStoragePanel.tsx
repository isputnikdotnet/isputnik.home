// The Storage page's App storage block — docs/system-data-plan.md, phase 3.
//
// One switch for four parts that always go together: the Photo Inbox, App files,
// Renders and Map data. Off, the block asks where App storage will live (in system
// data, or a custom folder); on, it shows the folder with Change. Under it the four
// parts are listed, not switched: where each is, what it holds, and — for a part
// left outside App storage — Move in. Every change is confirmed with the exact folder
// first, and a Storage page and the setup guide show this same block.
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../../../api";
import { controlHref, followRoute } from "../../../../router";
import { Button } from "../../../../shared/Button";
import { ConfirmDialog } from "../../../../shared/ConfirmDialog";
import { Field } from "../../../../shared/Field";
import { InfoHint } from "../../../../shared/InfoHint";
import { MessageBox } from "../../../../shared/MessageBox";
import { Modal } from "../../../../shared/Modal";
import { ToggleSwitch } from "../../../../shared/ToggleSwitch";
import { isLowSpace, SpaceMeter, useDiskSpace, type DiskSpace } from "./SpaceMeter";
import { InboxReviewersModal } from "./InboxReviewersModal";
// The panel shares system data's stylesheet: the same block shape (docs/css-map.md).
import "../../../../styles/system-data.css";

type Part = "inbox" | "house" | "renders" | "maps";
type Where = "system" | "custom";

interface StorageMove {
  running: boolean;
  done: number;
  pending: number;
  failed: { name: string; title?: string; error: string }[];
}

interface PartView {
  part: Part;
  folder: string | null;
  inside: boolean;
  library: { id: string; name: string } | null;
  counts: { waiting?: number; files?: number; tracks?: number; reviewers?: number };
  move: StorageMove;
  renameTo: string | null;
}

export interface AppStorageView {
  enabled: boolean;
  where: Where;
  customPath: string | null;
  folder: string | null;
  systemFolder: string | null;
  systemDataSet: boolean;
  space: DiskSpace | null;
  parts: PartView[];
  moving: boolean;
  /** Why it would not switch off right now; null when it would. */
  offRefusal: string | null;
}

type Pending =
  | { kind: "on"; where: Where; path: string | null; folder: string }
  | { kind: "off" }
  | { kind: "change"; where: Where; path: string | null; folder: string }
  | { kind: "moveIn"; part: PartView }
  | { kind: "rename"; part: PartView };

const PARTS: Part[] = ["inbox", "house", "renders", "maps"];

export function AppStoragePanel({ refreshKey = 0, onChanged }: {
  /** Bumped by the page's Refresh button. */
  refreshKey?: number;
  /** Told after a change, so a page can re-read what depends on it. */
  onChanged?: (view: AppStorageView) => void;
}) {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const [view, setView] = useState<AppStorageView | null>(null);
  const [error, setError] = useState("");
  const [where, setWhere] = useState<Where>("system");
  const [customPath, setCustomPath] = useState("");
  const [changing, setChanging] = useState<{ where: Where; path: string } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [moveBusy, setMoveBusy] = useState(false);
  const [reviewersOpen, setReviewersOpen] = useState(false);

  const typedFolder = view && !view.enabled ? (where === "system" ? view.systemFolder ?? "" : customPath) : "";
  const typedSpace = useDiskSpace(typedFolder);
  const changeSpace = useDiskSpace(changing ? (changing.where === "system" ? view?.systemFolder ?? "" : changing.path) : "");

  const load = useCallback(async () => {
    const payload = await api<AppStorageView>("/api/storage/app-storage");
    setView(payload);
    return payload;
  }, []);

  useEffect(() => {
    load()
      .then((payload) => {
        setWhere(payload.where);
        setCustomPath(payload.customPath ?? "");
      })
      .catch((err) => setError(err instanceof Error ? err.message : t("controlAdmin:appStorage.loadFailed")));
  }, [load, refreshKey, t]);

  const anyMoving = Boolean(view?.parts.some((entry) => entry.move.running));
  useEffect(() => {
    if (!anyMoving) return;
    const timer = setInterval(() => { load().catch(() => { /* next tick */ }); }, 2000);
    return () => clearInterval(timer);
  }, [anyMoving, load]);

  if (!view) {
    return error ? <MessageBox tone="error" title={t("controlAdmin:appStorage.loadFailed")}>{error}</MessageBox> : null;
  }

  const partName: Record<Part, string> = {
    inbox: t("controlAdmin:storage.roomInbox"),
    house: t("controlAdmin:storage.roomHouse"),
    renders: t("controlAdmin:storage.roomRenders"),
    maps: t("controlAdmin:storage.roomMaps")
  };

  const run = async (action: () => Promise<AppStorageView>) => {
    setSaving(true);
    setSaveError("");
    try {
      const payload = await action();
      setPending(null);
      setChanging(null);
      // The page's reading carries offRefusal; a change's answer does not, so read again.
      const fresh = await load().catch(() => ({ ...payload, offRefusal: view.offRefusal }));
      onChanged?.(fresh);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t("controlAdmin:appStorage.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const confirm = () => {
    if (!pending) return;
    const post = (url: string, body?: object) => api<AppStorageView>(url, { method: "POST", body: JSON.stringify(body ?? {}) });
    switch (pending.kind) {
      case "on": return void run(() => post("/api/storage/app-storage/on", { where: pending.where, path: pending.path }));
      case "off": return void run(() => post("/api/storage/app-storage/off"));
      case "change": return void run(() => api<AppStorageView>("/api/storage/app-storage", { method: "PUT", body: JSON.stringify({ where: pending.where, path: pending.path }) }));
      case "moveIn": return void run(() => post(`/api/storage/app-storage/parts/${pending.part.part}/move-in`));
      case "rename": return void run(() => post("/api/storage/app-storage/parts/house/rename"));
    }
  };

  const moveAction = async (method: "POST" | "DELETE", part: Part) => {
    setMoveBusy(true);
    try {
      await api(`/api/storage/app-storage/parts/${part}/move`, { method });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:appStorage.loadFailed"));
    } finally {
      setMoveBusy(false);
    }
  };

  const askOn = () => {
    setSaveError("");
    const folder = where === "system" ? view.systemFolder : customPath.trim();
    if (!folder) {
      setError(t(where === "system" ? "controlAdmin:appStorage.needsSystemData" : "controlAdmin:appStorage.needsFolder"));
      return;
    }
    setError("");
    setPending({ kind: "on", where, path: where === "custom" ? customPath.trim() : null, folder });
  };

  const pendingCopy = (): { title: string; body: React.ReactNode; label: string; danger?: boolean; blocked?: string | null } | null => {
    if (!pending) return null;
    switch (pending.kind) {
      case "on":
        return { title: t("controlAdmin:appStorage.confirmOnTitle", { path: pending.folder }), body: t("controlAdmin:appStorage.confirmOnBody"), label: t("controlAdmin:appStorage.confirmOnLabel") };
      case "off":
        return {
          title: t("controlAdmin:appStorage.confirmOffTitle"),
          body: t("controlAdmin:appStorage.confirmOffBody"),
          label: t("controlAdmin:appStorage.confirmOffLabel"),
          danger: true,
          blocked: view.offRefusal
        };
      case "change":
        return { title: t("controlAdmin:appStorage.confirmChangeTitle", { path: pending.folder }), body: t("controlAdmin:appStorage.confirmChangeBody"), label: t("controlAdmin:appStorage.confirmChangeLabel") };
      case "moveIn":
        return pending.part.library || pending.part.part === "renders" || pending.part.part === "maps"
          ? { title: t("controlAdmin:appStorage.confirmMoveInTitle", { name: partName[pending.part.part], path: view.folder ?? "" }), body: t("controlAdmin:appStorage.confirmMoveInBody"), label: t("controlAdmin:appStorage.moveIn") }
          : { title: t("controlAdmin:appStorage.confirmMakeTitle", { name: partName[pending.part.part], path: view.folder ?? "" }), body: t("controlAdmin:appStorage.confirmMakeBody"), label: t("controlAdmin:appStorage.make") };
      case "rename":
        return {
          title: t("controlAdmin:storage.confirmRenameTitle", { name: pending.part.renameTo?.split(/[\\/]/).pop() ?? "" }),
          body: t("controlAdmin:storage.confirmRenameBody", { from: pending.part.folder ?? "", to: pending.part.renameTo ?? "", library: pending.part.library?.name ?? "" }),
          label: t("controlAdmin:storage.confirmRenameLabel")
        };
    }
  };

  const usingText = (entry: PartView): string => {
    if (!view.enabled) return "";
    if (entry.part === "inbox") {
      if (!entry.library) return "";
      const waiting = t("controlAdmin:storage.waiting", { count: entry.counts.waiting ?? 0 });
      const reviewers = entry.counts.reviewers
        ? t("controlAdmin:appStorage.reviewers.count", { count: entry.counts.reviewers })
        : t("controlAdmin:appStorage.reviewers.adminsOnly");
      return `${waiting} · ${reviewers}`;
    }
    if (entry.part === "house") return entry.library ? t("controlAdmin:appStorage.files", { count: entry.counts.files ?? 0 }) : "";
    if (entry.part === "renders" && (entry.counts.tracks ?? 0) > 0) return t("controlAdmin:storage.tracks", { count: entry.counts.tracks ?? 0 });
    return "";
  };

  const link = (href: string, label: string) => (
    <a href={href} onClick={(event) => followRoute(event, href)}>{label}</a>
  );

  const copy = pendingCopy();

  return (
    <section className="system-data-panel app-storage-block">
      <div className="app-storage-head">
        <div>
          <h2 className="system-data-title">
            <span>{t("controlAdmin:appStorage.title")}</span>
            <span className="count-badge">{view.enabled ? t("controlAdmin:appStorage.on") : t("controlAdmin:appStorage.optional")}</span>
            <InfoHint label={t("controlAdmin:appStorage.infoLabel")}>
              <strong>{t("controlAdmin:appStorage.infoWhatTitle")}</strong>
              <span>{t("controlAdmin:appStorage.infoWhat")}</span>
              <strong>{t("controlAdmin:appStorage.infoGrowthTitle")}</strong>
              <span>{t("controlAdmin:appStorage.infoGrowth")}</span>
            </InfoHint>
          </h2>
          <p>{t("controlAdmin:appStorage.desc")}</p>
        </div>
        <ToggleSwitch
          checked={view.enabled}
          ariaLabel={t("controlAdmin:appStorage.switchAria")}
          disabled={saving || view.moving || (!view.enabled && !view.systemDataSet)}
          onChange={(on) => {
            setSaveError("");
            if (on) askOn();
            else setPending({ kind: "off" });
          }}
        />
      </div>

      {error && <MessageBox tone="error" title={t("controlAdmin:appStorage.saveFailed")}>{error}</MessageBox>}
      {!view.systemDataSet && !view.enabled && (
        <MessageBox tone="info" title={t("controlAdmin:appStorage.needsSystemDataTitle")}>{t("controlAdmin:appStorage.needsSystemData")}</MessageBox>
      )}

      {!view.enabled ? (
        <div className="system-data-choose app-storage-where">
          <span className="app-storage-question">{t("controlAdmin:appStorage.whereQuestion")}</span>
          <label className="app-storage-option">
            <input type="radio" name="app-storage-where" checked={where === "system"} disabled={!view.systemDataSet} onChange={() => setWhere("system")} />
            <span>
              <strong>{t("controlAdmin:appStorage.whereSystem")}</strong>
              <small className="datagrid-muted">{view.systemFolder ? t("controlAdmin:appStorage.whereSystemHint", { path: view.systemFolder }) : t("controlAdmin:appStorage.needsSystemData")}</small>
            </span>
          </label>
          <label className="app-storage-option">
            <input type="radio" name="app-storage-where" checked={where === "custom"} onChange={() => setWhere("custom")} />
            <span>
              <strong>{t("controlAdmin:appStorage.whereCustom")}</strong>
              <small className="datagrid-muted">{t("controlAdmin:appStorage.whereCustomHint")}</small>
            </span>
          </label>
          {where === "custom" && (
            <Field label={t("controlAdmin:appStorage.folderLabel")} value={customPath} onChange={setCustomPath} required={false} />
          )}
          <SpaceMeter space={typedSpace} />
          {isLowSpace(typedSpace) && (
            <MessageBox tone="warning" title={t("controlAdmin:appStorage.lowTitle")}>{t("controlAdmin:appStorage.lowBody")}</MessageBox>
          )}
        </div>
      ) : (
        <>
          <div className="system-data-summary">
            <strong>{view.folder}</strong>
            {view.where === "system" && <span className="datagrid-muted">{t("controlAdmin:appStorage.sharesDisk")}</span>}
            <SpaceMeter space={view.space} />
          </div>
          {isLowSpace(view.space) && (
            <MessageBox tone="warning" title={t("controlAdmin:appStorage.lowTitle")}>{t("controlAdmin:appStorage.lowBodyOn")}</MessageBox>
          )}
          <div className="library-settings-actions">
            <Button
              variant="secondary"
              compact
              disabled={view.moving}
              title={view.moving ? t("controlAdmin:appStorage.movingTitle") : undefined}
              onClick={() => { setSaveError(""); setChanging({ where: view.where, path: view.customPath ?? "" }); }}
            >
              {t("controlAdmin:appStorage.change")}
            </Button>
          </div>
        </>
      )}

      <div className="datagrid-wrap system-data-rows">
        <table className="datagrid">
          <thead>
            <tr>
              <th>{t("controlAdmin:appStorage.thPart")}</th>
              <th>{t("controlAdmin:appStorage.thFolder")}</th>
              <th>{t("controlAdmin:appStorage.thUsing")}</th>
            </tr>
          </thead>
          <tbody>
            {PARTS.map((name) => view.parts.find((entry) => entry.part === name)).filter((entry): entry is PartView => Boolean(entry)).map((entry) => {
              const outside = view.enabled && !entry.inside;
              const using = usingText(entry);
              return (
                <tr key={entry.part} className={view.enabled ? undefined : "is-off"}>
                  <td>
                    <span className="app-storage-part-name">
                      <strong>{partName[entry.part]}</strong>
                      <InfoHint label={t("controlAdmin:appStorage.aboutPart", { name: partName[entry.part] })}>
                        <strong>{partName[entry.part]}</strong>
                        <span>{t(`controlAdmin:appStorage.about.${entry.part}`)}</span>
                        <span><strong>{t("controlAdmin:appStorage.spaceLabel")}</strong> {t(`controlAdmin:appStorage.space.${entry.part}`)}</span>
                        <span><strong>{t("controlAdmin:appStorage.offLabel")}</strong> {t(`controlAdmin:appStorage.off.${entry.part}`)}</span>
                      </InfoHint>
                    </span>
                    <div className="datagrid-muted app-storage-hint">{t(`controlAdmin:appStorage.hint.${entry.part}`)}</div>
                  </td>
                  <td className="storage-path-cell">
                    {entry.folder
                      ? <code className="app-storage-path">{entry.folder}</code>
                      : <span className="datagrid-muted">{t("controlAdmin:appStorage.insideWhenOn")}</span>}
                    {outside && <div className="system-data-note">{entry.library || entry.part === "renders" || entry.part === "maps" ? t("controlAdmin:appStorage.outside") : t("controlAdmin:appStorage.missing")}</div>}
                    {entry.move.running && (
                      <div className="app-storage-move">
                        <span>{t("controlAdmin:appStorage.moving", { moved: entry.move.done, total: entry.move.done + entry.move.pending })}</span>
                        <Button variant="text" compact disabled={moveBusy} onClick={() => void moveAction("DELETE", entry.part)}>
                          {t("controlAdmin:storage.moveCancel")}
                        </Button>
                      </div>
                    )}
                    {!entry.move.running && entry.move.failed.length > 0 && (
                      <div className="app-storage-move needs-attention">
                        <span title={entry.move.failed.map((f) => `${f.title ?? f.name}: ${f.error}`).join("\n")}>
                          {t("controlAdmin:appStorage.moveFailed", { count: entry.move.failed.length })}
                        </span>
                        <Button variant="text" compact disabled={moveBusy} onClick={() => void moveAction("POST", entry.part)}>
                          {t("controlAdmin:storage.moveRetry")}
                        </Button>
                      </div>
                    )}
                  </td>
                  <td>
                    <div className="app-storage-using">
                      {using && <span>{using}</span>}
                      {view.enabled && (
                        <span className="app-storage-links">
                          {outside && !entry.move.running && (
                            <Button variant="secondary" compact disabled={view.moving} onClick={() => { setSaveError(""); setPending({ kind: "moveIn", part: entry }); }}>
                              {entry.library || entry.part === "renders" || entry.part === "maps" ? t("controlAdmin:appStorage.moveIn") : t("controlAdmin:appStorage.make")}
                            </Button>
                          )}
                          {entry.renameTo && !entry.move.running && (
                            <Button variant="text" compact title={t("controlAdmin:storage.renameFolderTitle", { name: entry.renameTo.split(/[\\/]/).pop() ?? "" })} onClick={() => { setSaveError(""); setPending({ kind: "rename", part: entry }); }}>
                              {t("controlAdmin:storage.renameFolder")}
                            </Button>
                          )}
                          {entry.part === "house" && entry.library && link(controlHref("storageContents"), t("controlAdmin:appStorage.contents"))}
                          {/* The Inbox has reviewers instead of library access (phase 4). */}
                          {entry.part === "inbox" && entry.library && (
                            <Button variant="text" compact onClick={() => setReviewersOpen(true)}>{t("controlAdmin:appStorage.reviewers.button")}</Button>
                          )}
                          {entry.part === "house" && entry.library && link(`${controlHref("libraries")}?edit=${encodeURIComponent(entry.library.id)}`, t("controlAdmin:appStorage.access"))}
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {changing && (
        <Modal
          title={t("controlAdmin:appStorage.changeTitle")}
          className="system-data-chooser"
          onClose={() => setChanging(null)}
          onSubmit={(event) => {
            event.preventDefault();
            const folder = changing.where === "system" ? view.systemFolder : changing.path.trim();
            if (!folder) return;
            setPending({ kind: "change", where: changing.where, path: changing.where === "custom" ? changing.path.trim() : null, folder });
            setChanging(null);
          }}
        >
          <p>{t("controlAdmin:appStorage.changeIntro", { path: view.folder ?? "" })}</p>
          <div className="app-storage-options">
            <label className="app-storage-option">
              <input type="radio" name="app-storage-change" checked={changing.where === "system"} disabled={!view.systemDataSet} onChange={() => setChanging({ ...changing, where: "system" })} />
              <span>
                <strong>{t("controlAdmin:appStorage.whereSystem")}</strong>
                <small className="datagrid-muted">{view.systemFolder ?? t("controlAdmin:appStorage.needsSystemData")}</small>
              </span>
            </label>
            <label className="app-storage-option">
              <input type="radio" name="app-storage-change" checked={changing.where === "custom"} onChange={() => setChanging({ ...changing, where: "custom" })} />
              <span>
                <strong>{t("controlAdmin:appStorage.whereCustom")}</strong>
                <small className="datagrid-muted">{t("controlAdmin:appStorage.whereCustomHint")}</small>
              </span>
            </label>
          </div>
          {changing.where === "custom" && (
            <Field label={t("controlAdmin:appStorage.folderLabel")} value={changing.path} onChange={(path) => setChanging({ ...changing, path })} required={false} />
          )}
          <SpaceMeter space={changeSpace} />
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setChanging(null)} autoFocus>{t("common.cancel")}</Button>
            <Button
              variant="primary"
              type="submit"
              disabled={changing.where === "custom" ? !changing.path.trim() : !view.systemFolder || view.where === "system"}
            >
              {t("controlAdmin:appStorage.continue")}
            </Button>
          </div>
        </Modal>
      )}

      {reviewersOpen && (
        <InboxReviewersModal onClose={() => setReviewersOpen(false)} onChanged={() => void load().catch(() => undefined)} />
      )}

      {pending && copy && (
        <ConfirmDialog
          title={copy.title}
          confirmLabel={copy.label}
          busyLabel={t("controlAdmin:ui.saving")}
          busy={saving}
          danger={copy.danger}
          rich={Boolean(copy.blocked)}
          confirmDisabled={Boolean(copy.blocked)}
          error={saveError || undefined}
          onConfirm={confirm}
          onCancel={() => { setPending(null); setSaveError(""); }}
        >
          {copy.blocked ? (
            <MessageBox tone="error" title={t("controlAdmin:appStorage.offRefusedTitle")}>{copy.blocked}</MessageBox>
          ) : copy.body}
        </ConfirmDialog>
      )}
    </section>
  );
}
